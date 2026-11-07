// Full Keyboard: the game in full screen with the keyboard locked to it (F11, or Settings). There,
// Chrome and Edge hand the page the keys a browser tab keeps for itself (Ctrl+W, Ctrl+T, Ctrl+N,
// Ctrl+Tab), so the game keeps them like any other (browserKeys.ts); the lock
// (navigator.keyboard.lock) adds Escape and the Windows key, so a tap of Escape is the game's and
// leaves the mouse where it is, and holding it leaves full screen (the browser says so as it starts).
// Alt+Tab still switches windows. Firefox and Safari have no lock: their full screen is just that.
//
// Remembered in this browser: a reload (an update to the game) ends full screen, so the next click
// into the world goes back in, unless the player left it themselves.

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

export class FullKeyboard {
  /** The page is going (a reload): full screen ends with it, and stays wanted. */
  private leaving = false;

  constructor(
    private readonly doc: Document = document,
    private readonly store: Storage | null = localStore(),
    win: EventTarget = window,
  ) {
    doc.addEventListener('fullscreenchange', () => {
      const on = this.on;
      if (!on) keyboardLock()?.unlock();
      if (!this.leaving) this.remember(on);
    });
    win.addEventListener('pagehide', () => {
      this.leaving = true;
    });
  }

  /** Whether this browser lets the page go full screen. */
  get supported(): boolean {
    return !!this.doc.fullscreenEnabled;
  }

  get on(): boolean {
    return !!this.doc.fullscreenElement;
  }

  /**
   * Whether every key reaches the page before the browser: in full screen (ours, or the browser's
   * own F11), or with the game installed as an app, in a window of its own.
   */
  get keepsAll(): boolean {
    return this.on || (typeof matchMedia === 'function' && !matchMedia('(display-mode: browser)').matches);
  }

  /** In or out (F11, Settings): false where the page can't go full screen. */
  toggle(): boolean {
    if (!this.supported) return false;
    void (this.on ? this.leave() : this.enter());
    return true;
  }

  async enter(): Promise<void> {
    try {
      await this.doc.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      return; // refused: no click or key just now, or a frame that may not
    }
    // Remembered now: the browser tells the page (fullscreenchange) a frame or so later.
    this.remember(true);
    // Locked once in full screen; a refusal (an older browser) leaves it full screen alone.
    await keyboardLock()
      ?.lock(LOCKED)
      .catch(() => {});
  }

  async leave(): Promise<void> {
    keyboardLock()?.unlock();
    this.remember(false);
    if (this.doc.fullscreenElement) await this.doc.exitFullscreen().catch(() => {});
  }

  /** Clicking `target` (the game) goes back into Full Keyboard if the player was in it when the page last went. */
  resumeOn(target: EventTarget): void {
    target.addEventListener('mousedown', () => {
      if (this.supported && !this.on && this.store?.getItem(KEY) === '1') void this.enter();
    });
  }

  private remember(on: boolean): void {
    try {
      if (on) this.store?.setItem(KEY, '1');
      else this.store?.removeItem(KEY);
    } catch {
      /* storage full or refused: not remembered */
    }
  }
}
