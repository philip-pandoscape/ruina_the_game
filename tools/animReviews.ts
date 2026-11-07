import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, relative, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

// The dev server's half of the animation library (/dev/library.html, src/dev/library/store.ts): the notes
// on animations, the pictures of pose corrections and the prompts made from them are kept in
// reviews/animations/ (git-ignored), where Claude can read them and where they outlive a reload.
//
//   GET  /__anim-review/review          -> {dir, url, review}   the notes, where they are kept and served
//   PUT  /__anim-review/review          the notes, as JSON
//   PUT  /__anim-review/images/<name>   a picture's bytes (PNG)
//   POST /__anim-review/prompt          a prompt's text  -> {path}
//
// Only the library itself can write: a request has to come from this machine, from the same origin,
// and carry the x-anim-review header. Tests (x-anim-review: test) write to test-results/anim-reviews/.

const IMAGE = /^[a-z0-9][a-z0-9_-]{0,80}\.png$/;
const MAX_JSON = 32 * 1024 * 1024;
const MAX_IMAGE = 32 * 1024 * 1024;

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function local(req: IncomingMessage): boolean {
  const ip = req.socket.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:127.');
}

function trusted(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  const h = req.headers['x-anim-review'];
  return local(req) && (site === undefined || site === 'same-origin') && (h === '1' || h === 'test');
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new Error('request too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Streams a body to a file through a .part file, so a cut-off upload never looks whole. */
async function writeBody(req: IncomingMessage, dest: string, limit: number): Promise<number> {
  const part = `${dest}.part`;
  const out = createWriteStream(part);
  let n = 0;
  try {
    for await (const c of req) {
      n += (c as Buffer).length;
      if (n > limit) throw new Error('file too large');
      if (!out.write(c)) await new Promise<void>((r) => out.once('drain', () => r()));
    }
    await new Promise<void>((ok, fail) => out.end((e?: Error | null) => (e ? fail(e) : ok())));
    renameSync(part, dest);
    return n;
  } catch (e) {
    out.destroy();
    rmSync(part, { force: true });
    throw e;
  }
}

/** Writes through a temporary file, so a reader never sees half of it. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export function animReviews(): Plugin {
  return {
    name: 'ruina:anim-reviews',
    apply: 'serve',
    configureServer(server) {
      const root = server.config.root;
      const homes = { real: join(root, 'reviews', 'animations'), test: join(root, 'test-results', 'anim-reviews') };

      async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://localhost');
        let parts: string[];
        try {
          parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        } catch {
          return send(res, 400, { error: 'bad path' });
        }
        if (!trusted(req)) return send(res, 403, { error: 'only the animation library, on this machine, may use this' });
        const dir = req.headers['x-anim-review'] === 'test' ? homes.test : homes.real;
        mkdirSync(join(dir, 'images'), { recursive: true });
        const reviewFile = join(dir, 'review.json');

        if (parts.length === 1 && parts[0] === 'review') {
          if (req.method === 'GET') {
            const review = existsSync(reviewFile) ? (JSON.parse(readFileSync(reviewFile, 'utf8')) as unknown) : null;
            return send(res, 200, { dir, url: '/' + relative(root, dir).split(sep).join('/'), review });
          }
          if (req.method === 'PUT') {
            const text = await readBody(req, MAX_JSON);
            JSON.parse(text); // only JSON is kept
            writeAtomic(reviewFile, text);
            return send(res, 200, { ok: true });
          }
        }

        if (req.method === 'PUT' && parts.length === 2 && parts[0] === 'images') {
          const name = parts[1];
          const dest = resolve(dir, 'images', name);
          if (!IMAGE.test(name) || !dest.startsWith(join(dir, 'images') + sep)) return send(res, 400, { error: 'bad image name' });
          const bytes = await writeBody(req, dest, MAX_IMAGE);
          return send(res, 200, { ok: true, bytes, path: dest });
        }

        if (req.method === 'POST' && parts.length === 1 && parts[0] === 'prompt') {
          const text = await readBody(req, MAX_JSON);
          mkdirSync(join(dir, 'prompts'), { recursive: true });
          const file = join(dir, 'prompts', `${stamp()}.md`);
          writeAtomic(file, text);
          writeAtomic(join(dir, 'prompt.md'), text);
          if (dir === homes.real) server.config.logger.info(`\n  🎞  Animation review prompt saved to ${file}\n`, { timestamp: true });
          return send(res, 200, { ok: true, path: file });
        }

        return send(res, 405, { error: 'not something this endpoint does' });
      }

      server.middlewares.use('/__anim-review', (req, res) => {
        handle(req, res).catch((e: unknown) => {
          if (!res.headersSent) send(res, 500, { error: e instanceof Error ? e.message : String(e) });
          else res.end();
        });
      });
    },
  };
}
