// The browser's own shortcuts, kept from it while you play: a key the browser would act on does only
// what the game makes of it. Ctrl+D doesn't bookmark the page, Ctrl+R and F5 don't reload it, Ctrl+1
// doesn't change tab, F1, F3, F6, F7 and F10 open nothing, Alt doesn't open the browser's menu nor
// Alt+Left go back, Shift+Escape (sprinting as you close a window) doesn't open Chrome's task manager,
// Ctrl+wheel doesn't zoom the page, the mouse's back button doesn't leave it, and a right or middle
// click opens nothing of the browser's. Ctrl means nothing in the game, so Ctrl+D is just D
// (input.ts).
//
// Left to the browser: a text field's own keys (copy, paste, undo, select all, moving by words),
// copying text you've selected, and the developer tools (F12, Ctrl+Shift+I, J and C). F11 is Full
// Keyboard (fullKeyboard.ts), where the browser can do it.
//
// What no page can keep: in a browser tab, Ctrl+W, Ctrl+T, Ctrl+N and Ctrl+Tab go to the browser
// before the page hears of them. In Full Keyboard, or with the game installed as an app, Chrome and
// Edge hand them to the page first, and they're kept like the rest. In a tab the game asks before
// leaving while Ctrl is held, so Ctrl+W never closes it unasked, and says once what F11 is for.

/** A key as the browser reports it: all a verdict needs. */
export interface KeyPress {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/** Kept from the browser, left to it, or F11: Full Keyboard. */
export type Verdict = 'keep' | 'pass' | 'fullKeyboard';

/** Where a key was pressed, as far as the browser's shortcuts go. */
export interface KeyPlace {
  /** In a text field (or another form control): it types, and keeps its own editing keys. */
  readonly typing: boolean;
  /** Text is selected on the page, so Ctrl+C copies it. */
  readonly selection?: boolean;
}

/** What a text field does with Ctrl (Cmd on a Mac): copy, cut, paste, undo, redo, select all, move and delete by words. */
const EDITING = new Set([
  'KeyA',
  'KeyC',
  'KeyV',
  'KeyX',
  'KeyZ',
  'KeyY',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'Backspace',
  'Delete',
  'Insert',
]);

/**
 * Keys a browser acts on with nothing held, outside a text field: scrolling, moving the focus, going
 * back (older browsers), Firefox's quick find (/ and '), the context menu key, and Alt on its own,
 * which opens the menu bar in Firefox and moves the keyboard to Chrome's menu.
 */
const PLAIN = new Set([
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'Tab',
  'Backspace',
  'Slash',
  'Quote',
  'ContextMenu',
  'AltLeft',
  'AltRight',
]);

const ALT = new Set(['AltLeft', 'AltRight']);
/** Alt with these goes back, forward and home, typing or not. */
const ALT_NAVIGATES = new Set(['ArrowLeft', 'ArrowRight', 'Home']);

const isFunctionKey = (code: string) => /^F\d{1,2}$/.test(code);

/** The developer tools' keys: F12, and Ctrl+Shift+I, J or C (Cmd+Option on a Mac). */
function devTools(e: KeyPress): boolean {
  if (e.code === 'F12') return true;
  return (e.ctrlKey || e.metaKey) && (e.shiftKey || e.altKey) && (e.code === 'KeyI' || e.code === 'KeyJ' || e.code === 'KeyC');
}

/** What becomes of a key going down (or up) while you play. */
export function verdict(e: KeyPress, at: KeyPlace): Verdict {
  if (devTools(e)) return 'pass';
  if (e.code === 'F11' && !e.ctrlKey && !e.metaKey && !e.altKey) return 'fullKeyboard';
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && !e.altKey && !e.shiftKey && (e.code === 'KeyC' || e.code === 'Insert') && at.selection) return 'pass';
  if (isFunctionKey(e.code)) return 'keep'; // F1 help, F3 find, F5 reload, F6 the address bar, F7 caret browsing, F10 the menu
  if (e.code === 'Escape') return e.shiftKey ? 'keep' : 'pass'; // Shift+Escape: Chrome's task manager
  if (ALT.has(e.code)) return 'keep';
  if (at.typing) {
    // Ctrl with Alt is AltGr, and Option on a Mac, Alt with the number pad on Windows: they type characters.
    if (e.altKey) return !e.ctrlKey && ALT_NAVIGATES.has(e.code) ? 'keep' : 'pass';
    if (ctrl) return EDITING.has(e.code) ? 'pass' : 'keep';
    return 'pass';
  }
  if (ctrl || e.altKey) return 'keep';
  return PLAIN.has(e.code) ? 'keep' : 'pass';
}

/** Whether a key is pressed in something that takes typing (or a form control's own keys, like a slider's arrows). */
function typingIn(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

/** The mouse's back and forward buttons. */
const BACK_FORWARD = new Set([3, 4]);

export interface GuardHooks {
  /** F11: into Full Keyboard or out of it; false where the browser can't, and F11 is its own. */
  fullKeyboard(): boolean;
  /** Whether every key reaches the page first: Full Keyboard, or the game installed as an app. */
  keepsAll(): boolean;
  /** Ctrl (or Cmd) went down while playing in a browser tab, the first time this page: say what F11 is for. */
  ctrlInTab?(): void;
  /** Where a key or click landed: in a text field? Default: a form control or editable element. */
  typing?(target: EventTarget | null): boolean;
  /** Whether text is selected on the page. */
  selection?(): boolean;
}

/**
 * Keeps the browser's shortcuts from it on `win` (the page's window) while the game runs: keys, the
 * mouse's back, forward and middle buttons, right clicks, Ctrl+wheel and pinch zoom, and, while Ctrl
 * is held in a tab, leaving.
 */
export function guardBrowser(win: EventTarget, hooks: GuardHooks): void {
  /** Ctrl or Cmd is down: a close now is Ctrl+W, asked about first. */
  let held = false;
  let tipped = false;
  const typing = (t: EventTarget | null) => (hooks.typing ?? typingIn)(t);
  const onKey = (e: KeyboardEvent) => {
    held = e.ctrlKey || e.metaKey;
    const v = verdict(e, { typing: typing(e.target), selection: hooks.selection?.() ?? false });
    if (v === 'keep') e.preventDefault();
    // F11 held down repeats: only the first press goes in or out.
    else if (v === 'fullKeyboard' && (e.type !== 'keydown' || e.repeat || hooks.fullKeyboard())) e.preventDefault();
    if (e.type === 'keydown' && held && !tipped && !typing(e.target) && !hooks.keepsAll()) {
      tipped = true;
      hooks.ctrlInTab?.();
    }
  };
  // Capturing, so a window that keeps its keys to itself (stopPropagation) still has them kept from the browser.
  win.addEventListener('keydown', onKey as EventListener, { capture: true });
  win.addEventListener('keyup', onKey as EventListener, { capture: true });
  win.addEventListener('blur', () => {
    held = false;
  });
  const onButton = (e: MouseEvent) => {
    held = e.ctrlKey || e.metaKey;
    // Back and forward leave the page; the middle button starts the browser's autoscroll.
    if (BACK_FORWARD.has(e.button) || (e.button === 1 && e.type === 'mousedown' && !typing(e.target))) e.preventDefault();
  };
  win.addEventListener('mousedown', onButton as EventListener, { capture: true });
  win.addEventListener('mouseup', onButton as EventListener, { capture: true });
  win.addEventListener('auxclick', ((e: MouseEvent) => BACK_FORWARD.has(e.button) && e.preventDefault()) as EventListener, { capture: true });
  win.addEventListener('contextmenu', (e) => !typing(e.target) && e.preventDefault(), { capture: true });
  // Ctrl+wheel (and a trackpad's pinch, which the browser reports as one) zooms the page; Safari pinches with gestures.
  win.addEventListener('wheel', ((e: WheelEvent) => e.ctrlKey && e.preventDefault()) as EventListener, { capture: true, passive: false });
  win.addEventListener('gesturestart', (e) => e.preventDefault(), { capture: true, passive: false });
  win.addEventListener('gesturechange', (e) => e.preventDefault(), { capture: true, passive: false });
  win.addEventListener('beforeunload', (e) => {
    // Ctrl+W, Ctrl+Shift+W and Ctrl+F4 in a tab: the browser closes before the page hears the key.
    if (!held) return;
    e.preventDefault();
    (e as BeforeUnloadEvent).returnValue = '';
  });
}
