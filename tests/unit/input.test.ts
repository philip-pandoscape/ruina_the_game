import { afterAll, beforeAll, expect, test } from 'vitest';
import { crouchKeySlides, Input } from '../../src/input/input';

// The keyboard's mapping, run in Node against stand-ins for the page's window and canvas: no
// browser, no drawing. C crouches while held (and flares the glider), a press of it on the run
// slides as well, K always slides, and nothing is on Ctrl: a key pressed with it is that key (what
// the browser hears of it is browserKeys.test.ts's).

type Mods = { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean };

let win: EventTarget;
beforeAll(() => {
  win = new EventTarget();
  Object.assign(globalThis, { window: win, document: new EventTarget() });
  if (typeof navigator === 'undefined') Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
});
afterAll(() => {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).document;
});

/** A key going down or up, as the browser would send it; returned so a test can see whether the game kept it from the browser. */
function key(type: 'keydown' | 'keyup', code: string, mods: Mods = {}): Event {
  const e = Object.assign(new Event(type, { cancelable: true }), {
    code,
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });
  win.dispatchEvent(e);
  return e;
}

/** A fresh Input, with C sliding only while `running()` says so (the game asks crouchKeySlides). */
function keyboard(running: () => boolean): Input {
  const input = new Input(new EventTarget() as unknown as HTMLCanvasElement);
  input.crouchSlides = running;
  return input;
}

test('C crouches while held, and a press of it slides only on the run', () => {
  let running = false;
  const input = keyboard(() => running);
  // Standing still: down into a crouch, no slide, for as long as it's held.
  key('keydown', 'KeyC');
  let a = input.pollActions(0);
  expect([a.slidePressed, a.crouchHeld]).toEqual([false, true]);
  a = input.pollActions(0);
  expect([a.slidePressed, a.crouchHeld]).toEqual([false, true]);
  key('keyup', 'KeyC');
  expect(input.pollActions(0).crouchHeld).toBe(false);
  // On the run the press slides, and holding on crouches once the slide is done.
  running = true;
  key('keydown', 'KeyC');
  a = input.pollActions(0);
  expect([a.slidePressed, a.crouchHeld]).toEqual([true, true]);
  a = input.pollActions(0);
  expect([a.slidePressed, a.crouchHeld]).toEqual([false, true]);
  key('keyup', 'KeyC');
  // K slides whatever you're doing, and doesn't crouch.
  running = false;
  key('keydown', 'KeyK');
  a = input.pollActions(0);
  expect([a.slidePressed, a.crouchHeld]).toEqual([true, false]);
  key('keyup', 'KeyK');
});

test('nothing is on Ctrl: a key pressed with it is that key, and Cmd keeps out of the game', () => {
  const input = keyboard(() => true);
  // Ctrl on its own is no game key: it crouches nothing.
  key('keydown', 'ControlLeft', { ctrlKey: true });
  expect(input.pollActions(0).crouchHeld).toBe(false);
  // With Ctrl held, W still walks (fighting, gliding: in Full Keyboard Ctrl+W reaches the game), R
  // calls the mount, F interacts and 1 is the first slot.
  key('keydown', 'KeyW', { ctrlKey: true });
  key('keydown', 'KeyR', { ctrlKey: true });
  key('keydown', 'KeyF', { ctrlKey: true });
  key('keydown', 'Digit1', { ctrlKey: true });
  const a = input.pollActions(0);
  expect(a.moveZ).toBeCloseTo(1);
  expect(a.abilitySlot).toBe(1);
  expect(input.pollLife()).toEqual(['mount', 'interact']);
  // Letting Ctrl go first changes nothing: W walks on until it comes up.
  key('keyup', 'ControlLeft');
  expect(input.pollActions(0).moveZ).toBeCloseTo(1);
  for (const c of ['KeyW', 'KeyR', 'KeyF', 'Digit1']) key('keyup', c);
  expect(input.pollActions(0).moveZ).toBe(0);
  // Cmd (a Mac's) never reaches the game: a key let go while it's held never reports coming up.
  key('keydown', 'Space', { metaKey: true });
  expect(input.pollActions(0).jumpPressed).toBe(false);
  key('keyup', 'Space');
  // The game's own keys keep theirs from the browser (Space scrolls a page).
  const space = key('keydown', 'Space');
  expect(space.defaultPrevented).toBe(true);
  expect(input.pollActions(0).jumpPressed).toBe(true);
  key('keyup', 'Space');
  // AltGr (Ctrl with Alt, on some keyboards) reaches the game too.
  key('keydown', 'KeyW', { ctrlKey: true, altKey: true });
  expect(input.pollActions(0).moveZ).toBeCloseTo(1);
  key('keyup', 'KeyW');
});

test('the crouch key slides on the ground on the move, never standing, in the air, swimming or riding', () => {
  const p = (mode: string, grounded: boolean, speed: number) =>
    ({ mode, grounded, vel: { x: speed * 0.6, y: grounded ? 0 : -3, z: speed * 0.8 } }) as Parameters<typeof crouchKeySlides>[0];
  expect(crouchKeySlides(p('normal', true, 7.5))).toBe(true); // running
  expect(crouchKeySlides(p('normal', true, 10.5))).toBe(true); // sprinting
  expect(crouchKeySlides(p('attack', true, 6))).toBe(true); // lunging into a swing: the slide waits for it
  expect(crouchKeySlides(p('normal', true, 0))).toBe(false); // standing
  expect(crouchKeySlides(p('normal', true, 1.6))).toBe(false); // creeping along crouched
  expect(crouchKeySlides(p('normal', false, 7.5))).toBe(false); // jumping or falling
  expect(crouchKeySlides(p('glide', false, 13))).toBe(false); // gliding: it flares
  expect(crouchKeySlides(p('swim', false, 4))).toBe(false);
  expect(crouchKeySlides(p('ride', true, 9))).toBe(false);
});
