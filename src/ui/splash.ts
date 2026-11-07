import { loader, onLoaded } from '../assets/loader';
import './theme/front.css';

// The title screen. index.html draws its first frame before any of the game's code arrives: a dusk
// sky over Emberholm's spire, the name, embers, and a loading bar. This takes it over: the bar
// follows the real steps of loading, signing in and picking a character happen on it (cards on
// `layer`, scaled like the rest of the UI), and once the island is built and drawn, and the files it
// can't be drawn without have arrived, it fades into the game. Going in, the bar's last part fills as
// those files arrive, and under it is how much of them has (src/assets/loader.ts).
// The offline modes (?test, ?offline) never show it (index.html decides): `splash` is null there.

/**
 * The steps of loading and their share of the bar (the page itself is the first 5%). They can end
 * in any order: the hero loads while you sign in and choose a character.
 */
const STEPS = {
  /** The title screen's code arrived (this module is running: src/app/boot.ts). */
  bundle: 0.15,
  /** The game server answered. */
  server: 0.08,
  /** The rest of the game's code, with its model library, arrived (src/main.ts, once a character is chosen). */
  models: 0.25,
  /** Going in: connected to the world. */
  joined: 0.07,
  /** The island's ground and colliders are built. */
  world: 0.1,
  /** Its scenery is built. */
  stage: 0.1,
  /** The first frames are drawn. */
  ready: 0.05,
} as const;
export type LoadStep = keyof typeof STEPS;
/** The share of the bar the files the zone can't be drawn without fill as they arrive, going in. */
const FILES = 0.15;

/** What index.html keeps on window: when the page started, and how to stop the embers. */
interface SplashGlobal {
  progress: number;
  started: number;
  stop?: () => void;
}

/** How long the intro takes to bring the name in (index.html's intro animations). */
const INTRO_MS = 1300;

export type SplashMode = 'title' | 'select' | 'entering';

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Splash {
  /** Where cards go: a layer on the UI's virtual screen, scaled like the rest of the UI. */
  readonly layer: HTMLElement;
  private bar: HTMLElement;
  private status: HTMLElement;
  private load: HTMLElement;
  /** How much of the files the zone can't be drawn without has arrived, under the bar, going in. */
  private bytes: HTMLElement;
  private reached = 0;
  /** The share of the step being worked on that the bar is creeping through. */
  private creeping = 0;
  /** The share of FILES filled so far. */
  private files = 0;
  /** Going in: the bytes of those files that had arrived before, not counted again. */
  private filesFrom: number | null = null;
  private done = new Set<LoadStep>();
  private gone = false;
  private stopCounting: () => void;

  constructor(
    readonly root: HTMLElement,
    private global: SplashGlobal | undefined,
  ) {
    this.layer = Object.assign(document.createElement('div'), { id: 'sp-ui' });
    root.append(this.layer);
    this.bar = root.querySelector('.sp-bar i') as HTMLElement;
    this.status = root.querySelector('.sp-status') as HTMLElement;
    this.load = root.querySelector('.sp-load') as HTMLElement;
    this.bytes = Object.assign(document.createElement('div'), { className: 'sp-bytes' });
    this.load.append(this.bytes);
    this.reached = global?.progress ?? 0;
    this.step('bundle');
    this.stopCounting = onLoaded(() => this.count());
  }

  /** A step of loading is done: its share of the bar fills. */
  step(s: LoadStep): void {
    if (this.done.has(s)) return;
    this.done.add(s);
    this.reached = Math.min(1, this.reached + STEPS[s]);
    this.creeping = 0;
    this.draw('');
  }

  /**
   * Working on `s` (a slow step, like building the island): the bar creeps most of the way through
   * its share over `seconds`, so it never looks stuck, and step() finishes it.
   */
  toward(s: LoadStep, seconds = 6): void {
    if (this.done.has(s)) return;
    this.creeping = STEPS[s] * 0.85;
    this.draw(`${seconds}s`);
  }

  /** The bar's width: the steps done, the one being worked on, and the files arrived. */
  private draw(transition: string | null = null): void {
    if (transition !== null) this.bar.style.transitionDuration = transition;
    this.bar.style.width = `${(Math.min(1, this.reached + this.creeping + this.files) * 100).toFixed(1)}%`;
  }

  /**
   * Going in, the files the zone can't be drawn without (the ground, the town's kit, your body) as
   * they arrive: their share of the bar, and how many megabytes under it. Never backwards.
   */
  private count(): void {
    if (this.filesFrom === null) return;
    const { wanted, done } = loader.loaded('front', 'zone');
    const left = wanted - done;
    const asked = wanted - this.filesFrom;
    const mb = (b: number) => (b / 1048576).toFixed(1);
    this.bytes.textContent = left > 0 ? `${mb(done - this.filesFrom)} of ${mb(asked)} MB` : '';
    if (asked <= 0) return;
    const share = FILES * Math.min(1, (done - this.filesFrom) / asked);
    if (share > this.files) {
      this.files = share;
      this.draw();
    }
  }

  /** Whether a step of loading is done. */
  has(s: LoadStep): boolean {
    return this.done.has(s);
  }

  /** How far along loading is, 0..1 (tests and screenshots). */
  get progress(): number {
    return Math.min(1, this.reached + this.files);
  }

  /** What's happening now, over the bar. */
  say(text: string): void {
    this.status.textContent = text;
  }

  /** The bar shows while something loads, and not while the player is busy with a card. */
  showBar(on: boolean): void {
    this.load.classList.toggle('off', !on);
  }

  /** The title look, the character select look (the name moves up out of the way), or going in. */
  setMode(mode: SplashMode): void {
    this.root.dataset.mode = mode;
    // Going in, the files count from here (the hero's, fetched for character select, are in already).
    if (mode === 'entering' && this.filesFrom === null) {
      this.filesFrom = loader.loaded('front', 'zone').done;
      this.count();
    }
  }

  /**
   * Resolves once the intro has brought the name in, so a card doesn't arrive in the middle of it
   * (at once when there was no intro: a reload, or reduced motion).
   */
  afterIntro(): Promise<void> {
    if (document.documentElement.classList.contains('splash-quick') || reducedMotion()) return Promise.resolve();
    const left = INTRO_MS - (performance.now() - (this.global?.started ?? 0));
    return left > 0 ? new Promise((resolve) => setTimeout(resolve, left)) : Promise.resolve();
  }

  /**
   * Lets the browser draw the bar before a long step that holds up the page. In a background tab
   * (no frames drawn there) it goes on anyway, so loading doesn't stop while you look elsewhere.
   */
  paint(): Promise<void> {
    return new Promise((resolve) => {
      const hidden = setTimeout(resolve, 60);
      requestAnimationFrame(() => {
        clearTimeout(hidden);
        setTimeout(resolve, 0);
      });
    });
  }

  /** Fades into the game, then goes for good (the embers stop with it). */
  async fadeOut(): Promise<void> {
    if (this.gone) return;
    this.gone = true;
    this.step('ready');
    this.root.classList.add('sp-gone');
    await new Promise((r) => setTimeout(r, reducedMotion() ? 0 : 1150));
    this.global?.stop?.();
    this.stopCounting();
    this.root.remove();
  }
}

function find(): Splash | null {
  const root = document.getElementById('splash');
  if (!root || !document.documentElement.classList.contains('splash')) return null;
  return new Splash(root, (window as unknown as { __splash?: SplashGlobal }).__splash);
}

/** The title screen, while there is one: null in automated tests and on the battlefield. */
export const splash: Splash | null = find();
