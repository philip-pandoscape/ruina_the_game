import type { LifeEvent } from '../../sim/life/life';
import type { Actions, GameEvent } from '../../sim/types';
import { FrameGrabber, hudText, screenshot, type Screenshot } from './capture';
import { errors, logs, recordError } from './logs';
import { BugOverlay, type Keys } from './overlay';
import { TimeRing } from './ring';
import { pickMime, stopRecorder, toWav, Voice } from './voice';

// Bug reports, recorded while playing.
//
// All the time, cheaply: the last 30 seconds of small JPEGs of the 3D view, the player's state ten
// times a second, every input the rules saw, game events, console output and errors.
// Press \ (or click both sticks): that history is kept, a screenshot with the HUD is taken, and the
// microphone and the 3D view are recorded while you say what went wrong (and show it, if you can).
// Press it again: everything goes to the dev server, which writes it to bugs/<when>-<what>/, where
// `/fix-bugs` in Claude Code picks it up. Backspace twice throws a report away.
//
// Reports are only ever sent to this game's own dev server (tools/bugReports.ts).

export interface BugDeps {
  canvas: HTMLCanvasElement;
  /** Everything worth knowing about the game right now: player, world, camera, panels, perf. */
  snapshot(): Record<string, unknown>;
  /** The island save in the same shape the browser keeps it (localStorage), or null. */
  save(): unknown;
  /** A few numbers about the player for the timeline (ten times a second). */
  sample(): Record<string, unknown>;
  device(): 'keyboard' | 'gamepad';
  /** Automated tests: reports go to test-results/bug-reports/ instead of bugs/. */
  test: boolean;
  /** Live transcription with the browser's speech recognition. */
  speech: boolean;
  lang: string;
}

export type BugPhase = 'idle' | 'starting' | 'recording' | 'finishing' | 'note' | 'saving';

const PREROLL_MS = 30_000;
const MAX_RECORDING_MS = 180_000;
const FRAME_MS_IDLE = 250; // 4 a second for the history before the press
const FRAME_MS_RECORDING = 500; // 2 a second while recording
const FRAME_WIDTH = 960;
const SAMPLE_EVERY = 6; // sim frames: 10 samples a second
const DISCARD_WINDOW_MS = 3000;
const ENDPOINT = '/__bugs';
export const REPORT_KEY = 'Backslash';
const DISCARD_KEY = 'Backspace';
const PAD_LS = 10;
const PAD_RS = 11;
const CHORD_MS = 350; // both sticks clicked within this of each other

const VIDEO_TYPES = [
  'video/mp4;codecs=avc1.42E01F,mp4a.40.2', // plays in QuickTime
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
];

interface OutFile {
  name: string;
  data: Blob | string;
}

interface Job {
  files: OutFile[];
  slug: string;
  id?: string;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function safe<T>(f: () => T, fallback: T): T {
  try {
    return f();
  } catch {
    return fallback;
  }
}

/** One sim step's input, without the fields at rest, in the shape __game.advance() takes. */
function encodeActions(a: Actions): string {
  const o: Partial<Record<keyof Actions, number | boolean>> = {};
  if (a.moveX || a.moveZ) {
    o.moveX = round3(a.moveX);
    o.moveZ = round3(a.moveZ);
  }
  if (a.stickX || a.stickY) {
    o.stickX = round3(a.stickX);
    o.stickY = round3(a.stickY);
  }
  if (a.aimX || a.aimZ) {
    o.aimX = round3(a.aimX);
    o.aimZ = round3(a.aimZ);
  }
  for (const k of ['jumpPressed', 'jumpHeld', 'attackPressed', 'slidePressed', 'sprintHeld', 'crouchHeld'] as const) if (a[k]) o[k] = true;
  for (const k of ['abilitySlot', 'movementSlot', 'movementHeld'] as const) if (a[k]) o[k] = a[k];
  return JSON.stringify(o);
}

/** A few words from what was said, for the report's folder name ("cart-rolled-off-the-pier"). */
export function slugFrom(text: string): string {
  const filler = new Set(['so', 'um', 'umm', 'uh', 'uhh', 'er', 'okay', 'ok', 'hey', 'alright', 'right', 'well', 'yeah', 'hi', 'hello', 'oh', 'and', 'now', 'the', 'a', 'an', 'like', 'basically']);
  const dangling = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'on', 'in', 'at', 'with', 'is', 'it', 'was', 'when', 'that', 'this', 'my', 'i', 'so']);
  const words = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (words.length && filler.has(words[0])) words.shift();
  const kept: string[] = [];
  for (const w of words.slice(0, 6)) {
    if (kept.join('-').length + w.length + 1 > 42) break;
    kept.push(w);
  }
  while (kept.length > 1 && dangling.has(kept[kept.length - 1])) kept.pop();
  return kept.join('-');
}

export class BugReporter {
  phase: BugPhase = 'idle';
  lastSaved: { id: string; path: string } | null = null;
  lastError = '';
  private overlay = new BugOverlay();
  private grabber = new FrameGrabber();
  private frames = new TimeRing<{ blob: Blob; frame: number }>(PREROLL_MS, 1200);
  private samples = new TimeRing<Record<string, unknown>>(PREROLL_MS, 4000);
  private events = new TimeRing<Record<string, unknown>>(PREROLL_MS, 6000);
  private inputs = new TimeRing<{ f: number; a: string }>(PREROLL_MS, 20_000);
  private rings = [this.frames, this.samples, this.events, this.inputs];
  private simFrame = 0;
  private lastFrameAt = -1e9;
  private lastRenderAt = 0;
  private worstGap = 0;
  private shotWaiters: Array<(s: Screenshot | null) => void> = [];
  private keyLabel = '\\';
  private pad = { ls: false, rs: false, lsAt: -1e9, rsAt: -1e9 };
  private uiTimer = 0;
  private outbox: Job[] = [];
  private flushing = false;
  /** Why the dev server can't take reports, or '' if it can (checked at startup and each press). */
  private serverProblem = '';

  // The report being made.
  private pressAt = 0;
  private pressWall = 0;
  private endAt = 0;
  private atPress: Record<string, unknown> | null = null;
  /** The island save at the press, already serialized: the live state keeps changing. */
  private saveAtPress: string | null = null;
  private hudAtPress = '';
  private shotAtPress: Promise<Screenshot | null> | null = null;
  private voice: Voice | null = null;
  private video: MediaRecorder | null = null;
  private videoChunks: Blob[] = [];
  private videoStartedAt = 0;
  private videoError = '';
  private discardArmed = -1e9;

  constructor(private readonly d: BugDeps) {
    addEventListener('keydown', (e) => this.onKey(e), { capture: true });
    window.setInterval(() => this.pollPad(), 40);
    addEventListener('beforeunload', (e) => {
      // A reload (Vite does one whenever code changes) would lose a report in progress.
      if (this.phase === 'idle' && !this.outbox.length) return;
      e.preventDefault();
      e.returnValue = '';
    });
    void this.checkServer();
    d.canvas.addEventListener('webglcontextlost', () => recordError('webgl', 'The WebGL context was lost: the 3D view stopped drawing.'));
    d.canvas.addEventListener('webglcontextrestored', () => this.note('webgl', { type: 'contextRestored' }));
    // Show the key as this keyboard labels it: the key next to Return reads \ only on US layouts.
    const kb = (navigator as unknown as { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard;
    kb?.getLayoutMap?.()
      .then((m) => {
        const k = m.get(REPORT_KEY);
        if (k) this.keyLabel = k;
      })
      .catch(() => {});
  }

  /** What the report key is labelled on this keyboard. */
  get key(): string {
    return this.keyLabel;
  }

  // ---------- Hooks the game loop calls ----------

  /** After every sim step: what the rules were given and what came of it. */
  step(frame: number, actions: Actions, events: readonly GameEvent[], lifeEvents: readonly LifeEvent[]): void {
    const now = performance.now();
    this.simFrame = frame;
    this.inputs.push(now, { f: frame, a: encodeActions(actions) });
    for (const e of events) this.events.push(now, { src: 'sim', ...e });
    for (const e of lifeEvents) {
      const { t: type, ...rest } = e;
      this.events.push(now, { src: 'life', type, ...rest });
    }
    if (frame % SAMPLE_EVERY === 0) {
      const s = safe(() => this.d.sample(), {} as Record<string, unknown>);
      // The longest gap between drawn frames since the last sample, when it was a visible hitch.
      if (this.worstGap > 34) s.hitchMs = Math.round(this.worstGap);
      this.worstGap = 0;
      this.samples.push(now, s);
    }
  }

  /** Anything else worth having in the event log: a key the game acted on, a command it queued. */
  note(src: string, data: Record<string, unknown>): void {
    this.events.push(performance.now(), { src, ...data });
  }

  /** Right after the 3D view was drawn: the only moment its pixels can be read. */
  afterRender(): void {
    const now = performance.now();
    if (this.lastRenderAt) this.worstGap = Math.max(this.worstGap, now - this.lastRenderAt);
    this.lastRenderAt = now;
    if (this.shotWaiters.length) {
      const waiters = this.shotWaiters;
      this.shotWaiters = [];
      screenshot(this.d.canvas, [this.overlay.root]).then(
        (s) => waiters.forEach((w) => w(s)),
        () => waiters.forEach((w) => w(null)),
      );
    }
    if (this.phase !== 'idle' && this.phase !== 'starting' && this.phase !== 'recording') return;
    if (now - this.lastFrameAt < (this.phase === 'idle' ? FRAME_MS_IDLE : FRAME_MS_RECORDING) || document.hidden) return;
    this.lastFrameAt = now;
    const frame = this.simFrame;
    void this.grabber.grab(this.d.canvas, FRAME_WIDTH).then((blob) => {
      if (blob) this.frames.push(now, { blob, frame });
    });
  }

  // ---------- Controls ----------

  /** The report key: start a report, or finish the one being recorded. */
  toggle(): void {
    if (this.phase === 'idle') void this.start();
    else if (this.phase === 'starting' || this.phase === 'recording') void this.finish();
  }

  /** Throws away the report being recorded. */
  discard(): void {
    if (this.phase !== 'starting' && this.phase !== 'recording') return;
    this.phase = 'idle';
    clearInterval(this.uiTimer);
    void this.voice?.stop();
    this.voice = null;
    const video = this.video;
    this.video = null;
    this.videoChunks = [];
    void stopRecorder(video, []).then(() => {
      for (const t of video?.stream.getTracks() ?? []) t.stop();
    });
    this.release();
    this.overlay.discarded();
  }

  /** For tests and the developer panel. */
  status() {
    return {
      phase: this.phase,
      lastSaved: this.lastSaved,
      lastError: this.lastError,
      unsent: this.outbox.length,
      framesBuffered: this.frames.since(0).length,
      key: this.keyLabel,
    };
  }

  private keys(): Keys {
    return { report: this.keyLabel, pad: this.d.device() === 'gamepad' };
  }

  private onKey(e: KeyboardEvent): void {
    const field = this.overlay.noteField;
    if (field && e.target === field) return; // typing a note
    if (e.code === REPORT_KEY && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.toggle();
    } else if (e.code === DISCARD_KEY && !e.repeat && (this.phase === 'recording' || this.phase === 'starting')) {
      e.preventDefault();
      if (performance.now() - this.discardArmed < DISCARD_WINDOW_MS) this.discard();
      else {
        this.discardArmed = performance.now();
        this.renderUi();
      }
    }
  }

  /** Clicking both sticks together, the controller's report button. */
  private pollPad(): void {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad: Gamepad | null = null;
    for (const p of pads) if (p && p.connected) pad = pad ?? p;
    if (!pad) return;
    const now = performance.now();
    const ls = !!pad.buttons[PAD_LS]?.pressed;
    const rs = !!pad.buttons[PAD_RS]?.pressed;
    const s = this.pad;
    if (ls && !s.ls) s.lsAt = now;
    if (rs && !s.rs) s.rsAt = now;
    // Holding one stick down to sprint and later clicking the other is not the chord.
    const chord = ls && rs && !(s.ls && s.rs) && Math.abs(s.lsAt - s.rsAt) < CHORD_MS;
    s.ls = ls;
    s.rs = rs;
    if (chord) this.toggle();
  }

  // ---------- Recording ----------

  /** A detached copy of the game's own description of itself (null if it couldn't give one). */
  private describeGame(): Record<string, unknown> | null {
    return safe(() => JSON.parse(JSON.stringify(this.d.snapshot())) as Record<string, unknown>, null);
  }

  private takeShot(): Promise<Screenshot | null> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (s: Screenshot | null) => {
        if (settled) return;
        settled = true;
        resolve(s);
      };
      this.shotWaiters.push(done);
      // If nothing is being drawn (a paused test, a background tab, a crashed loop), don't wait.
      setTimeout(() => done(null), 2000);
    });
  }

  /** Keeps everything from 30 s before the press for as long as the report is open. */
  private hold(from: number): void {
    for (const r of this.rings) r.pinnedFrom = from;
  }

  private release(): void {
    for (const r of this.rings) r.pinnedFrom = Infinity;
    this.atPress = null;
    this.saveAtPress = null;
    this.shotAtPress = null;
  }

  private async start(): Promise<void> {
    this.phase = 'starting';
    this.discardArmed = -1e9;
    this.pressAt = performance.now();
    this.pressWall = Date.now();
    this.endAt = 0;
    this.videoError = '';
    this.hold(this.pressAt - PREROLL_MS);
    this.note('report', { type: 'pressed' });
    // Copied now, not referenced: the game keeps running (and changing them) while you talk.
    this.atPress = this.describeGame() ?? { error: 'the game could not describe itself' };
    this.saveAtPress = safe(() => {
      const s = this.d.save();
      return s ? JSON.stringify(s) : null;
    }, null);
    this.hudAtPress = safe(() => hudText([this.overlay.root]), '');
    this.shotAtPress = this.takeShot();
    this.overlay.starting(this.keys());
    void this.checkServer();

    const voice = new Voice();
    this.voice = voice;
    voice.onChange = () => this.renderUi();
    const mic = await voice.open();
    // The key may have been pressed again (or the report thrown away) while the browser asked.
    if (this.phase !== 'starting' || this.voice !== voice) return;
    voice.start(this.d.speech, this.d.lang);
    this.startVideo(mic ? voice.stream : null);
    this.phase = 'recording';
    this.uiTimer = window.setInterval(() => {
      this.renderUi();
      if (performance.now() - this.pressAt > MAX_RECORDING_MS) void this.finish();
    }, 250);
    this.renderUi();
  }

  private startVideo(mic: MediaStream | null): void {
    const canvas = this.d.canvas;
    if (typeof MediaRecorder === 'undefined' || typeof canvas.captureStream !== 'function') {
      this.videoError = 'this browser cannot record the canvas';
      return;
    }
    try {
      const stream = canvas.captureStream(30);
      for (const t of mic?.getAudioTracks() ?? []) stream.addTrack(t);
      const mimeType = pickMime(VIDEO_TYPES);
      // This recorder's own list: a late chunk from a discarded one must not land in the next.
      const chunks: Blob[] = [];
      this.videoChunks = chunks;
      const rec = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 96_000 });
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.start(1000);
      this.video = rec;
      this.videoStartedAt = performance.now();
    } catch (e) {
      this.videoError = String(e);
      this.video = null;
    }
  }

  private renderUi(): void {
    if (this.phase === 'starting') return this.overlay.starting(this.keys());
    if (this.phase !== 'recording') return;
    const v = this.voice;
    const said = v ? v.segments.map((s) => s.text).join(' ') : '';
    this.overlay.recording({
      ms: performance.now() - this.pressAt,
      said: said.length > 220 ? `…${said.slice(-220)}` : said,
      interim: v?.interim ?? '',
      mic: v?.stream ? null : v?.micError || 'no microphone',
      keys: this.keys(),
      confirmDiscard: performance.now() - this.discardArmed < DISCARD_WINDOW_MS,
      warning: this.serverProblem,
    });
  }

  private async checkServer(): Promise<void> {
    try {
      const r = await fetch(`${ENDPOINT}/ping`, { cache: 'no-store' });
      const json = (r.headers.get('content-type') ?? '').includes('application/json');
      this.serverProblem = json && r.ok ? '' : 'This dev server can’t save reports yet: restart npm run dev, then finish.';
    } catch {
      this.serverProblem = 'The dev server isn’t answering: is npm run dev running?';
    }
  }

  private async finish(): Promise<void> {
    if (this.phase !== 'starting' && this.phase !== 'recording') return;
    this.phase = 'finishing';
    clearInterval(this.uiTimer);
    this.endAt = performance.now();
    this.note('report', { type: 'finished' });
    this.overlay.saving(0, 1);
    const shotAtEnd = this.takeShot();
    const atEnd = this.describeGame();
    const hudAtEnd = safe(() => hudText([this.overlay.root]), '');
    const voice = this.voice ?? new Voice();
    const video = this.video;
    this.video = null;
    const [audio, videoBlob] = await Promise.all([voice.stop(), stopRecorder(video, this.videoChunks)]);
    // The canvas keeps feeding a capture track until it is stopped.
    for (const t of video?.stream.getTracks() ?? []) t.stop();
    let note = '';
    if (!voice.stream) {
      this.phase = 'note';
      note = await this.overlay.askNote(voice.micError ? `No voice was recorded: ${voice.micError}.` : 'No voice was recorded.');
    }
    this.phase = 'saving';
    this.overlay.saving(0, 1);
    let job: Job;
    try {
      job = await this.assemble(voice, audio, videoBlob, note, atEnd, hudAtEnd, shotAtEnd);
    } catch (e) {
      this.lastError = `could not put the report together: ${String(e)}`;
      this.overlay.failed(this.lastError, false);
      this.phase = 'idle';
      this.release();
      return;
    }
    this.voice = null;
    this.release();
    this.outbox.push(job);
    this.phase = 'idle';
    await this.flush();
  }

  private async assemble(
    voice: Voice,
    audio: Blob | null,
    video: Blob | null,
    note: string,
    atEnd: Record<string, unknown> | null,
    hudAtEnd: string,
    shotAtEnd: Promise<Screenshot | null>,
  ): Promise<Job> {
    const t0 = this.pressAt;
    const from = t0 - PREROLL_MS;
    const end = this.endAt;
    const rel = (t: number) => round2((t - t0) / 1000);
    const inWindow = (t: number) => t >= from && t <= end + 100;
    const files: OutFile[] = [];

    const frames = this.frames.since(from).filter((f) => inWindow(f.t));
    const frameIndex = frames.map((f, i) => {
      const file = `frames/${String(i + 1).padStart(4, '0')}.jpg`;
      files.push({ name: file, data: f.v.blob });
      return { file, t: rel(f.t), frame: f.v.frame };
    });

    // The screenshot at the press; if the game wasn't drawing, the last frame before it.
    let press = await this.shotAtPress;
    if (!press) {
      const before = frames.filter((f) => f.t <= t0).pop();
      if (before) press = { blob: before.v.blob, hud: false };
    }
    const endShot = await shotAtEnd;
    if (press) files.push({ name: 'screenshot.jpg', data: press.blob });
    if (endShot) files.push({ name: 'screenshot-end.jpg', data: endShot.blob });

    const wav = audio ? await toWav(audio) : null;
    if (wav) files.push({ name: 'voice.wav', data: wav.wav });
    const videoFile = video ? `video.${video.type.includes('mp4') ? 'mp4' : 'webm'}` : '';
    if (video) files.push({ name: videoFile, data: video });

    const transcript = voice.segments.map((s) => ({ t0: rel(s.t0), t1: rel(s.t1), text: s.text, ...(s.confidence ? { confidence: round2(s.confidence) } : {}), ...(s.partial ? { partial: true } : {}) }));
    const said = transcript.map((s) => s.text).join(' ');
    const save = this.saveAtPress;
    const perf = (this.atPress?.perf ?? {}) as Record<string, unknown>;
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const firstSeen = Math.min(...this.rings.map((r) => r.oldest), t0);

    const report = {
      format: 1,
      status: 'open',
      recordedAt: new Date(this.pressWall).toISOString(),
      localTime: new Date(this.pressWall).toString(),
      timeNote: 'Times (t) are seconds from the moment the report key was pressed; negative is before it.',
      covers: { from: rel(Math.max(from, firstSeen)), to: rel(end) },
      description: {
        said,
        note,
        transcript,
        engine: this.d.speech && voice.speechStatus !== 'unavailable' ? 'browser speech recognition (live)' : null,
        lang: this.d.lang,
        speechStatus: voice.speechStatus,
      },
      voice: wav
        ? { file: 'voice.wav', startsAt: rel(voice.startedAt), seconds: round2(wav.seconds), peak: round3(wav.peak), rms: round3(wav.rms), silent: wav.peak < 0.02 }
        : { file: null, why: voice.micError || (audio ? 'the recording could not be decoded' : 'nothing was recorded') },
      video: video ? { file: videoFile, type: video.type, startsAt: rel(this.videoStartedAt), bytes: video.size } : { file: null, why: this.videoError || 'nothing was recorded' },
      screenshots: {
        press: press ? { file: 'screenshot.jpg', hud: press.hud } : null,
        end: endShot ? { file: 'screenshot-end.jpg', hud: endShot.hud } : null,
      },
      frames: frameIndex,
      framesNote: 'frames/ are the 3D view only (no HUD): 4 a second before the press, 2 a second after.',
      page: { url: location.href, title: document.title, mode: this.atPress?.mode ?? null },
      environment: {
        userAgent: navigator.userAgent,
        language: navigator.language,
        viewport: [innerWidth, innerHeight],
        devicePixelRatio,
        screen: [screen.width, screen.height],
        cores: navigator.hardwareConcurrency,
        gpu: perf.gpu ?? null,
        heapMB: memory ? Math.round(memory.usedJSHeapSize / 1048576) : null,
        device: this.d.device(),
      },
      errors: errors.map((e) => ({ ...e, t: rel(e.t) })),
      console: logs.map((l) => ({ t: rel(l.t), level: l.level, text: l.text })),
      events: this.events
        .since(from)
        .filter((e) => inWindow(e.t))
        .map((e) => ({ t: rel(e.t), ...e.v })),
      hud: { atPress: this.hudAtPress, atEnd: hudAtEnd },
      files: { state: 'state.json', timeline: 'timeline.json', save: save ? 'save.json' : null, transcript: 'transcript.txt' },
    };

    const inputs = this.inputs.since(from).filter((e) => inWindow(e.t));
    const runs: Array<[number, Record<string, unknown>]> = [];
    let prev = '';
    for (const { v } of inputs) {
      if (v.a === prev && runs.length) runs[runs.length - 1][0]++;
      else {
        runs.push([1, JSON.parse(v.a) as Record<string, unknown>]);
        prev = v.a;
      }
    }
    const timeline = {
      note: 'samples: the player ten times a second (t = seconds from the press, f = sim frame). inputs: every sim step from fromFrame on, as [steps, actions] runs in the shape __game.advance(steps, actions) takes.',
      samples: this.samples
        .since(from)
        .filter((s) => inWindow(s.t))
        .map((s) => ({ t: rel(s.t), ...s.v })),
      inputs: { fromFrame: inputs[0]?.v.f ?? null, fromT: inputs.length ? rel(inputs[0].t) : null, runs },
    };

    const lines = [
      `Bug report recorded ${report.localTime}`,
      'Times are seconds from the moment the report key was pressed.',
      '',
      ...transcript.map((s) => `[${s.t0 >= 0 ? '+' : ''}${s.t0.toFixed(1)}s] ${s.text}${s.partial ? ' (cut off)' : ''}`),
      ...(transcript.length ? [] : [wav ? '(Nothing was transcribed. voice.wav has the recording: node tools/bugs.mjs transcribe <id>.)' : '(No voice was recorded.)']),
      ...(note ? ['', `Typed note: ${note}`] : []),
      '',
    ];

    files.push({ name: 'report.json', data: JSON.stringify(report, null, 1) });
    files.push({ name: 'state.json', data: JSON.stringify({ atPress: this.atPress, atEnd }, null, 1) });
    files.push({ name: 'timeline.json', data: JSON.stringify(timeline) });
    files.push({ name: 'transcript.txt', data: lines.join('\n') });
    if (save) files.push({ name: 'save.json', data: save });
    return { files, slug: slugFrom(note || said) };
  }

  // ---------- Saving ----------

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.outbox.length) {
        const job = this.outbox[0];
        try {
          const saved = await this.upload(job);
          this.outbox.shift();
          this.lastSaved = saved;
          this.lastError = '';
          if (this.phase === 'idle') this.overlay.saved(saved.path);
          console.info(`Bug report saved to ${saved.path}`);
        } catch (e) {
          this.lastError = e instanceof Error ? e.message : String(e);
          if (this.phase === 'idle') this.overlay.failed(this.lastError, true);
          await sleep(4000);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private async upload(job: Job): Promise<{ id: string; path: string }> {
    const headers = { 'x-bug-report': '1' };
    const call = async (url: string, init: RequestInit): Promise<Record<string, unknown>> => {
      let r: Response;
      try {
        r = await fetch(url, init);
      } catch {
        throw new Error('the dev server is not answering');
      }
      const text = await r.text();
      // Anything but JSON is a server without tools/bugReports.ts: a dev server started before it
      // existed, or not the dev server at all.
      if (!(r.headers.get('content-type') ?? '').includes('application/json')) {
        throw new Error('this server does not save bug reports: restart npm run dev (it picks up vite.config.ts when it starts)');
      }
      if (!r.ok) throw new Error(`the dev server said ${r.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text) as Record<string, unknown>;
    };
    if (!job.id) {
      const begin = await call(`${ENDPOINT}/begin`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ slug: job.slug, test: this.d.test }) });
      job.id = String(begin.id);
    }
    const id = job.id;
    const queue = [...job.files];
    const total = queue.length + 1;
    let done = 0;
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        try {
          await call(`${ENDPOINT}/${id}/${f.name}`, { method: 'PUT', headers, body: f.data });
        } catch (e) {
          // The server forgot this report (it restarted): start a new one next time.
          if (String(e).includes(' 404')) job.id = undefined;
          throw e;
        }
        done++;
        if (this.phase === 'idle') this.overlay.saving(done, total);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    const end = await call(`${ENDPOINT}/${id}/done`, { method: 'POST', headers });
    return { id, path: String(end.path ?? `bugs/${id}`) };
  }
}
