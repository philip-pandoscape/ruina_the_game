import { expect, test, type Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// In-game bug reports (src/app/bugs/, tools/bugReports.ts, tools/bugs.mjs). \ starts a report and
// \ again saves it through the dev server, which is what these tests press. The whole path runs:
// frames from before the press, a screenshot with the HUD, voice, live transcript, video, state,
// the island save, and the CLI that /fix-bugs reads reports with. Test reports land in
// test-results/bug-reports/, never in bugs/.
//
// The microphone and the speech recognizer are stand-ins injected into the page. Chromium's own
// fake audio device hangs on macOS (the OS gates audio capture for the test browser), and real
// speech recognition needs Google's servers. The stand-in microphone plays a spoken sentence (made
// with macOS's `say`; elsewhere a tone), so the recording, its WAV and the video are all real.

const REPORTS = join('test-results', 'bug-reports');

function spokenWav(): string | null {
  if (process.platform !== 'darwin') return null;
  const file = join(tmpdir(), 'ruina-bug-voice.wav');
  const r = spawnSync('say', ['-o', file, '--file-format=WAVE', '--data-format=LEI16@16000', 'The cart rolled off the pier and sank into the harbour.']);
  return r.status === 0 && existsSync(file) ? readFileSync(file).toString('base64') : null;
}
const VOICE = spokenWav();

test.use({
  launchOptions: { args: ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] },
});

/** A microphone made of Web Audio, and a speech recognizer that "hears" two phrases. */
function standIns(voiceB64: string | null): void {
  const w = window as any;
  navigator.mediaDevices.getUserMedia = async (c?: MediaStreamConstraints) => {
    if (!c?.audio || c.video) throw new DOMException('only the microphone is faked', 'NotSupportedError');
    const ctx = new AudioContext();
    await ctx.resume();
    const dest = ctx.createMediaStreamDestination();
    if (voiceB64) {
      const bytes = Uint8Array.from(atob(voiceB64), (ch) => ch.charCodeAt(0));
      const src = ctx.createBufferSource();
      src.buffer = await ctx.decodeAudioData(bytes.buffer);
      src.loop = true;
      src.connect(dest);
      src.start();
    } else {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.3;
      osc.connect(gain).connect(dest);
      osc.start();
    }
    w.__fakeMic = (w.__fakeMic ?? 0) + 1;
    return dest.stream;
  };
  const result = (text: string, isFinal: boolean, confidence = 0) => Object.assign([{ transcript: text, confidence }], { isFinal });
  w.webkitSpeechRecognition = w.SpeechRecognition = class {
    lang = '';
    continuous = false;
    interimResults = false;
    maxAlternatives = 1;
    onresult: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    private results: unknown[] = [];
    private timers: number[] = [];
    start(): void {
      w.__fakeSpeechLang = this.lang;
      // Each result comes a while after the one before it was heard, as speech does, so a page
      // that stalls (starting a report does, for a second or so) can't hear two at once.
      const script: Array<[number, string, boolean, number]> = [
        [0, 'the cart rolled', false, 300],
        [0, 'the cart rolled off the pier', true, 500],
        [1, 'and sank', false, 500],
      ];
      const say = (k: number) => {
        if (k >= script.length) return;
        const [i, text, isFinal, ms] = script[k];
        this.timers.push(
          window.setTimeout(() => {
            this.results[i] = result(text, isFinal, isFinal ? 0.93 : 0);
            this.onresult?.({ resultIndex: i, results: this.results });
            say(k + 1);
          }, ms),
        );
      };
      say(0);
    }
    stop(): void {
      for (const t of this.timers) clearTimeout(t);
      // Stopping finalises what was still being heard, then ends.
      window.setTimeout(() => {
        if (this.results[1]) {
          this.results[1] = result('and sank into the harbour', true, 0.81);
          this.onresult?.({ resultIndex: 1, results: this.results });
        }
        this.onend?.();
      }, 60);
    }
    abort(): void {
      for (const t of this.timers) clearTimeout(t);
      this.onend?.();
    }
  };
}

type Game = {
  bugs(): { phase: string; lastSaved: { id: string; path: string } | null; lastError: string; framesBuffered: number; unsent: number };
};

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.addInitScript(standIns, VOICE);
  await page.goto('/?world&test&bugs&buglang=en-GB');
  await page.waitForFunction(() => (window as any).__game?.ready === true, null, { timeout: 60_000 });
  await page.evaluate(() => (window as any).__game.reset());
  return errors;
}

const status = (page: Page) => page.evaluate(() => ((window as any).__game as Game).bugs());
const advance = (page: Page, frames: number, a: Record<string, unknown> = {}) => page.evaluate(([n, x]) => (window as any).__game.advance(n, x), [frames, a] as const);

/** Plays for about `ms` of real time: the reporter keeps history by the clock, not by frames. */
async function play(page: Page, ms: number, a: Record<string, unknown>): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await advance(page, 6, a);
    await page.waitForTimeout(90);
  }
}

const cli = (...args: string[]) => execFileSync('node', ['tools/bugs.mjs', '--dir', REPORTS, ...args], { encoding: 'utf8' });

test('a bug report keeps the moments before the key, records the voice, and saves everything', { tag: '@gpu' }, async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await open(page);
  // Walk north for a while: that is the history the report should start with.
  await play(page, 2500, { moveZ: 1, stickY: 1 });
  expect((await status(page)).framesBuffered).toBeGreaterThan(5);
  const atPress = await page.evaluate(() => (window as any).__game.state().player.pos);

  await page.keyboard.press('Backslash');
  await expect.poll(async () => (await advance(page, 1), (await status(page)).phase), { timeout: 10_000 }).toBe('recording');
  await expect(page.locator('#bug-overlay')).toContainText('Recording Bug Report');
  // Talk (the stand-in microphone) and walk east while recording. What is heard shows as it comes.
  await play(page, 1500, { moveX: 1, stickX: 1 });
  await expect(page.locator('#bug-overlay')).toContainText('the cart rolled off the pier');
  await play(page, 2000, { moveX: 1, stickX: 1 });
  await page.keyboard.press('Backslash');
  await expect
    .poll(
      async () => {
        await page.evaluate(() => (window as any).__game.render());
        return (await status(page)).lastSaved;
      },
      { timeout: 30_000 },
    )
    .not.toBeNull();
  const s = await status(page);
  expect(s.lastError).toBe('');
  await expect(page.locator('#bug-overlay')).toContainText('Bug Report Saved');
  const { id, path } = s.lastSaved!;
  expect(path).toBe(join(REPORTS, id));
  // The folder is named after what was said.
  expect(id).toMatch(/^\d{8}-\d{6}-cart-rolled-off-the-pier$/);
  const dir = join(REPORTS, id);
  const read = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));

  const report = read('report.json');
  expect(report.id).toBe(id);
  expect(report.status).toBe('open');
  // What was said, phrase by phrase, timed from the press; the last phrase was finished off when
  // the report was.
  const said = report.description.transcript as Array<{ t0: number; t1: number; text: string }>;
  expect(said.map((x) => x.text)).toEqual(['the cart rolled off the pier', 'and sank into the harbour']);
  expect(said[0].t0).toBeGreaterThan(0);
  expect(said[0].t1).toBeGreaterThan(said[0].t0);
  expect(said[1].t1).toBeGreaterThan(3);
  expect(report.description.said).toBe('the cart rolled off the pier and sank into the harbour');
  expect(report.description.lang).toBe('en-GB');
  expect(await page.evaluate(() => (window as any).__fakeSpeechLang)).toBe('en-GB');
  expect(report.git.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(report.covers.from).toBeLessThan(-2);
  expect(report.covers.to).toBeGreaterThan(3);

  // Frames from before and after the press, all on disk, all JPEGs.
  const frames = report.frames as Array<{ file: string; t: number }>;
  expect(frames.filter((f) => f.t < 0).length).toBeGreaterThan(5);
  expect(frames.filter((f) => f.t > 0).length).toBeGreaterThan(3);
  for (const f of frames) expect(readFileSync(join(dir, f.file)).subarray(0, 2).toString('hex')).toBe('ffd8');
  // The screenshot has the HUD drawn in.
  expect(report.screenshots.press).toEqual({ file: 'screenshot.jpg', hud: true });
  expect(statSync(join(dir, 'screenshot.jpg')).size).toBeGreaterThan(20_000);
  expect(report.screenshots.end?.file).toBe('screenshot-end.jpg');
  expect(report.hud.atPress).toContain('Landfall');

  // The voice: 16 kHz mono WAV, a few seconds long, not silence.
  expect(report.voice.file).toBe('voice.wav');
  const wav = readFileSync(join(dir, 'voice.wav'));
  expect(wav.subarray(0, 4).toString()).toBe('RIFF');
  expect(wav.readUInt16LE(22)).toBe(1);
  expect(wav.readUInt32LE(24)).toBe(16_000);
  expect(report.voice.seconds).toBeGreaterThan(2);
  expect(report.voice.silent).toBe(false);
  expect(readFileSync(join(dir, 'transcript.txt'), 'utf8')).toContain('Bug report recorded');
  // The video of the recording, with the voice in it.
  expect(report.video.file).toMatch(/^video\.(webm|mp4)$/);
  expect(statSync(join(dir, report.video.file)).size).toBeGreaterThan(10_000);

  // The state and the island save are from the press, not from when the report was finished.
  const state = read('state.json');
  expect(state.atPress.mode).toContain('open world');
  expect(state.atPress.player.pos.z).toBeCloseTo(atPress.z, 1);
  expect(state.atEnd.player.pos.x).not.toBeCloseTo(atPress.x, 0);
  const save = read('save.json');
  expect(save.state.version).toBeGreaterThan(0);
  expect(save.player.x).toBeCloseTo(atPress.x, 1);
  expect(save.player.z).toBeCloseTo(atPress.z, 1);

  // The timeline has the walk north before the press and east after it, input by input.
  const timeline = read('timeline.json');
  expect(timeline.samples.length).toBeGreaterThan(20);
  const runs = timeline.inputs.runs as Array<[number, Record<string, number>]>;
  expect(runs.some(([n, a]) => a.moveZ === 1 && n > 5)).toBe(true);
  expect(runs.some(([n, a]) => a.moveX === 1 && n > 5)).toBe(true);
  expect(report.events.some((e: { src: string; type: string }) => e.src === 'report' && e.type === 'pressed')).toBe(true);

  // The CLI /fix-bugs uses: list, a digest, frames by time, and closing.
  expect(cli('list')).toContain(id);
  // Paths in it use this machine's separator.
  const digest = cli('show', id).replaceAll('\\', '/');
  for (const part of ['## What was said', 'the cart rolled off the pier', '## Look at these pictures', 'screenshot.jpg', 'frames/0', '## The game at the press', 'open world', '## Where the player was', 'save.json'])
    expect(digest).toContain(part);
  expect(cli('frames', id, '--from', '-1', '--to', '1').trim().split('\n').length).toBeGreaterThan(1);
  cli('close', id, 'not-a-bug', 'automated test');
  expect(existsSync(join(REPORTS, 'closed', id, 'report.json'))).toBe(true);
  expect(cli('list')).not.toContain(id);
  expect(JSON.parse(readFileSync(join(REPORTS, 'closed', id, 'report.json'), 'utf8')).resolution.status).toBe('not-a-bug');
  expect(errors).toEqual([]);
});

test('backspace twice throws a report away, and nothing is saved', { tag: '@gpu' }, async ({ page }) => {
  const errors = await open(page);
  const count = () => (existsSync(REPORTS) ? readdirSync(REPORTS).filter((f) => f !== 'closed').length : 0);
  const before = count();
  await play(page, 600, {});
  await page.keyboard.press('Backslash');
  await expect.poll(async () => (await advance(page, 1), (await status(page)).phase), { timeout: 10_000 }).toBe('recording');
  await page.keyboard.press('Backspace');
  await expect(page.locator('#bug-overlay')).toContainText('again to discard');
  expect((await status(page)).phase).toBe('recording');
  await page.keyboard.press('Backspace');
  await expect.poll(async () => (await status(page)).phase).toBe('idle');
  await expect(page.locator('#bug-overlay')).toContainText('Discarded');
  await page.waitForTimeout(500);
  expect(count()).toBe(before);
  expect(errors).toEqual([]);
});

test('the dev server only takes bug reports from the game itself', async ({ request }) => {
  const game = { 'x-bug-report': '1' };
  // Without the header a page on another site could send, or from another site: refused.
  expect((await request.post('/__bugs/begin', { data: { test: true } })).status()).toBe(403);
  expect((await request.post('/__bugs/begin', { data: { test: true }, headers: { ...game, 'sec-fetch-site': 'cross-site' } })).status()).toBe(403);
  // Names are cleaned up, and nothing can be written outside the report's folder.
  const begin = await request.post('/__bugs/begin', { data: { slug: '../../Etc Passwd', test: true }, headers: game });
  expect(begin.status()).toBe(200);
  const { id, path } = await begin.json();
  expect(id).toMatch(/^\d{8}-\d{6}-etc-passwd$/);
  expect(path).toBe(join(REPORTS, id));
  for (const name of ['..%2F..%2Fescape.txt', 'frames%2F..%2F..%2Fescape.txt', '.hidden', 'a%20b.txt'])
    expect((await request.put(`/__bugs/${id}/${name}`, { data: 'x', headers: game })).status()).toBe(400);
  expect((await request.put(`/__bugs/not-an-id/x.txt`, { data: 'x', headers: game })).status()).toBe(400);
  expect((await request.put(`/__bugs/${id}/note.txt`, { data: 'hello', headers: game })).status()).toBe(200);
  expect(readFileSync(join(REPORTS, id, 'note.txt'), 'utf8')).toBe('hello');
  expect(existsSync('escape.txt') || existsSync(join('test-results', 'escape.txt'))).toBe(false);
  rmSync(join(REPORTS, id), { recursive: true, force: true });
});
