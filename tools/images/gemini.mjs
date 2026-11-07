// Paints a picture with Google's Gemini image models ("Nano Banana"): concept art, references for
// Meshy, textures. Cheaper than Meshy's own image tools, which run the same models.
//   npm run image -- --out scratch/concepts/hero.png --ref look.png --aspect 16:9 "a prompt"
//   npm run image -- --list                     the image models this key can use
// Options: --model (default gemini-3-pro-image, "Nano Banana Pro"; gemini-3.1-flash-image, "Nano
// Banana 2", is cheaper for drafts), --ref <image> (several, in the order the prompt names them),
// --aspect (1:1, 16:9, 3:4, ...), --size (1K, 2K, 4K), --prompt-file <file> instead of the prompt
// as the last argument.
// The key is GEMINI_API_KEY: from the environment, else .env here, else the .env of the main
// checkout (worktrees share it). It is never printed; .env is never committed.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

function fromEnvFile(file) {
  if (!fs.existsSync(file)) return undefined;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*GEMINI_API_KEY\s*=\s*(.*?)\s*$/);
    if (m) return m[1].replace(/^(['"])(.*)\1$/, '$2') || undefined;
  }
  return undefined;
}

function apiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const here = fromEnvFile('.env');
  if (here) return here;
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
    const main = fromEnvFile(path.join(path.dirname(common), '.env'));
    if (main) return main;
  } catch {
    // Not in a git checkout: only the environment and ./.env count.
  }
  throw new Error('No GEMINI_API_KEY: put it in .env (never committed) or the environment.');
}

function parse(argv) {
  const o = { model: 'gemini-3-pro-image', refs: [], aspect: undefined, size: undefined, out: undefined, prompt: undefined, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') o.list = true;
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--ref') o.refs.push(argv[++i]);
    else if (a === '--aspect') o.aspect = argv[++i];
    else if (a === '--size') o.size = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--prompt-file') o.prompt = fs.readFileSync(argv[++i], 'utf8').trim();
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else o.prompt = a;
  }
  return o;
}

async function call(url, key, body) {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-goog-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${json.error?.message ?? res.statusText}`);
  return json;
}

async function main() {
  const o = parse(process.argv.slice(2));
  const key = apiKey();
  if (o.list) {
    const { models = [] } = await call(`${API}/models?pageSize=1000`, key);
    for (const m of models.filter((m) => /image/i.test(m.name))) console.log(`${m.name.replace('models/', '')}  ${m.displayName ?? ''}`);
    return;
  }
  if (!o.prompt || !o.out) throw new Error('Give a prompt and --out <file.png> (or --list).');

  const parts = [{ text: o.prompt }];
  for (const ref of o.refs) {
    const mime = MIME[path.extname(ref).toLowerCase()];
    if (!mime) throw new Error(`${ref}: only png, jpg and webp references`);
    parts.push({ inline_data: { mime_type: mime, data: fs.readFileSync(ref).toString('base64') } });
  }
  const imageConfig = { ...(o.aspect ? { aspectRatio: o.aspect } : {}), ...(o.size ? { imageSize: o.size } : {}) };
  const json = await call(`${API}/models/${o.model}:generateContent`, key, {
    contents: [{ parts }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(Object.keys(imageConfig).length ? { imageConfig } : {}) },
  });

  const got = json.candidates?.[0]?.content?.parts ?? [];
  const image = got.find((p) => p.inlineData ?? p.inline_data);
  for (const p of got) if (p.text) console.log(p.text.trim());
  if (!image) throw new Error(`No image came back (${json.candidates?.[0]?.finishReason ?? json.promptFeedback?.blockReason ?? 'no reason given'}).`);
  const data = (image.inlineData ?? image.inline_data).data;
  fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
  fs.writeFileSync(o.out, Buffer.from(data, 'base64'));
  const usage = json.usageMetadata;
  console.log(`${o.out} (${o.model}${usage ? `, ${usage.totalTokenCount} tokens` : ''})`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
