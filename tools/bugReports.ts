import { execFile } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

// The dev server's half of in-game bug reports (src/app/bugs/reporter.ts). The game sends each
// report here a file at a time, and it is written to bugs/<when>-<what>/ for /fix-bugs to read:
//
//   POST /__bugs/begin           {slug, test}  -> {id, path}   makes the folder
//   PUT  /__bugs/<id>/<file>     the file's bytes              (frames/ is the one subfolder)
//   POST /__bugs/<id>/done                                     stamps the git commit, logs it here
//
// Only the game itself can write: a request has to come from this machine, from the same origin,
// and carry the x-bug-report header, which a page on another site can't send without a CORS
// preflight this server never answers. Test runs write to test-results/bug-reports/ instead.

const ID = /^\d{8}-\d{6}(?:-[a-z0-9]+)*$/;
const FILE = /^(?:frames\/)?[a-z0-9][a-z0-9._-]{0,80}$/;
const MAX_FILE = 512 * 1024 * 1024;
const MAX_JSON = 64 * 1024;

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function cleanSlug(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function trusted(req: IncomingMessage): boolean {
  const ip = req.socket.remoteAddress ?? '';
  const local = ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:127.');
  const site = req.headers['sec-fetch-site'];
  return local && (site === undefined || site === 'same-origin') && req.headers['x-bug-report'] === '1';
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

/** Streams a request body to a file (through a .part file, so a cut-off upload never looks whole). */
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

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((done) => execFile('git', args, { cwd, timeout: 4000, maxBuffer: 1 << 20 }, (err, out) => done(err ? '' : String(out).trim())));
}

/** Which code the report was recorded against: the commit, and files changed since it. */
async function gitInfo(cwd: string): Promise<{ commit: string | null; branch: string | null; changed: string[] }> {
  const [commit, branch, status] = await Promise.all([git(cwd, ['rev-parse', 'HEAD']), git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), git(cwd, ['status', '--porcelain'])]);
  const changed = status ? status.split('\n').map((l) => l.slice(3)) : [];
  return { commit: commit || null, branch: branch || null, changed: changed.slice(0, 200) };
}

export function bugReports(): Plugin {
  return {
    name: 'ruina:bug-reports',
    apply: 'serve',
    configureServer(server) {
      const root = server.config.root;
      const homes = [join(root, 'bugs'), join(root, 'test-results', 'bug-reports')];
      const known = new Map<string, string>();
      const folderOf = (id: string): string | null => {
        const k = known.get(id);
        if (k && existsSync(k)) return k;
        for (const base of homes) {
          const d = join(base, id);
          if (existsSync(d) && statSync(d).isDirectory()) return d;
        }
        return null;
      };

      async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://localhost');
        let parts: string[];
        try {
          parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        } catch {
          return send(res, 400, { error: 'bad path' });
        }
        if (req.method === 'GET' && parts[0] === 'ping') return send(res, 200, { ok: true });
        if (!trusted(req)) return send(res, 403, { error: 'bug reports are only accepted from the game, on this machine' });

        if (req.method === 'POST' && parts.length === 1 && parts[0] === 'begin') {
          const body = JSON.parse((await readBody(req, MAX_JSON)) || '{}') as { slug?: unknown; test?: unknown };
          const base = body.test ? homes[1] : homes[0];
          const slug = cleanSlug(body.slug);
          const name = stamp() + (slug ? `-${slug}` : '');
          let id = name;
          for (let n = 2; existsSync(join(base, id)); n++) id = `${name}-${n}`;
          mkdirSync(join(base, id, 'frames'), { recursive: true });
          known.set(id, join(base, id));
          return send(res, 200, { id, path: relative(root, join(base, id)) });
        }

        const [id, ...rest] = parts;
        if (!id || !ID.test(id)) return send(res, 400, { error: 'bad report id' });
        const dir = folderOf(id);
        if (!dir) return send(res, 404, { error: 'no such report' });

        if (req.method === 'PUT') {
          const file = rest.join('/');
          const dest = resolve(dir, file);
          if (!FILE.test(file) || !dest.startsWith(dir + sep)) return send(res, 400, { error: 'bad file name' });
          mkdirSync(dirname(dest), { recursive: true });
          const bytes = await writeBody(req, dest, MAX_FILE);
          return send(res, 200, { ok: true, bytes });
        }

        if (req.method === 'POST' && rest.length === 1 && rest[0] === 'done') {
          const path = relative(root, dir);
          const file = join(dir, 'report.json');
          let said = '';
          if (existsSync(file)) {
            const report = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> & { description?: { said?: string; note?: string } };
            report.id = id;
            report.savedAt = new Date().toISOString();
            report.git = await gitInfo(root);
            writeFileSync(file, JSON.stringify(report, null, 1));
            said = report.description?.note || report.description?.said || '';
          }
          if (!dir.startsWith(homes[1])) {
            const quote = said ? `\n     “${said.length > 100 ? `${said.slice(0, 100)}…` : said}”` : '';
            server.config.logger.info(`\n  🐞 Bug report saved to ${path}${quote}\n     Type /fix-bugs in Claude Code to have it looked at.\n`, { timestamp: true });
          }
          return send(res, 200, { ok: true, id, path });
        }

        return send(res, 405, { error: 'not something this endpoint does' });
      }

      server.middlewares.use('/__bugs', (req, res) => {
        handle(req, res).catch((e: unknown) => {
          if (!res.headersSent) send(res, 500, { error: e instanceof Error ? e.message : String(e) });
          else res.end();
        });
      });
    },
  };
}
