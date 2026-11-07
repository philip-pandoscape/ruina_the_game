import { describe, expect, test, vi } from 'vitest';
import { guardBrowser, verdict, type KeyPlace } from '../../src/input/browserKeys';
import { enterWorldFullScreen, FullKeyboard } from '../../src/input/fullKeyboard';

// The browser's shortcuts kept from it while you play (src/input/browserKeys.ts), and Full Keyboard
// (src/input/fullKeyboard.ts), run in Node against stand-ins for the page's window and document: no
// browser. What a real browser does with the keys the page can't keep (Ctrl+W in a tab) is past any
// test's keys; tests/integration/browserKeys.spec.ts plays the rest in one.

type Mods = { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean };

/** `Ctrl+Shift+KeyT` → the key and what's held with it. */
function parse(chord: string): { code: string } & Required<Mods> {
  const parts = chord.split('+');
  const code = parts.pop() as string;
  return { code, ctrlKey: parts.includes('Ctrl'), metaKey: parts.includes('Cmd'), altKey: parts.includes('Alt'), shiftKey: parts.includes('Shift') };
}

const PLAYING: KeyPlace = { typing: false };
const TYPING: KeyPlace = { typing: true };

describe('what the browser hears of a key', () => {
  test('playing, its shortcuts are kept, whatever is held with them', () => {
    const kept = [
      // Bookmark, save, print, find, reload, the address bar, a tab by number, zoom.
      'Ctrl+KeyD',
      'Ctrl+KeyS',
      'Ctrl+KeyP',
      'Ctrl+KeyF',
      'Ctrl+KeyR',
      'Ctrl+Shift+KeyR',
      'Ctrl+KeyL',
      'Ctrl+KeyA',
      'Ctrl+Digit1',
      'Ctrl+Digit9',
      'Ctrl+Equal',
      'Ctrl+Minus',
      'Ctrl+Digit0',
      // What reaches the page only in Full Keyboard or the installed app: kept there.
      'Ctrl+KeyW',
      'Ctrl+KeyT',
      'Ctrl+KeyN',
      'Ctrl+Tab',
      'Ctrl+Shift+KeyT',
      'Ctrl+Shift+KeyW',
      'Ctrl+PageDown',
      'Cmd+KeyR',
      'Cmd+KeyD',
      // Help, find, reload, the address bar, caret browsing, the menu, the context menu.
      'F1',
      'F3',
      'F5',
      'F6',
      'F7',
      'F10',
      'Shift+F10',
      'Ctrl+F5',
      // Back, forward, home, the menus; Alt on its own.
      'Alt+ArrowLeft',
      'Alt+ArrowRight',
      'Alt+Home',
      'Alt+KeyD',
      'Alt+KeyF',
      'Alt+AltLeft',
      'AltLeft',
      'AltRight',
      // Chrome's task manager: sprinting as you close a window.
      'Shift+Escape',
      // Scrolling, the focus, going back, Firefox's quick find, the context menu key.
      'Space',
      'Tab',
      'Shift+Tab',
      'PageDown',
      'Backspace',
      'Slash',
      'Quote',
      'ContextMenu',
      // AltGr, playing, types nothing.
      'Ctrl+Alt+KeyQ',
    ];
    for (const k of kept) expect([k, verdict(parse(k), PLAYING)]).toEqual([k, 'keep']);
  });

  test('playing, the game decides about its own keys, and the developer tools still open', () => {
    const passed = [
      'KeyW',
      'Shift+KeyW',
      'KeyF',
      'Digit1',
      'Enter',
      'Escape',
      'KeyC',
      'F12',
      'Ctrl+Shift+KeyI',
      'Ctrl+Shift+KeyJ',
      'Ctrl+Shift+KeyC',
      'Cmd+Alt+KeyI',
    ];
    for (const k of passed) expect([k, verdict(parse(k), PLAYING)]).toEqual([k, 'pass']);
  });

  test('F11 is Full Keyboard', () => {
    expect(verdict(parse('F11'), PLAYING)).toBe('fullKeyboard');
    expect(verdict(parse('Shift+F11'), PLAYING)).toBe('fullKeyboard');
    expect(verdict(parse('F11'), TYPING)).toBe('fullKeyboard');
  });

  test('copying text you selected is left to the browser', () => {
    expect(verdict(parse('Ctrl+KeyC'), { typing: false, selection: true })).toBe('pass');
    expect(verdict(parse('Ctrl+Insert'), { typing: false, selection: true })).toBe('pass');
    expect(verdict(parse('Ctrl+KeyC'), PLAYING)).toBe('keep');
    expect(verdict(parse('Ctrl+KeyA'), { typing: false, selection: true })).toBe('keep');
  });

  test('typing, a text field keeps its own keys, and the browser still gets none of its shortcuts', () => {
    const passed = [
      'KeyA',
      'Shift+KeyA',
      'Space',
      'Backspace',
      'Tab',
      'Slash',
      'Quote',
      'Enter',
      'Escape',
      'ArrowLeft',
      'Home',
      // Select all, copy, cut, paste, undo, redo, moving and deleting by words, the Mac's Cmd.
      'Ctrl+KeyA',
      'Ctrl+KeyC',
      'Ctrl+KeyX',
      'Ctrl+KeyV',
      'Ctrl+Shift+KeyV',
      'Ctrl+KeyZ',
      'Ctrl+Shift+KeyZ',
      'Ctrl+KeyY',
      'Ctrl+ArrowLeft',
      'Ctrl+Shift+ArrowRight',
      'Ctrl+Backspace',
      'Ctrl+Delete',
      'Shift+Insert',
      'Cmd+KeyV',
      // AltGr (@ on a German keyboard), and Option on a Mac, type characters.
      'Ctrl+Alt+KeyQ',
      'Alt+KeyE',
      'F12',
    ];
    for (const k of passed) expect([k, verdict(parse(k), TYPING)]).toEqual([k, 'pass']);
    const kept = ['Ctrl+KeyD', 'Ctrl+KeyR', 'Ctrl+KeyS', 'Ctrl+KeyW', 'Ctrl+Digit1', 'Ctrl+KeyL', 'F5', 'F1', 'F7', 'Alt+ArrowLeft', 'AltLeft', 'Shift+Escape'];
    for (const k of kept) expect([k, verdict(parse(k), TYPING)]).toEqual([k, 'keep']);
  });
});

/** A page's window, for the guard to listen on, and events as the browser would send them. */
function page(over: Partial<Parameters<typeof guardBrowser>[1]> = {}) {
  const win = new EventTarget();
  let typing = false;
  const hooks = {
    fullKeyboard: vi.fn(() => true),
    keepsAll: vi.fn(() => false),
    ctrlInTab: vi.fn(),
    typing: () => typing,
    ...over,
  };
  guardBrowser(win, hooks);
  const send = <T extends object>(type: string, props: T) => {
    const e = Object.assign(new Event(type, { cancelable: true }), props);
    win.dispatchEvent(e);
    return e;
  };
  const key = (type: 'keydown' | 'keyup', chord: string, repeat = false) => send(type, { ...parse(chord), repeat });
  const mouse = (type: string, button: number, mods: Mods = {}) => send(type, { button, ctrlKey: false, metaKey: false, ...mods });
  // A page's beforeunload event carries the string its prompt asks with; Node's Event doesn't let it be set.
  const leave = () => {
    const e = new Event('beforeunload', { cancelable: true });
    Object.defineProperty(e, 'returnValue', { value: 'unset', writable: true });
    win.dispatchEvent(e);
    return e;
  };
  return {
    win,
    hooks,
    key,
    mouse,
    leave,
    send,
    typeIn: (on: boolean) => {
      typing = on;
    },
  };
}

describe('the guard on the page', () => {
  test('keeps the browser from its shortcuts and leaves the game its keys', () => {
    const p = page();
    expect(p.key('keydown', 'Ctrl+KeyD').defaultPrevented).toBe(true);
    expect(p.key('keydown', 'F5').defaultPrevented).toBe(true);
    expect(p.key('keyup', 'AltLeft').defaultPrevented).toBe(true); // the menu opens as Alt comes up
    expect(p.key('keydown', 'KeyW').defaultPrevented).toBe(false);
    p.typeIn(true);
    expect(p.key('keydown', 'Ctrl+KeyA').defaultPrevented).toBe(false);
    expect(p.key('keydown', 'Ctrl+KeyD').defaultPrevented).toBe(true);
  });

  test("F11 goes into Full Keyboard once a press, and is the browser's where the page can't", () => {
    const p = page();
    expect(p.key('keydown', 'F11').defaultPrevented).toBe(true);
    expect(p.key('keydown', 'F11', true).defaultPrevented).toBe(true); // held down: no flicker in and out
    expect(p.key('keyup', 'F11').defaultPrevented).toBe(true);
    expect(p.hooks.fullKeyboard).toHaveBeenCalledTimes(1);
    const cant = page({ fullKeyboard: vi.fn(() => false) });
    expect(cant.key('keydown', 'F11').defaultPrevented).toBe(false);
  });

  test('in a tab, leaving asks first while Ctrl is held, and only then', () => {
    const p = page();
    expect(p.leave().defaultPrevented).toBe(false); // the tab's close button, a link: never asked
    p.key('keydown', 'Ctrl+ControlLeft');
    const asked = p.leave();
    expect(asked.defaultPrevented).toBe(true); // Ctrl+W, which the browser acts on before the page hears it
    expect((asked as unknown as { returnValue: string }).returnValue).toBe('');
    p.key('keyup', 'ControlLeft');
    expect(p.leave().defaultPrevented).toBe(false);
    // Ctrl went down, then the window lost the keyboard (Alt+Tab): its keyup never comes.
    p.key('keydown', 'Ctrl+ControlLeft');
    p.send('blur', {});
    expect(p.leave().defaultPrevented).toBe(false);
    // Held from before the page had the keyboard: the next click says so.
    p.mouse('mousedown', 0, { ctrlKey: true });
    expect(p.leave().defaultPrevented).toBe(true);
  });

  test('says once what F11 is for, the first time Ctrl goes down playing in a tab', () => {
    const p = page();
    p.key('keydown', 'Ctrl+ControlLeft');
    p.key('keydown', 'Ctrl+KeyD');
    p.key('keyup', 'ControlLeft');
    p.key('keydown', 'Ctrl+ControlLeft');
    expect(p.hooks.ctrlInTab).toHaveBeenCalledTimes(1);
    // Not in Full Keyboard or the app, where Ctrl+W is kept; not typing (Ctrl+C in a text field).
    const full = page({ keepsAll: vi.fn(() => true) });
    full.key('keydown', 'Ctrl+ControlLeft');
    expect(full.hooks.ctrlInTab).not.toHaveBeenCalled();
    const typing = page();
    typing.typeIn(true);
    typing.key('keydown', 'Ctrl+KeyC');
    expect(typing.hooks.ctrlInTab).not.toHaveBeenCalled();
  });

  test('the mouse: back and forward stay, the middle button scrolls nothing, a right click opens no menu', () => {
    const p = page();
    for (const type of ['mousedown', 'mouseup', 'auxclick']) {
      expect([type, p.mouse(type, 3).defaultPrevented]).toEqual([type, true]);
      expect([type, p.mouse(type, 4).defaultPrevented]).toEqual([type, true]);
    }
    expect(p.mouse('mousedown', 1).defaultPrevented).toBe(true);
    expect(p.mouse('mousedown', 0).defaultPrevented).toBe(false); // the game's clicks, and the windows' buttons
    expect(p.mouse('mousedown', 2).defaultPrevented).toBe(false);
    expect(p.send('contextmenu', {}).defaultPrevented).toBe(true);
    p.typeIn(true);
    expect(p.send('contextmenu', {}).defaultPrevented).toBe(false); // paste into a text field
  });

  test('Ctrl+wheel and a pinch zoom the camera, not the page', () => {
    const p = page();
    expect(p.send('wheel', { ctrlKey: true, deltaY: 120 }).defaultPrevented).toBe(true);
    expect(p.send('wheel', { ctrlKey: false, deltaY: 120 }).defaultPrevented).toBe(false);
    expect(p.send('gesturestart', {}).defaultPrevented).toBe(true);
  });
});

/**
 * A document that can go full screen, as far as Full Keyboard looks at one, in a browser a player
 * uses (or, `automated`, one tests drive), its Full Keyboard, and (unless `game` is false) the game's
 * canvas wired to it.
 */
function screen({ enabled = true, automated = false, game = true } = {}) {
  const doc = Object.assign(new EventTarget(), {
    fullscreenEnabled: enabled,
    fullscreenElement: null as object | null,
    documentElement: { requestFullscreen: vi.fn(async (_opts?: unknown) => {}) },
    exitFullscreen: vi.fn(async () => {}),
  });
  doc.documentElement.requestFullscreen.mockImplementation(async () => {
    doc.fullscreenElement = doc.documentElement;
    doc.dispatchEvent(new Event('fullscreenchange'));
  });
  doc.exitFullscreen.mockImplementation(async () => {
    doc.fullscreenElement = null;
    doc.dispatchEvent(new Event('fullscreenchange'));
  });
  const kept = new Map<string, string>();
  const store = {
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => {
      kept.set(k, v);
    },
    removeItem: (k: string) => {
      kept.delete(k);
    },
  } as unknown as Storage;
  const win = new EventTarget();
  const lock = { lock: vi.fn(async (_codes?: string[]) => {}), unlock: vi.fn() };
  Object.defineProperty(globalThis, 'navigator', { value: { keyboard: lock, webdriver: automated }, configurable: true });
  const page = doc as unknown as Document;
  const fk = new FullKeyboard(page, store, win);
  // The game's canvas: a click on it goes back in.
  const canvas = new EventTarget();
  if (game) fk.resumeOn(canvas);
  const click = async () => {
    canvas.dispatchEvent(new Event('mousedown'));
    await settle();
  };
  return { doc, page, store, kept, win, lock, fk, click };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('Full Keyboard', () => {
  test('on by itself: a click into the game goes in, and again after stepping out', async () => {
    const { doc, lock, fk, click } = screen();
    expect(fk.auto).toBe(true);
    const out = vi.fn();
    fk.onStepOut = out;
    await click();
    expect(fk.on).toBe(true);
    expect(lock.lock).toHaveBeenCalledWith(['Escape', 'MetaLeft', 'MetaRight']);
    // Held Escape (or F11): out, said once by the game, and the next click goes back in.
    await doc.exitFullscreen();
    expect(fk.on).toBe(false);
    expect(lock.unlock).toHaveBeenCalled();
    expect(out).toHaveBeenCalledTimes(1);
    await click();
    expect(fk.on).toBe(true);
  });

  test('going into the world goes full screen at once (Enter World), and the game locks the keys as it starts', async () => {
    const { doc, page, store } = screen({ game: false });
    enterWorldFullScreen(page, store);
    await settle();
    expect(doc.documentElement.requestFullscreen).toHaveBeenCalledWith({ navigationUI: 'hide' });
    expect(doc.fullscreenElement).not.toBeNull();
    // The game starts (main.ts) in full screen already: it locks the keys without a click.
    const lock = { lock: vi.fn(async (_codes?: string[]) => {}), unlock: vi.fn() };
    Object.defineProperty(globalThis, 'navigator', { value: { keyboard: lock, webdriver: false }, configurable: true });
    new FullKeyboard(page, store, new EventTarget());
    expect(lock.lock).toHaveBeenCalledWith(['Escape', 'MetaLeft', 'MetaRight']);
  });

  test('Settings turns it off (out, and clicks stay out) and on again (in), kept in this browser', async () => {
    const { kept, fk, click } = screen();
    await click();
    const out = vi.fn();
    fk.onStepOut = out;
    fk.setAuto(false);
    await settle();
    expect([fk.auto, fk.on, kept.get('ruina.fullKeyboard')]).toEqual([false, false, 'off']);
    expect(out).not.toHaveBeenCalled(); // turned off, not stepped out of
    await click();
    expect(fk.on).toBe(false);
    // F11 still goes in and out there and then.
    fk.toggle();
    await settle();
    expect(fk.on).toBe(true);
    fk.toggle();
    await settle();
    // On again: in at once (the click on the button), and by itself from then on.
    fk.setAuto(true);
    await settle();
    expect([fk.auto, fk.on, kept.get('ruina.fullKeyboard')]).toEqual([true, true, 'on']);
    // Off in one page is off in the next.
    const next = screen();
    next.kept.set('ruina.fullKeyboard', 'off');
    await next.click();
    expect(next.fk.on).toBe(false);
  });

  test("a test's browser starts with it off, so a test's clicks don't change the window, unless it turns it on", async () => {
    const tested = screen({ automated: true });
    expect(tested.fk.auto).toBe(false);
    await tested.click();
    expect(tested.fk.on).toBe(false);
    enterWorldFullScreen(tested.page, tested.store);
    expect(tested.doc.documentElement.requestFullscreen).not.toHaveBeenCalled();
    const opted = screen({ automated: true });
    opted.kept.set('ruina.fullKeyboard', 'on');
    await opted.click();
    expect(opted.fk.on).toBe(true);
  });

  test('F11 goes full screen with Escape and the Windows key locked to the game, and comes out again', async () => {
    const { doc, lock, fk } = screen();
    expect(fk.toggle()).toBe(true);
    await settle();
    expect(doc.documentElement.requestFullscreen).toHaveBeenCalledWith({ navigationUI: 'hide' });
    expect(lock.lock).toHaveBeenCalledWith(['Escape', 'MetaLeft', 'MetaRight']);
    expect(fk.on).toBe(true);
    expect(fk.keepsAll).toBe(true);
    fk.toggle();
    await settle();
    expect(doc.exitFullscreen).toHaveBeenCalled();
    expect(lock.unlock).toHaveBeenCalled();
    expect(fk.on).toBe(false);
  });

  test('a reload (an update) is no stepping out: nothing said as the page goes, and its first click goes back in', async () => {
    const { doc, win, fk, click } = screen();
    await click();
    const out = vi.fn();
    fk.onStepOut = out;
    win.dispatchEvent(new Event('pagehide'));
    doc.fullscreenElement = null;
    doc.dispatchEvent(new Event('fullscreenchange'));
    expect(out).not.toHaveBeenCalled();
    const next = screen();
    await next.click();
    expect(next.fk.on).toBe(true);
  });

  test("where the page can't go full screen, F11 stays the browser's", async () => {
    const { fk, doc, page, store, click } = screen({ enabled: false });
    expect(fk.supported).toBe(false);
    expect(fk.toggle()).toBe(false);
    await click();
    enterWorldFullScreen(page, store);
    expect(doc.documentElement.requestFullscreen).not.toHaveBeenCalled();
  });
});
