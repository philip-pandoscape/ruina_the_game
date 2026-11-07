// Full Keyboard: the game in full screen with the keyboard locked to it, on by itself. Going into the
// world (Enter World) puts the page in full screen, and so does a click into the game whenever it
// isn't (after a reload, or after stepping out). There, Chrome and Edge hand the page the keys a
// browser tab keeps for itself (Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Tab), so the game keeps them like any
// other (browserKeys.ts); the lock (navigator.keyboard.lock) adds Escape and the Windows key, so a tap
// of Escape is the game's and leaves the mouse where it is, and holding it steps out of full screen
// (the browser says so as it starts). Alt+Tab still switches windows. Firefox and Safari have no
// lock: their full screen is just that.
//
// Settings turns it off (and on again), kept in this browser; F11 goes in or out there and then. A
// browser driven by tests (navigator.webdriver) starts with it off, unless it turns it on, so a test's
// clicks don't change the window under it.

const KEY = 'ruina.fullKeyboard';

/** The keys locked to the game besides what full screen hands it: Escape, and the Windows (or Cmd) key. */
const LOCKED = ['Escape', 'MetaLeft', 'MetaRight'];

interface KeyboardLock {
  lock(codes?: string[]): Promise<void>;
  unlock(): void;
}

function keyboardLock(): KeyboardLock | null {
  const kb = (navigator as Navigator & { keyboard?: Partial<KeyboardLock> }).keyboard;
  return kb?.lock && kb.unlock ? (kb as KeyboardLock) : null;
}

function localStore(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null; // storage refused (a private window's settings)
  }
}

/** Whether Full Keyboard comes on by itself here: unless the player turned it off (or, in a test's browser, unless it turned it on). */
function autoOn(store: Storage | null): boolean {
  let kept: string | null = null;
  try {
    kept = store?.getItem(KEY) ?? null;
  } catch {
    /* storage refused: the default */
  }
  if (kept === 'off') return false;
  if (kept === 'on') return true;
  return !(typeof navigator !== 'undefined' && navigator.webdriver);
}

/**
 * Going into the world (Enter World, clicked or pressed): full screen at once if Full Keyboard is on,
 * so the world loads in it. The game's FullKeyboard locks the keys when it starts.
 */
export function enterWorldFullScreen(doc: Document = document, store: Storage | null = localStore()): void {
  if (!doc.fullscreenEnabled || doc.fullscreenElement || !autoOn(store)) return;
  doc.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {
    /* refused (no click just now): the first click into the game goes in */
  });
}

export class FullKeyboard {
  /** Full screen ended while Full Keyboard is on (Escape held, F11): a click on the game goes back. */
  onStepOut: (() => void) | null = null;
  /** The page is going (a reload): full screen ends with it, and that's no stepping out. */
  private leaving = false;

  constructor(
    private readonly doc: Document = document,
    private readonly store: Storage | null = localStore(),
    win: EventTarget = window,
  ) {
    doc.addEventListener('fullscreenchange', () => {
      if (this.on) void this.lock();
      else {
        keyboardLock()?.unlock();
        if (this.auto && !this.leaving) this.onStepOut?.();
      }
    });
    win.addEventListener('pagehide', () => {
      this.leaving = true;
    });
    // In full screen already (Enter World went in as the world loaded): the keys too.
    if (this.on) void this.lock();
  }

  /** Whether this browser lets the page go full screen. */
  get supported(): boolean {
    return !!this.doc.fullscreenEnabled;
  }

  get on(): boolean {
    return !!this.doc.fullscreenElement;
  }

  /** Whether it comes on by itself: going into the world, or a click into the game. */
  get auto(): boolean {
    return autoOn(this.store);
  }

  /**
   * Whether every key reaches the page before the browser: in full screen (ours, or the browser's
   * own F11), or with the game installed as an app, in a window of its own.
   */
  get keepsAll(): boolean {
    return this.on || (typeof matchMedia === 'function' && !matchMedia('(display-mode: browser)').matches);
  }

  /** Settings: on (and in, now) or off (and out, now), kept in this browser. */
  setAuto(on: boolean): void {
    try {
      this.store?.setItem(KEY, on ? 'on' : 'off');
    } catch {
      /* storage refused: for this page only */
    }
    if (on && !this.on) void this.enter();
    if (!on && this.on) void this.leave();
  }

  /** F11: in or out there and then; false where the page can't go full screen (F11 is the browser's). */
  toggle(): boolean {
    if (!this.supported) return false;
    void (this.on ? this.leave() : this.enter());
    return true;
  }

  async enter(): Promise<void> {
    await this.doc.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {
      /* refused: no click or key just now, or a frame that may not */
    });
  }

  async leave(): Promise<void> {
    keyboardLock()?.unlock();
    if (this.doc.fullscreenElement) await this.doc.exitFullscreen().catch(() => {});
  }

  /** A click on `target` (the game) goes into Full Keyboard while it's on and the page isn't full screen. */
  resumeOn(target: EventTarget): void {
    target.addEventListener('mousedown', () => {
      if (this.supported && !this.on && this.auto) void this.enter();
    });
  }

  /** Locked once in full screen; a refusal (an older browser) leaves full screen alone. */
  private async lock(): Promise<void> {
    await keyboardLock()
      ?.lock(LOCKED)
      .catch(() => {});
  }
}
