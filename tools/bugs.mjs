#!/usr/bin/env node
// The bug reports recorded in the game (press \ while playing: src/app/bugs/reporter.ts), read from
// the terminal - mostly by Claude Code's /fix-bugs skill (.claude/skills/fix-bugs/SKILL.md).
//
//   node tools/bugs.mjs list [--all]          open reports, oldest first (--all: closed ones too)
//   node tools/bugs.mjs show <id> [--all-logs]  a readable digest of one report
//   node tools/bugs.mjs frames <id> [--from <s>] [--to <s>] [--every <s>]
//                                             frame files covering a stretch of time
//   node tools/bugs.mjs transcribe <id>       transcribe voice.wav with whisper.cpp, if installed
//   node tools/bugs.mjs close <id> <fixed|duplicate|not-a-bug|cant-reproduce|wontfix> "<what was done>"
//   node tools/bugs.mjs reopen <id>
//
// <id> is a report's folder name, any unique part of it, or "latest". Times are seconds from the
// moment the report key was pressed (negative is before it). --dir <path> reads another folder.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

function flag(name) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  const has = v !== undefined && !v.startsWith('--');
  argv.splice(i, has ? 2 : 1);
  return has ? v : true;
}

// Flags first, wherever they were typed; what is left are the command and its arguments.
const opts = { dir: flag('dir'), all: flag('all'), allLogs: flag('all-logs'), from: flag('from'), to: flag('to'), every: flag('every') };
const DIR = resolve(ROOT, typeof opts.dir === 'string' ? opts.dir : 'bugs');
const CLOSED = join(DIR, 'closed');
const STATUSES = ['fixed', 'duplicate', 'not-a-bug', 'cant-reproduce', 'wontfix'];

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

const rel = (p) => relative(process.cwd(), p) || '.';
const readJson = (p, fallback = null) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
};
const sec = (t) => (typeof t === 'number' ? `${t >= 0 ? '+' : ''}${t.toFixed(1)}s` : '?');
const num = (v, d = 2) => (typeof v === 'number' ? +v.toFixed(d) : v);
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : (s ?? ''));
const size = (bytes) => (bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

function reports({ closed = false } = {}) {
  const out = [];
  const scan = (base, isClosed) => {
    if (!existsSync(base)) return;
    for (const id of readdirSync(base)) {
      const dir = join(base, id);
      if (id === 'closed' || id.startsWith('.') || !statSync(dir).isDirectory()) continue;
      const file = join(dir, 'report.json');
      if (!existsSync(file)) {
        out.push({ id, dir, closed: isClosed, broken: 'no report.json: the upload never finished' });
        continue;
      }
      const r = readJson(file);
      out.push(r ? { id, dir, closed: isClosed, r } : { id, dir, closed: isClosed, broken: 'report.json is not readable JSON' });
    }
  };
  scan(DIR, false);
  if (closed) scan(CLOSED, true);
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function find(q, { closed = true } = {}) {
  if (!q) die('Which report? Give its id (node tools/bugs.mjs list shows them).');
  const all = reports({ closed });
  if (q === 'latest') return all.filter((x) => !x.closed).pop() ?? die('There are no open bug reports.');
  const exact = all.find((x) => x.id === q);
  if (exact) return exact;
  const hits = all.filter((x) => x.id.includes(q));
  if (hits.length === 1) return hits[0];
  return die(hits.length ? `"${q}" matches ${hits.length} reports: ${hits.map((h) => h.id).join(', ')}` : `No report matches "${q}".`);
}

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

/** What was said (or typed), in one line. */
function said(r) {
  const d = r?.description ?? {};
  return d.note || d.whisper?.text || d.said || '';
}

/** Error stacks from the dev server point at http://localhost:5173/src/x.ts?t=123:10:5. */
function tidyStack(s) {
  return String(s ?? '')
    .replace(/https?:\/\/[^/\s)]+\//g, '')
    .replace(/\?[a-z]+=[\w.-]+(?=:\d)/g, '')
    .replace(/\?[a-z]+(?=:\d)/g, '');
}

function nearest(list, t) {
  let best = null;
  for (const x of list) if (!best || Math.abs(x.t - t) < Math.abs(best.t - t)) best = x;
  return best;
}

// ---------- list ----------

function list() {
  const all = reports({ closed: !!opts.all });
  const open = all.filter((x) => !x.closed);
  const where = rel(DIR);
  if (!all.length) {
    console.log(`No bug reports in ${where}/. Record one in the game: press \\ (or click both sticks), talk, press it again.`);
    return;
  }
  console.log(
    `${open.length} open bug report${open.length === 1 ? '' : 's'} in ${where}/${all.length > open.length ? ` (and ${all.length - open.length} closed, in ${where}/closed/)` : ''}:\n`,
  );
  for (const x of all) {
    if (x.broken) {
      console.log(`  ${x.id}   ⚠ ${x.broken}`);
      continue;
    }
    const r = x.r;
    const when = new Date(r.recordedAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const errs = r.errors?.filter((e) => e.t >= (r.covers?.from ?? -Infinity)).length ?? 0;
    const bits = [
      when,
      `${Math.round(r.covers?.to ?? 0)} s`,
      errs ? `${errs} error${errs === 1 ? '' : 's'}` : '',
      r.voice?.file ? '' : 'no voice',
      x.closed ? `closed: ${r.resolution?.status ?? r.status}` : '',
    ].filter(Boolean);
    console.log(`  ${x.id}   ${bits.join(' · ')}`);
    const words = said(r);
    console.log(`      ${words ? `“${clip(words, 150)}”` : '(nothing said or typed)'}`);
  }
  console.log(`\nRead one: node tools/bugs.mjs show <id>`);
}

// ---------- show ----------

function pickFrames(r) {
  const frames = r.frames ?? [];
  if (!frames.length) return [];
  const want = new Map();
  const add = (t, why) => {
    const f = nearest(frames, t);
    if (f && Math.abs(f.t - t) < 2 && !want.has(f.file)) want.set(f.file, { ...f, why });
  };
  const first = frames[0].t;
  for (let t = Math.ceil(first / 5) * 5; t < -5; t += 5) add(t, 'history');
  for (const t of [-4, -3, -2, -1.5, -1, -0.5, -0.25]) if (t >= first) add(t, 'just before the press');
  for (const s of r.description?.transcript ?? []) add(s.t0, `as you said “${clip(s.text, 50)}”`);
  for (const s of r.description?.whisper?.segments ?? []) add(s.t0, `as you said “${clip(s.text, 50)}”`);
  for (const e of (r.errors ?? []).slice(0, 4)) if (e.t >= first) add(e.t, `when an error happened (${clip(e.message, 40)})`);
  const last = frames[frames.length - 1].t;
  if (!(r.description?.transcript ?? []).length) for (let t = 2; t < last; t += 4) add(t, 'while recording');
  return [...want.values()].sort((a, b) => a.t - b.t).slice(0, 22);
}

function describeState(s) {
  if (!s) return ['(no state was captured)'];
  if (s.error) return [`(${s.error})`];
  const out = [];
  const p = s.player ?? {};
  const v3 = (v) => (v ? `(${num(v.x)}, ${num(v.y)}, ${num(v.z)})` : '?');
  out.push(`mode: ${s.mode}${s.paused ? ' (paused)' : ''} · sim frame ${s.frame} · ${s.device}`);
  out.push(
    `player: ${p.mode}${p.grounded ? ', on the ground' : ', in the air'} at ${v3(p.pos)}, moving ${v3(p.vel)} m/s, facing ${num(((p.facing ?? 0) * 180) / Math.PI, 0)}°, hp ${p.hp}${p.sprinting ? ', sprinting' : ''}${p.crouching ? ', crouching' : ''}`,
  );
  if (s.riding)
    out.push(
      `riding: ${s.riding.def} #${s.riding.id} at (${num(s.riding.x)}, ${num(s.riding.y)}, ${num(s.riding.z)}), speed ${num(s.riding.speed)} m/s, heading ${num(((s.riding.heading ?? 0) * 180) / Math.PI, 0)}°`,
    );
  const panels = [
    s.panels?.life && `${s.panels.life} panel`,
    s.panels?.skillTree && 'skill tree',
    s.panels?.aimingSlot && `aiming slot ${s.panels.aimingSlot}`,
  ].filter(Boolean);
  if (panels.length) out.push(`open: ${panels.join(', ')}`);
  if (s.target) out.push(`target: ${s.target.name} (${s.target.hp} hp)${s.target.locked ? ', locked' : ''}`);
  const L = s.life;
  if (L) {
    if (L.focus)
      out.push(
        `interaction prompt: ${L.focus.action} “${L.focus.label}”${L.focus.detail ? ` (${L.focus.detail})` : ''}${L.focus.ok ? '' : ' (not possible right now)'}`,
      );
    if (L.placing) out.push(`placing: ${JSON.stringify(L.placing).slice(0, 160)}`);
    out.push(
      `island: ${L.coins} coins, ${L.seals} seals, ${Math.floor(L.labor)} labor, clock ${Math.round(L.clock)} s, ${L.bag?.length ?? 0} bag stacks, ${L.packs?.length ?? 0} packs, ${L.vehicles?.length ?? 0} vehicles, ${L.houses?.length ?? 0} houses, ${L.scarecrows?.length ?? 0} farms`,
    );
    const q = L.quests?.active ?? [];
    if (q.length) out.push(`quests: ${q.map((x) => `${x.id}${x.step !== undefined ? ` (step ${x.step})` : ''}`).join(', ')}`);
    if (L.weather) out.push(`weather: ${JSON.stringify(L.weather).slice(0, 160)}`);
  }
  const near = (s.nearby ?? []).slice(0, 8);
  if (near.length)
    out.push(`nearby: ${near.map((a) => `${a.kind}#${a.id} ${num(a.dist, 1)} m${a.alive ? '' : ' (dead)'}${a.state ? ` ${a.state}` : ''}`).join(', ')}`);
  const perf = s.perf;
  if (perf)
    out.push(
      `perf: ${perf.fps} fps (p95 ${perf.p95Ms} ms), ${perf.drawCalls} draw calls, ${perf.triangles?.toLocaleString?.() ?? perf.triangles} triangles, GPU ${perf.gpuMs ?? '?'} ms · ${perf.gpu}`,
    );
  return out;
}

function timelineRows(samples, from, to) {
  const rows = [];
  let last = -Infinity;
  for (const s of samples) {
    if (s.t < from || s.t > to) continue;
    const near = Math.abs(s.t) <= 3;
    if (s.t - last < (near ? 0.45 : 0.95) && !s.hitchMs) continue;
    last = s.t;
    const speed = Math.hypot(s.vx ?? 0, s.vz ?? 0);
    const bits = [
      sec(s.t).padStart(7),
      `(${num(s.x, 1)}, ${num(s.y, 1)}, ${num(s.z, 1)})`.padEnd(24),
      `${s.mode}${s.grounded ? '' : ' air'}`.padEnd(12),
      `${speed.toFixed(1)} m/s${Math.abs(s.vy ?? 0) > 0.5 ? ` vy ${num(s.vy, 1)}` : ''}`.padEnd(18),
    ];
    if (s.ride) bits.push(`${s.ride.def} ${num(s.ride.speed, 1)} m/s at (${num(s.ride.x, 1)}, ${num(s.ride.y, 1)}, ${num(s.ride.z, 1)})`);
    if (s.focus) bits.push(`[${s.focus}]`);
    if (s.panel) bits.push(`{${s.panel} open}`);
    if (s.hp !== undefined) bits.push(`hp ${s.hp}`);
    if (s.hitchMs) bits.push(`⚠ ${s.hitchMs} ms frame`);
    rows.push(`  ${bits.join(' ')}`);
  }
  return rows;
}

function eventLine(e) {
  const { t, src, type, frame: _f, ...rest } = e;
  const detail = Object.entries(rest)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'number' ? num(v) : typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : clip(String(v), 80)}`)
    .join(' ');
  return `  ${sec(t).padStart(7)} ${String(src).padEnd(7)} ${type ?? ''} ${detail}`;
}

function show(q) {
  const allLogs = !!opts.allLogs;
  const x = find(q);
  if (x.broken) die(`${x.id}: ${x.broken}. Files there: ${readdirSync(x.dir).join(', ')}`);
  const r = x.r;
  const dir = x.dir;
  const state = readJson(join(dir, 'state.json'), {});
  const timeline = readJson(join(dir, 'timeline.json'), {});
  const out = [];
  const h = (title) => out.push('', `## ${title}`);

  out.push(`# Bug report ${x.id}${x.closed ? ` (closed: ${r.resolution?.status ?? r.status})` : ''}`);
  out.push(`Recorded ${r.localTime ?? r.recordedAt} · covers ${sec(r.covers?.from)} to ${sec(r.covers?.to)} · ${r.page?.mode ?? '?'} · ${r.page?.url ?? ''}`);
  out.push(`Folder: ${rel(dir)}/`);
  if (r.git?.commit) {
    const head = git(['rev-parse', 'HEAD']);
    const dirty = r.git.changed?.length
      ? `, with ${r.git.changed.length} uncommitted change${r.git.changed.length === 1 ? '' : 's'} (${clip(r.git.changed.join(', '), 160)})`
      : '';
    out.push(`Code: commit ${r.git.commit.slice(0, 9)} on ${r.git.branch}${dirty}.`);
    if (head && head !== r.git.commit) {
      const since = git(['diff', '--stat', '--stat-width=100', r.git.commit, '--', 'src', 'shared', 'crates', 'index.html']).split('\n').filter(Boolean);
      if (since.length)
        out.push(
          `  The code has changed since (vs your working tree): ${since.pop()?.trim()}. It may already be fixed; check these:`,
          ...since.slice(0, 12).map((l) => `   ${l.trim()}`),
        );
    }
  }
  if (r.resolution) out.push(`Resolution: ${r.resolution.status} (${r.resolution.closedAt}): ${r.resolution.note}`);

  h('What was said');
  const d = r.description ?? {};
  const segs = d.whisper?.segments?.length ? d.whisper.segments : (d.transcript ?? []);
  if (d.whisper?.segments?.length) out.push(`(whisper.cpp transcript, ${d.whisper.model}; the live one is in report.json)`);
  for (const s of segs)
    out.push(`  [${sec(s.t0)}] ${s.text}${s.partial ? ' (cut off)' : ''}${s.confidence && s.confidence < 0.6 ? ` (unsure: ${s.confidence})` : ''}`);
  if (d.note) out.push(`  Typed note: ${d.note}`);
  if (!segs.length && !d.note) out.push('  (nothing was transcribed)');
  const v = r.voice ?? {};
  if (v.file) {
    out.push(
      `  Voice: ${v.file}, ${v.seconds} s from ${sec(v.startsAt)}${v.silent ? ', ⚠ almost silent (muted or wrong microphone?)' : ''}. Live transcription: ${d.engine ?? 'off'} (${d.lang}, ${d.speechStatus}).`,
    );
    if (!d.whisper && (!segs.length || segs.some((s) => (s.confidence ?? 1) < 0.6))) out.push('  A clearer transcript: node tools/bugs.mjs transcribe ' + x.id);
  } else out.push(`  No voice: ${v.why ?? 'none recorded'}.`);

  h('Look at these pictures (Read them)');
  if (r.screenshots?.press)
    out.push(`  ${rel(join(dir, r.screenshots.press.file))}   the whole screen at the press${r.screenshots.press.hud ? ', HUD included' : ' (3D view only)'}`);
  for (const f of pickFrames(r)) out.push(`  ${rel(join(dir, f.file))}   ${sec(f.t)}  ${f.why}`);
  if (r.screenshots?.end)
    out.push(`  ${rel(join(dir, r.screenshots.end.file))}   the whole screen when the report was finished${r.screenshots.end.hud ? ', HUD included' : ''}`);
  out.push(`  (${r.frames?.length ?? 0} frames in all, ${r.framesNote ?? ''} More: node tools/bugs.mjs frames ${x.id} --from -5 --to 2)`);
  if (r.video?.file) out.push(`  Video with voice for people: ${rel(join(dir, r.video.file))} (${size(r.video.bytes ?? 0)}, from ${sec(r.video.startsAt)})`);

  const errs = r.errors ?? [];
  h(`Errors (${errs.length})`);
  if (!errs.length) out.push('  none');
  for (const e of errs) {
    out.push(`  ${sec(e.t)} ${e.kind}: ${e.message}${e.source ? `  (${tidyStack(e.source)})` : ''}`);
    if (e.stack) for (const line of tidyStack(e.stack).split('\n').slice(1, 8)) out.push(`        ${line.trim()}`);
  }
  if (errs.some((e) => e.stack)) out.push('  (Line numbers are in the code Vite served and can be a few lines off the source.)');

  const logs = r.console ?? [];
  const loud = logs.filter((l) => l.level === 'warn' || l.level === 'error');
  const quiet = logs.filter((l) => l.level !== 'warn' && l.level !== 'error' && !/^\[vite\]/.test(l.text));
  // The same message over and over is one line with a count.
  const grouped = (lines) => {
    const g = [];
    for (const l of lines) {
      const last = g[g.length - 1];
      if (last && last.level === l.level && last.text === l.text) last.n++;
      else g.push({ ...l, n: 1 });
    }
    return g;
  };
  const say = (l, n) => `  ${sec(l.t)} ${l.level}${l.n > 1 ? ` ×${l.n}` : ''}: ${clip(tidyStack(l.text), n)}`;
  h(`Console (${loud.length} warnings and errors, ${quiet.length} other lines)`);
  if (!logs.length) out.push('  nothing');
  for (const l of grouped(loud).slice(-40)) out.push(say(l, 400));
  const rest = grouped(quiet);
  for (const l of allLogs ? rest : rest.slice(-12)) out.push(say(l, 300));
  if (!allLogs && rest.length > 12) out.push(`  (${rest.length - 12} earlier lines: --all-logs)`);

  h('The game at the press');
  out.push(...describeState(state.atPress).map((l) => `  ${l}`));
  if (state.atEnd && !state.atEnd.error) {
    h('The game when the report was finished');
    out.push(...describeState(state.atEnd).map((l) => `  ${l}`));
  }
  if (r.hud?.atPress) {
    h('Text on screen at the press');
    out.push(
      ...r.hud.atPress
        .split('\n')
        .slice(0, 40)
        .map((l) => `  ${clip(l, 200)}`),
    );
  }

  const samples = timeline.samples ?? [];
  h('Where the player was (every second, every half second near the press)');
  const rows = timelineRows(samples, -Infinity, Infinity);
  out.push(...(rows.length ? rows : ['  (no samples)']));

  const events = (r.events ?? []).filter((e) => !(e.src === 'menu' && /^(up|down|left|right)$/.test(e.type)));
  const recent = events.filter((e) => e.t >= -12);
  h(
    `Events (${recent.length} from 12 s before the press on${events.length > recent.length ? `; ${events.length - recent.length} earlier in report.json` : ''})`,
  );
  for (const e of recent.slice(0, 160)) out.push(eventLine(e));
  if (recent.length > 160) out.push(`  (${recent.length - 160} more in report.json)`);

  h('Reproducing it');
  if (existsSync(join(dir, 'save.json'))) {
    out.push(
      `  save.json is the island exactly as it was at the press. In a Playwright spec:`,
      `    await page.addInitScript((s) => localStorage.setItem('ruina.emberholm.v1', s), readFileSync('${rel(join(dir, 'save.json'))}', 'utf8'));`,
      `    await page.goto('/?world&test&load');   // then __game.teleport(x, z), __game.advance(frames, actions), __game.lifeCommand(...)`,
    );
  } else out.push('  (no save: this was not the open world)');
  const inp = timeline.inputs;
  if (inp?.runs?.length)
    out.push(
      `  timeline.json has every input from sim frame ${inp.fromFrame} (${sec(inp.fromT)}) as [steps, actions] runs: for (const [n, a] of runs) await __game.advance(n, a).`,
    );
  out.push(
    `  The history starts ${Math.abs(r.covers?.from ?? 0).toFixed(1)} s before the press, in the middle of whatever was happening, so replayed inputs show what was pressed rather than replaying the bug exactly.`,
  );

  h('Files');
  const files = [];
  const walk = (d0, prefix = '') => {
    for (const f of readdirSync(d0)) {
      const p = join(d0, f);
      if (statSync(p).isDirectory()) {
        const n = readdirSync(p).length;
        files.push(`${prefix}${f}/ (${n} files)`);
      } else files.push(`${prefix}${f} ${size(statSync(p).size)}`);
    }
  };
  walk(dir);
  out.push(`  ${files.join(' · ')}`);
  console.log(out.join('\n'));
}

// ---------- frames ----------

function frames(q) {
  const from = Number(opts.from ?? -Infinity);
  const to = Number(opts.to ?? Infinity);
  const every = Number(opts.every ?? 0);
  const x = find(q);
  const list = (x.r?.frames ?? []).filter((f) => f.t >= from && f.t <= to);
  let last = -Infinity;
  let n = 0;
  for (const f of list) {
    if (f.t - last < every) continue;
    last = f.t;
    n++;
    console.log(`${rel(join(x.dir, f.file))}   ${sec(f.t)}   sim frame ${f.frame}`);
  }
  if (!n) console.log(`No frames between ${sec(from)} and ${sec(to)} (the report covers ${sec(x.r?.covers?.from)} to ${sec(x.r?.covers?.to)}).`);
}

// ---------- transcribe ----------

function which(bin) {
  const r = spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

function whisperModel() {
  const env = process.env.WHISPER_MODEL;
  if (env && existsSync(env)) return env;
  const home = homedir();
  const dirs = [
    join(home, '.cache', 'whisper.cpp'),
    join(home, '.cache', 'whisper'),
    join(home, 'Library', 'Application Support', 'whisper.cpp'),
    '/opt/homebrew/share/whisper-cpp',
    '/opt/homebrew/share/whisper.cpp/models',
    '/usr/local/share/whisper-cpp',
  ];
  const prefer = [
    'ggml-small.en.bin',
    'ggml-base.en.bin',
    'ggml-medium.en.bin',
    'ggml-small.bin',
    'ggml-base.bin',
    'ggml-large-v3-turbo.bin',
    'ggml-tiny.en.bin',
  ];
  for (const p of prefer) for (const d of dirs) if (existsSync(join(d, p))) return join(d, p);
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    const any = readdirSync(d).find((f) => /^ggml-.*\.bin$/.test(f));
    if (any) return join(d, any);
  }
  return '';
}

/** Names from the game, so whisper spells them right. */
function vocabulary() {
  const zone = readJson(join(ROOT, 'shared', 'zones', 'emberholm.json'), {});
  const names = [...(zone.places ?? []).map((p) => p.name), ...(zone.npcs ?? []).map((n) => n.name)].filter(Boolean);
  return ['Emberholm', ...new Set(names), 'glider', 'roadster', 'sloop', 'cog', 'scarecrow', 'labor', 'trade pack', 'hotbar', 'dummy', 'slime'].join(', ');
}

function transcribe(q) {
  const x = find(q);
  if (x.broken) die(`${x.id}: ${x.broken}`);
  const wav = join(x.dir, 'voice.wav');
  if (!existsSync(wav)) die(`${x.id} has no voice recording.`);
  const bin = which('whisper-cli') || which('whisper-cpp');
  const model = whisperModel();
  if (!bin || !model) {
    die(
      [
        `whisper.cpp ${bin ? 'has no model downloaded' : 'is not installed'}, so voice.wav can't be transcribed here. To set it up (about 150 MB):`,
        ...(bin ? [] : ['  brew install whisper-cpp']),
        '  mkdir -p ~/.cache/whisper.cpp && curl -L -o ~/.cache/whisper.cpp/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
      ].join('\n'),
      2,
    );
  }
  const lang = /\.en\.bin$/.test(model) ? 'en' : String(x.r.description?.lang ?? 'auto').split('-')[0] || 'auto';
  const base = join(x.dir, 'whisper');
  const run = spawnSync(bin, ['-m', model, '-f', wav, '-l', lang, '-oj', '-of', base, '-np', '--prompt', vocabulary()], { encoding: 'utf8' });
  const out = readJson(`${base}.json`);
  if (run.status !== 0 || !out) die(`whisper failed (exit ${run.status}): ${clip((run.stderr || run.stdout || '').trim(), 800)}`);
  const start = x.r.voice?.startsAt ?? 0;
  const segments = (out.transcription ?? [])
    .map((s) => ({ t0: num(start + (s.offsets?.from ?? 0) / 1000), t1: num(start + (s.offsets?.to ?? 0) / 1000), text: String(s.text ?? '').trim() }))
    .filter((s) => s.text && !/^\[.*\]$/.test(s.text));
  x.r.description = { ...x.r.description, whisper: { model: model.split('/').pop(), segments, text: segments.map((s) => s.text).join(' ') } };
  writeFileSync(join(x.dir, 'report.json'), JSON.stringify(x.r, null, 1));
  const lines = segments.map((s) => `[${sec(s.t0)}] ${s.text}`);
  writeFileSync(
    join(x.dir, 'transcript.txt'),
    `${readFileSync(join(x.dir, 'transcript.txt'), 'utf8').trimEnd()}\n\nwhisper.cpp (${model.split('/').pop()}):\n${lines.join('\n')}\n`,
  );
  console.log(lines.length ? lines.join('\n') : '(whisper heard nothing)');
}

// ---------- close / reopen ----------

function close(q, status, note) {
  const x = find(q, { closed: false });
  if (!STATUSES.includes(status)) die(`How was it resolved? One of: ${STATUSES.join(', ')}.`);
  if (!note || note === true) die(`Say what was done: node tools/bugs.mjs close ${x.id} ${status} "what was wrong and what changed"`);
  const r = x.r ?? { broken: x.broken };
  r.status = status;
  r.resolution = {
    status,
    note,
    closedAt: new Date().toISOString(),
    commit: git(['rev-parse', 'HEAD']) || null,
    uncommitted: git(['status', '--porcelain']) !== '',
  };
  writeFileSync(join(x.dir, 'report.json'), JSON.stringify(r, null, 1));
  mkdirSync(CLOSED, { recursive: true });
  const to = join(CLOSED, x.id);
  renameSync(x.dir, to);
  console.log(`Closed ${x.id} as ${status}; it is now in ${rel(to)}/`);
}

function reopen(q) {
  const x = find(q);
  if (!x.closed) die(`${x.id} is already open.`);
  const r = x.r ?? {};
  r.previously = [...(r.previously ?? []), r.resolution].filter(Boolean);
  delete r.resolution;
  r.status = 'open';
  writeFileSync(join(x.dir, 'report.json'), JSON.stringify(r, null, 1));
  renameSync(x.dir, join(DIR, x.id));
  console.log(`Reopened ${x.id}.`);
}

// ---------- main ----------

const [cmd, ...rest] = argv;
switch (cmd) {
  case 'list':
  case undefined:
    list();
    break;
  case 'show':
    show(rest[0]);
    break;
  case 'frames':
    frames(rest[0]);
    break;
  case 'transcribe':
    transcribe(rest[0]);
    break;
  case 'close':
    close(rest[0], rest[1], rest.slice(2).join(' '));
    break;
  case 'reopen':
    reopen(rest[0]);
    break;
  default:
    die(`Unknown command "${cmd}". Commands: list, show, frames, transcribe, close, reopen (see the top of tools/bugs.mjs).`);
}
