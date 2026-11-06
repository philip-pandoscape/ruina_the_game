// Where free assets come from, and how to ask each one (the find-assets skill,
// .claude/skills/find-assets/SKILL.md): search and fetch for the sources with an API (Poly Haven,
// ambientCG, Sketchfab, Freesound), Kenney's packs from their pages, itch.io's free downloads
// (Quaternius' packs among them), and any direct link. Used by search.mjs and fetch.mjs.
//
// Keys, where a source needs one: SKETCHFAB_TOKEN (downloads), FREESOUND_API_KEY (search and
// previews), from the environment, else .env here, else the main checkout's .env (worktrees share
// it). Never printed; .env is never committed.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const LICENCES = {
  CC0: { name: 'CC0 1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
  'CC-BY-4.0': { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
  'CC-BY-3.0': { name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0/' },
};

/** A licence written by a source, as one of ours: null when it isn't one a public repository can carry. */
export function licenceOf(text) {
  const t = String(text ?? '').toLowerCase();
  if (/cc0|public domain|creative commons 0|publicdomain\/zero/.test(t)) return 'CC0';
  if (/(^|\b)(nc|noncommercial|non-commercial|nd|noderivs|no-derivatives)\b|by-nc|by-nd|-nc-|-nd-/.test(t)) return null;
  if (/sa\b|sharealike|share-alike|by-sa/.test(t)) return null;
  if (/by\/4|cc by 4|cc-by-4|attribution 4|(^|\b)attribution$|cc attribution(?! noncommercial)/.test(t)) return 'CC-BY-4.0';
  if (/by\/3|cc by 3|cc-by-3|attribution 3/.test(t)) return 'CC-BY-3.0';
  return null;
}

const UA = { 'User-Agent': 'ruina-find-assets/1.0' };

/** A key from the environment, ./.env, or the main checkout's .env. */
export function key(name) {
  if (process.env[name]) return process.env[name];
  const read = (file) => {
    if (!fs.existsSync(file)) return undefined;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`));
      if (m) return m[1].replace(/^(['"])(.*)\1$/, '$2') || undefined;
    }
    return undefined;
  };
  const here = read('.env');
  if (here) return here;
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
    return read(path.join(path.dirname(common), '.env'));
  } catch {
    return undefined;
  }
}

async function json(url, headers = {}) {
  const r = await fetch(url, { headers: { ...UA, ...headers } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} from ${url.replace(/token=[^&]+/, 'token=...')}`);
  return r.json();
}

/** Downloads `url` to `file` (making its folder), returning its size in bytes. */
export async function download(url, file, headers = {}) {
  const r = await fetch(url, { headers: { ...UA, ...headers }, redirect: 'follow' });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} downloading ${url}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return bytes.length;
}

/** Unpacks a zip into its own folder (tar on Windows and macOS reads zips; unzip elsewhere). */
export function unzip(zip, dir) {
  fs.mkdirSync(dir, { recursive: true });
  try {
    execFileSync('tar', ['-xf', zip, '-C', dir], { stdio: 'ignore' });
  } catch {
    execFileSync('unzip', ['-o', '-q', zip, '-d', dir], { stdio: 'ignore' });
  }
}

/** Every file under a folder (paths with the folder in front). */
export function listFiles(dir) {
  return fs
    .readdirSync(dir, { recursive: true })
    .map((f) => path.join(dir, String(f)))
    .filter((f) => fs.statSync(f).isFile());
}

const words = (q) => String(q).toLowerCase().split(/[\s,]+/).filter(Boolean);
const matches = (hay, ws) => ws.every((w) => hay.some((h) => h.includes(w)));

// ---------- Poly Haven: realistic CC0 models, textures and skies (no key) ----------

const PH_KIND = { model: 'models', texture: 'textures', sky: 'hdris' };

export async function searchPolyHaven(kind, query, limit) {
  const t = PH_KIND[kind];
  if (!t) return [];
  const all = await json(`https://api.polyhaven.com/assets?t=${t}`);
  const ws = words(query);
  return Object.entries(all)
    .filter(([id, a]) => matches([id, a.name, ...(a.tags ?? []), ...(a.categories ?? [])].map((s) => String(s).toLowerCase()), ws))
    .sort((a, b) => (b[1].download_count ?? 0) - (a[1].download_count ?? 0))
    .slice(0, limit)
    .map(([id, a]) => ({
      source: 'polyhaven',
      id,
      name: a.name,
      licence: 'CC0',
      author: Object.keys(a.authors ?? {}).join(', '),
      page: `https://polyhaven.com/a/${id}`,
      preview: `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256&height=256`,
      detail:
        kind === 'model'
          ? `${a.polycount ?? '?'} polygons, ${(a.dimensions ?? []).map((d) => (d / 1000).toFixed(2)).join(' x ')} m`
          : `up to ${(a.max_resolution ?? [])[0] ?? '?'} px`,
    }));
}

export async function fetchPolyHaven(id, out, { res = '1k', maps } = {}) {
  const [info, files] = await Promise.all([json(`https://api.polyhaven.com/info/${id}`), json(`https://api.polyhaven.com/files/${id}`)]);
  const got = [];
  // Poly Haven says what an asset is (0 a sky, 1 a texture, 2 a model): textures come with a
  // preview glTF too, which isn't what a texture is fetched for.
  if (info.type === 2) {
    const g = files.gltf?.[res]?.gltf;
    if (!g) throw new Error(`${id} has no ${res} glTF (has ${Object.keys(files.gltf ?? {}).join(', ')})`);
    const main = path.join(out, path.basename(new URL(g.url).pathname));
    await download(g.url, main);
    got.push(main);
    for (const [rel, f] of Object.entries(g.include ?? {})) {
      const file = path.join(out, rel);
      await download(f.url, file);
      got.push(file);
    }
  } else if (info.type === 0) {
    const h = files.hdri[res]?.hdr;
    if (!h) throw new Error(`${id} has no ${res} HDR`);
    const file = path.join(out, path.basename(new URL(h.url).pathname));
    await download(h.url, file);
    got.push(file);
  } else {
    // A texture: the maps asked for (or the colour, normal and roughness), as JPG.
    const want = maps ?? ['Diffuse', 'nor_gl', 'Rough'];
    for (const m of want) {
      const f = files[m]?.[res]?.jpg ?? files[m]?.[res]?.png;
      if (!f) {
        console.warn(`  ${id} has no ${m} at ${res}`);
        continue;
      }
      const file = path.join(out, path.basename(new URL(f.url).pathname));
      await download(f.url, file);
      got.push(file);
    }
  }
  return {
    name: info.name,
    source: 'Poly Haven',
    page: `https://polyhaven.com/a/${id}`,
    author: Object.keys(info.authors ?? {}).join(', '),
    licence: 'CC0',
    files: got,
  };
}

// ---------- ambientCG: CC0 textures (no key) ----------

export async function searchAmbientCg(kind, query, limit) {
  if (kind !== 'texture') return [];
  const r = await json(`https://ambientcg.com/api/v3/assets?q=${encodeURIComponent(query)}&limit=${limit}&include=title,tags,previews,downloads`);
  return (r.assets ?? []).map((a) => ({
    source: 'ambientcg',
    id: a.id,
    name: a.title ?? a.id,
    licence: 'CC0',
    author: 'ambientCG',
    page: `https://ambientcg.com/view?id=${a.id}`,
    preview: (a.previews ?? []).map((p) => p.url).find((u) => /\.(jpe?g|png|webp)(\?|$)/i.test(u)) ?? '',
    detail: (a.downloads ?? []).map((d) => d.attributes).filter((x) => /JPG/.test(x)).join(' '),
  }));
}

export async function fetchAmbientCg(id, out, { res = '1k' } = {}) {
  const r = await json(`https://ambientcg.com/api/v3/assets?id=${encodeURIComponent(id)}&include=title,downloads`);
  const a = (r.assets ?? []).find((x) => x.id === id);
  if (!a) throw new Error(`ambientCG has no ${id}`);
  const want = `${res.toUpperCase()}-JPG`;
  const d = (a.downloads ?? []).find((x) => x.attributes === want);
  if (!d) throw new Error(`${id} has no ${want} (has ${(a.downloads ?? []).map((x) => x.attributes).join(', ')})`);
  const zip = path.join(out, `${id}_${want}.zip`);
  await download(d.url, zip);
  unzip(zip, out);
  fs.rmSync(zip);
  return {
    name: a.title ?? id,
    source: 'ambientCG',
    page: `https://ambientcg.com/view?id=${id}`,
    author: 'ambientCG',
    licence: 'CC0',
    files: listFiles(out),
  };
}

// ---------- Sketchfab: far more models (search needs no key; downloads need SKETCHFAB_TOKEN) ----------

export async function searchSketchfab(kind, query, limit, { licence = 'cc0', animated = false, maxFaces = 60000 } = {}) {
  if (kind !== 'model' && kind !== 'animation') return [];
  const lic = licence === 'by' ? 'by' : 'cc0';
  const url =
    `https://api.sketchfab.com/v3/search?type=models&downloadable=true&license=${lic}&count=${limit}` +
    `&q=${encodeURIComponent(query)}${animated || kind === 'animation' ? '&animated=true' : ''}` +
    // Leaves out the museum scans (hundreds of thousands of faces) a game can't carry.
    (maxFaces ? `&max_face_count=${maxFaces}` : '');
  const r = await json(url);
  return (r.results ?? []).map((m) => ({
    source: 'sketchfab',
    id: m.uid,
    name: m.name,
    licence: licenceOf(m.license?.label) ?? m.license?.label ?? '?',
    author: m.user?.displayName ?? m.user?.username ?? '',
    page: m.viewerUrl,
    preview: [...(m.thumbnails?.images ?? [])].sort((a, b) => Math.abs(a.width - 256) - Math.abs(b.width - 256))[0]?.url ?? '',
    detail: `${m.faceCount ?? '?'} faces${m.animationCount ? `, ${m.animationCount} animation(s)` : ''}`,
  }));
}

export async function fetchSketchfab(uid, out) {
  const token = key('SKETCHFAB_TOKEN');
  if (!token) throw new Error('Sketchfab downloads need SKETCHFAB_TOKEN (the user\'s API token, from sketchfab.com/settings/password) in .env');
  const auth = { Authorization: `Token ${token}` };
  const [info, dl] = await Promise.all([json(`https://api.sketchfab.com/v3/models/${uid}`), json(`https://api.sketchfab.com/v3/models/${uid}/download`, auth)]);
  const got = [];
  if (dl.glb?.url) {
    const file = path.join(out, `${uid}.glb`);
    await download(dl.glb.url, file);
    got.push(file);
  } else if (dl.gltf?.url) {
    const zip = path.join(out, `${uid}_gltf.zip`);
    await download(dl.gltf.url, zip);
    unzip(zip, out);
    fs.rmSync(zip);
    got.push(...listFiles(out));
  } else throw new Error(`no glTF or GLB download for ${uid}`);
  const lic = licenceOf(info.license?.label);
  if (!lic) console.warn(`  careful: ${info.license?.label} is not a licence this public repository can carry`);
  return { name: info.name, source: 'Sketchfab', page: info.viewerUrl, author: info.user?.displayName ?? '', licence: lic ?? info.license?.label, files: got };
}

// ---------- Freesound: sound effects (FREESOUND_API_KEY; previews only, originals need its sign-in) ----------

export async function searchFreesound(kind, query, limit) {
  if (kind !== 'sound' && kind !== 'music') return [];
  const token = key('FREESOUND_API_KEY');
  if (!token) {
    console.warn('  Freesound: skipped, no FREESOUND_API_KEY (a free key from freesound.org/apiv2/apply)');
    return [];
  }
  const filter = encodeURIComponent('license:("Creative Commons 0" OR "Attribution")');
  const fields = 'id,name,license,username,duration,previews,url,num_downloads,avg_rating';
  const r = await json(`https://freesound.org/apiv2/search/text/?query=${encodeURIComponent(query)}&filter=${filter}&fields=${fields}&page_size=${limit}&sort=rating_desc&token=${token}`);
  return (r.results ?? []).map((s) => ({
    source: 'freesound',
    id: String(s.id),
    name: s.name,
    licence: licenceOf(s.license) ?? s.license,
    author: s.username,
    page: s.url,
    preview: s.previews?.['preview-hq-mp3'] ?? '',
    detail: `${(s.duration ?? 0).toFixed(1)} s, ${s.num_downloads ?? 0} downloads, rated ${(s.avg_rating ?? 0).toFixed(1)}`,
  }));
}

export async function fetchFreesound(id, out) {
  const token = key('FREESOUND_API_KEY');
  if (!token) throw new Error('Freesound needs FREESOUND_API_KEY in .env (a free key from freesound.org/apiv2/apply)');
  const s = await json(`https://freesound.org/apiv2/sounds/${id}/?fields=id,name,license,username,url,previews,duration&token=${token}`);
  const got = [];
  for (const k of ['preview-hq-ogg', 'preview-hq-mp3']) {
    const url = s.previews?.[k];
    if (!url) continue;
    const file = path.join(out, `${id}_${s.name.replace(/[^\w.-]+/g, '_').replace(/\.(wav|mp3|ogg|flac|aiff?)$/i, '')}.${k.endsWith('ogg') ? 'ogg' : 'mp3'}`);
    await download(url, file);
    got.push(file);
  }
  console.warn('  these are Freesound\'s high-quality previews; the original file needs its OAuth2 sign-in (the user\'s hands)');
  return { name: s.name, source: 'Freesound', page: s.url, author: s.username, licence: licenceOf(s.license) ?? s.license, files: got };
}

// ---------- Kenney: CC0 packs (models, sounds, particles, UI), from their pages ----------

export async function fetchKenney(slug, out) {
  const page = `https://kenney.nl/assets/${slug}`;
  const jar = new Jar();
  const r = await fetch(page, { headers: UA });
  jar.take(r);
  if (!r.ok) throw new Error(`${r.status} for ${page}`);
  const html = await r.text();
  // The page's "Continue without donating" asks kenney.nl/download-link/<id> for a fresh signed link.
  const downloadId = html.match(/data-download-id=['"]([0-9a-f]+)['"]/)?.[1];
  if (!downloadId) throw new Error(`no download on ${page}`);
  const link = await fetch(`https://kenney.nl/download-link/${downloadId}`, { headers: { ...UA, Cookie: jar.header(), Referer: page } });
  if (!link.ok) throw new Error(`${link.status} asking for ${slug}'s download link`);
  const zipUrl = (await link.json()).url;
  if (!zipUrl) throw new Error(`kenney.nl gave no link for ${slug}`);
  const zip = path.join(out, `${slug}.zip`);
  await download(zipUrl, zip);
  unzip(zip, out);
  fs.rmSync(zip);
  const title = html.match(/<title>([^<]+)<\/title>/)?.[1]?.replace(/\s*(&middot;|·|\||-)\s*Kenney.*$/i, '').trim() ?? slug;
  return { name: title, source: 'Kenney', page, author: 'Kenney (kenney.nl)', licence: 'CC0', files: listFiles(out) };
}

// ---------- itch.io: a free download, the steps a visitor's browser takes (Quaternius' packs) ----------

/** Cookies kept across the requests, as the browser would. */
class Jar {
  cookies = new Map();
  take(r) {
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export async function fetchItch(game, out, { file } = {}) {
  const [creator, slug] = game.split('/');
  if (!creator || !slug) throw new Error('itch: give creator/game, as in quaternius/universal-animation-library');
  const base = `https://${creator}.itch.io/${slug}`;
  const jar = new Jar();
  const get = async (url) => {
    const r = await fetch(url, { headers: { ...UA, Cookie: jar.header() } });
    jar.take(r);
    if (!r.ok) throw new Error(`${r.status} for ${url}`);
    return r.text();
  };
  const post = async (url, csrf) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { ...UA, Cookie: jar.header(), 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      body: new URLSearchParams({ csrf_token: csrf }),
    });
    jar.take(r);
    if (!r.ok) throw new Error(`${r.status} for ${url}`);
    return r.json();
  };
  const csrfOf = (html) => html.match(/name="csrf_token"\s+value="([^"]+)"/)?.[1] ?? html.match(/csrf_token["']?\s*[:=]\s*["']([^"']+)/)?.[1];
  // "No thanks, just take me to the downloads": the pack's own free download page.
  const purchase = await get(`${base}/purchase`);
  const step = await post(`${base}/download_url`, csrfOf(purchase));
  if (!step.url) throw new Error(`itch gave no download page for ${game} (is it free?)`);
  const page = await get(step.url);
  // Each file: its button carries the upload's id, and the <strong> after it the file's name.
  const uploads = [...page.matchAll(/data-upload_id="(\d+)"[\s\S]*?<strong[^>]*?title="([^"]+)"/g)].map((m) => ({ id: m[1], name: m[2] }));
  if (!uploads.length) {
    // The page's markup changed: keep it, to read how it lists its files now.
    const keep = path.join(out, 'download-page.html');
    fs.writeFileSync(keep, page);
    throw new Error(`no files found on ${game}'s download page (kept in ${keep})`);
  }
  const pick = file ? uploads.filter((u) => u.name.toLowerCase().includes(file.toLowerCase())) : uploads;
  if (!pick.length) throw new Error(`no file matching "${file}"; there are: ${uploads.map((u) => u.name).join(', ')}`);
  const got = [];
  for (const u of pick) {
    const link = await post(`${base}/file/${u.id}?source=game_download&after_download_lightbox=1&as_props=1`, csrfOf(page));
    if (!link.url) throw new Error(`no link for ${u.name}`);
    const target = path.join(out, u.name);
    await download(link.url, target);
    got.push(target);
  }
  return { name: slug, source: `itch.io (${creator})`, page: base, author: creator, licence: '(check the page)', files: got };
}

// ---------- Anything else: a direct link, with what the agent read on its page ----------

export async function fetchUrl(url, out, { name, author, licence, page }) {
  const file = path.join(out, path.basename(new URL(url).pathname) || 'download');
  await download(url, file);
  if (/\.zip$/i.test(file)) {
    unzip(file, out);
    fs.rmSync(file);
  }
  return { name: name ?? path.basename(file), source: new URL(page ?? url).host, page: page ?? url, author: author ?? '?', licence: licence ?? '?', files: listFiles(out) };
}
