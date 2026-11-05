import './theme/front.css';

// The title screen. index.html draws its first frame before any of the game's code arrives: a dusk
// sky over Emberholm's spire, the name, embers, and a loading bar. This takes it over: the bar
// follows the real steps of loading, signing in and picking a character happen on it (cards on
// `layer`, scaled like the rest of the UI), and once the island is built and drawn it fades into
// the game. Automated tests and the battlefield never show it (index.html decides): `splash` is
// null there.

/**
 * The steps of loading and their share of the bar (the page itself is the first 5%). They can end
 * in any order: the models load while you sign in and choose a character.
 */
const STEPS = {
  /** The game's code arrived (this module is running). */
  bundle: 0.15,
  /** The game server answered. */
  server: 0.08,
  /** The island's models are loaded. */
  models: 0.3,
  /** Going in: connected to the world. */
  joined: 0.07,
  /** The island's ground and colliders are built. */
  world: 0.12,
  /** Its scenery is built. */
  stage: 0.13,
  /** The first frames are drawn. */
  ready: 0.1,
} as const;
export type LoadStep = keyof typeof STEPS;

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
  private reached = 0;
  private done = new Set<LoadStep>();
  private gone = false;

  constructor(
    readonly root: HTMLElement,
    private global: SplashGlobal | undefined,
  ) {
    this.layer = Object.assign(document.createElement('div'), { id: 'sp-ui' });
    root.append(this.layer);
    this.bar = root.querySelector('.sp-bar i') as HTMLElement;
    this.status = root.querySelector('.sp-status') as HTMLElement;
    this.load = root.querySelector('.sp-load') as HTMLElement;
    this.reached = global?.progress ?? 0;
    this.step('bundle');
  }

  /** A step of loading is done: its share of the bar fills. */
  step(s: LoadStep): void {
    if (this.done.has(s)) return;
    this.done.add(s);
    this.reached = Math.min(1, this.reached + STEPS[s]);
    this.bar.style.transitionDuration = '';
    this.bar.style.width = `${(this.reached * 100).toFixed(1)}%`;
  }

  /**
   * Working on `s` (a slow step, like building the island): the bar creeps most of the way through
   * its share over `seconds`, so it never looks stuck, and step() finishes it.
   */
  toward(s: LoadStep, seconds = 6): void {
    if (this.done.has(s)) return;
    this.bar.style.transitionDuration = `${seconds}s`;
    this.bar.style.width = `${(Math.min(1, this.reached + STEPS[s] * 0.85) * 100).toFixed(1)}%`;
  }

  /** Whether a step of loading is done. */
  has(s: LoadStep): boolean {
    return this.done.has(s);
  }

  /** How far along loading is, 0..1 (tests and screenshots). */
  get progress(): number {
    return this.reached;
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
