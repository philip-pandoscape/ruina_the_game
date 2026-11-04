import type { Actions } from '../sim/types';
import { CAMERA, GAMEPAD } from '../tuning';
import { MouseFilter } from './mouseFilter';

export type Device = 'keyboard' | 'gamepad';

// Menu presses: opening the skill panel, moving its cursor, choosing, closing, starting over.
export type MenuPress = 'toggle' | 'up' | 'down' | 'left' | 'right' | 'select' | 'back' | 'reset';

// Xbox button numbers in the browser's standard gamepad layout.
export const PAD = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7,
  VIEW: 8, MENU: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
} as const;

const KEYS = {
  up: ['KeyW'],
  down: ['KeyS'],
  left: ['KeyA'],
  right: ['KeyD'],
  jump: ['Space'],
  attack: ['KeyJ', 'Mouse0'],
  // Shift sprints now, so sliding moved to C. K stays as it was.
  slide: ['KeyC', 'KeyK'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  crouch: ['ControlLeft', 'ControlRight'],
};

// Movement skills: Q and E, or the bumpers.
const MOVEMENT_KEYS = ['KeyQ', 'KeyE'];
const PAD_MOVEMENT = [PAD.LB, PAD.RB];

// Hotbar slots 1..8 on the number row. The browser reports these as Digit1..Digit8 whatever the
// keyboard layout, so they work the same on AZERTY.
const HOTBAR_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8'];

// On a controller the face buttons double as hotbar slots while a trigger is held: LT gives
// slots 1-4 and RT slots 5-8, so holding a trigger suppresses jump, attack and slide.
const PAD_FACE = [PAD.A, PAD.B, PAD.X, PAD.Y];

const PAD_BINDINGS = { jump: PAD.A, attack: PAD.X, slide: PAD.B, sprint: PAD.LS, crouch: PAD.RS };

const BLOCK_DEFAULT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', ...HOTBAR_KEYS, ...MOVEMENT_KEYS]);

// Combat input that isn't part of a sim step: holding an ability to aim it, and switching target.
export interface CombatInput {
  // The hotbar slot currently held down, 1..8, or 0. Holding a slot is what arms a ground-aimed
  // cast; releasing it is what fires.
  slotHeld: number;
  nextTarget: number; // presses since the last poll
  prevTarget: number;
  cancel: number;
  stickX: number; // raw left stick, for pushing the ground-aim circle around
  stickY: number; // +1 is away from the camera
  movementHeld: number; // the movement slot still held, for guards that stay up
}

const MENU_KEYS: Record<string, MenuPress> = {
  KeyT: 'toggle',
  Escape: 'back',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'select',
  Space: 'select',
};

const MENU_PAD: Array<[number, MenuPress]> = [
  [PAD.VIEW, 'toggle'],
  [PAD.UP, 'up'],
  [PAD.DOWN, 'down'],
  [PAD.LEFT, 'left'],
  [PAD.RIGHT, 'right'],
  [PAD.A, 'select'],
  [PAD.B, 'back'],
  [PAD.Y, 'reset'],
];

// Open-world keys: interact, drop a pack, mount, glider, change seed, and the panels.
export type LifeKey = 'interact' | 'drop' | 'mount' | 'glider' | 'seed' | 'bag' | 'map' | 'garage' | 'quests' | 'escape' | 'dev';
const LIFE_KEYS: Record<string, LifeKey> = {
  KeyF: 'interact',
  KeyX: 'drop',
  KeyR: 'mount',
  KeyG: 'glider',
  KeyZ: 'seed',
  KeyI: 'bag',
  KeyB: 'bag',
  KeyM: 'map',
  KeyV: 'garage',
  KeyL: 'quests',
  Escape: 'escape',
  Backquote: 'dev',
};

interface Rumbler {
  playEffect?: (type: string, params: Record<string, number>) => Promise<unknown>;
}

function deadzone(x: number, y: number): [number, number] {
  const mag = Math.hypot(x, y);
  if (mag < GAMEPAD.deadzone) return [0, 0];
  const scaled = Math.min(1, (mag - GAMEPAD.deadzone) / (1 - GAMEPAD.deadzone));
  return [(x / mag) * scaled, (y / mag) * scaled];
}

// Turns keyboard, mouse and controller input into game actions and camera movement.
export class Input {
  lastDevice: Device = 'keyboard';
  onDeviceChange: ((d: Device) => void) | null = null;
  private down = new Set<string>();
  private pressed = new Set<string>(); // presses since the last pollActions()
  /** Mouse movement for the camera, with the browser's occasional bogus readings taken out. */
  readonly mouse = new MouseFilter();
  /** Whether the browser agreed to raw mouse movement for the current pointer lock. */
  rawMouse = false;
  private wheel = 0;
  private padPrev: boolean[] = [];
  private menuPresses: MenuPress[] = [];
  private menuPadPrev: boolean[] = [];
  private menuStick = '';
  private combatPadPrev: boolean[] = [];
  private combat = { nextTarget: 0, prevTarget: 0, cancel: 0 };
  private lifePresses: LifeKey[] = [];
  private lifePadPrev: boolean[] = [];
  /** In an open world the D-pad calls your mount and opens the map instead of zooming. */
  worldMode = false;

  constructor(canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (BLOCK_DEFAULT.has(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      if (!e.repeat && MENU_KEYS[e.code] && this.menuPresses.length < 16) this.menuPresses.push(MENU_KEYS[e.code]);
      if (!e.repeat && e.code === 'Tab') (e.shiftKey ? this.combat.prevTarget++ : this.combat.nextTarget++);
      if (!e.repeat && e.code === 'Escape') this.combat.cancel++;
      if (!e.repeat && LIFE_KEYS[e.code] && this.lifePresses.length < 16) this.lifePresses.push(LIFE_KEYS[e.code]);
      this.down.add(e.code);
      this.setDevice('keyboard');
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
    canvas.addEventListener('mousedown', (e) => {
      this.setDevice('keyboard');
      if (document.pointerLockElement !== canvas) {
        // First click captures the mouse for camera control.
        this.lockPointer(canvas);
        return;
      }
      if (e.button === 0) {
        this.pressed.add('Mouse0');
        this.down.add('Mouse0');
      }
      if (e.button === 2) {
        this.pressed.add('Mouse2');
        this.down.add('Mouse2');
      }
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.down.delete('Mouse0');
      if (e.button === 2) this.down.delete('Mouse2');
    });
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== canvas) return;
      this.mouse.move(e.movementX, e.movementY, e.timeStamp);
    });
    document.addEventListener('pointerlockchange', () => this.mouse.reset());
    canvas.addEventListener('wheel', (e) => (this.wheel += e.deltaY), { passive: true });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // right-click is an ability
  }

  // Asks for raw mouse movement, which skips the cursor re-centring the bogus readings come from
  // (and Windows' mouse acceleration with it). Chrome refuses it where it can't do it, so ask again
  // plainly; Firefox and Safari just ignore the option.
  private lockPointer(canvas: HTMLCanvasElement): void {
    const plain = () => {
      this.rawMouse = false;
      try {
        void Promise.resolve(canvas.requestPointerLock()).catch(() => {});
      } catch {
        /* pointer lock not available */
      }
    };
    try {
      const asked = canvas.requestPointerLock({ unadjustedMovement: true });
      if (!asked) {
        this.rawMouse = false; // no promise: an older browser that ignored the option
        return;
      }
      asked.then(
        () => (this.rawMouse = true),
        (err: unknown) => {
          if (err instanceof DOMException && err.name === 'NotSupportedError') plain();
        },
      );
    } catch {
      plain();
    }
  }

  private setDevice(d: Device): void {
    if (d === this.lastDevice) return;
    this.lastDevice = d;
    this.onDeviceChange?.(d);
  }

  private pad(): Gamepad | null {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  private anyDown(codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }

  private anyPressed(codes: string[]): boolean {
    return codes.some((c) => this.pressed.has(c));
  }

  // Camera rotation and zoom since the last call. Called every rendered frame.
  pollCamera(dt: number): { dYaw: number; dPitch: number; dZoom: number } {
    const m = this.mouse.take(performance.now());
    let dYaw = -m.dx * CAMERA.mouseSensitivity;
    let dPitch = m.dy * CAMERA.mouseSensitivity;
    let dZoom = this.wheel * 0.0015;
    this.wheel = 0;

    if (this.down.has('ArrowLeft')) dYaw += CAMERA.keySpeed * dt;
    if (this.down.has('ArrowRight')) dYaw -= CAMERA.keySpeed * dt;
    if (this.down.has('ArrowUp')) dPitch -= CAMERA.keySpeed * 0.6 * dt;
    if (this.down.has('ArrowDown')) dPitch += CAMERA.keySpeed * 0.6 * dt;

    const pad = this.pad();
    if (pad) {
      const [rx, ry] = deadzone(pad.axes[2] ?? 0, pad.axes[3] ?? 0);
      if (rx !== 0 || ry !== 0) {
        dYaw -= rx * CAMERA.stickSpeed * dt;
        dPitch += ry * CAMERA.stickSpeed * 0.7 * dt;
        this.setDevice('gamepad');
      }
      // D-pad up/down zooms (in the open world they call your mount and open the map instead).
      if (!this.worldMode && pad.buttons[PAD.UP]?.pressed) dZoom -= 1.6 * dt;
      if (!this.worldMode && pad.buttons[PAD.DOWN]?.pressed) dZoom += 1.6 * dt;
    }
    return { dYaw, dPitch, dZoom };
  }

  // Menu presses since the last call. Read once per frame, separately from the game's buttons, so
  // the same press can't both close the skill panel and jump.
  pollMenu(): MenuPress[] {
    const out = this.menuPresses;
    this.menuPresses = [];
    const pad = this.pad();
    if (pad) {
      const held = pad.buttons.map((b) => b.pressed || b.value > 0.5);
      for (const [button, press] of MENU_PAD) if (held[button] && !this.menuPadPrev[button]) out.push(press);
      this.menuPadPrev = held;
      // The left stick also moves the cursor, one step per push.
      const [x, y] = deadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
      const dir = Math.abs(x) < 0.6 && Math.abs(y) < 0.6 ? '' : Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : y > 0 ? 'down' : 'up';
      if (dir && dir !== this.menuStick) out.push(dir as MenuPress);
      this.menuStick = dir;
    }
    return out;
  }

  // Game actions for one sim step. camYaw makes movement relative to the camera.
  pollActions(camYaw: number): Actions {
    let sx = 0; // stick right
    let sy = 0; // stick forward
    if (this.anyDown(KEYS.up)) sy += 1;
    if (this.anyDown(KEYS.down)) sy -= 1;
    if (this.anyDown(KEYS.right)) sx += 1;
    if (this.anyDown(KEYS.left)) sx -= 1;
    const keyLen = Math.hypot(sx, sy);
    if (keyLen > 1) {
      sx /= keyLen;
      sy /= keyLen;
    }

    let jumpPressed = this.anyPressed(KEYS.jump);
    let jumpHeld = this.anyDown(KEYS.jump);
    let attackPressed = this.anyPressed(KEYS.attack);
    let slidePressed = this.anyPressed(KEYS.slide);
    let abilitySlot = 0;
    for (let k = 0; k < HOTBAR_KEYS.length; k++) {
      if (this.pressed.has(HOTBAR_KEYS[k])) {
        abilitySlot = k + 1;
        break;
      }
    }
    let movementSlot = 0;
    for (let k = 0; k < MOVEMENT_KEYS.length; k++) {
      if (this.pressed.has(MOVEMENT_KEYS[k])) {
        movementSlot = k + 1;
        break;
      }
    }
    let movementHeld = MOVEMENT_KEYS.findIndex((k) => this.down.has(k)) + 1;
    let sprintHeld = this.anyDown(KEYS.sprint);
    let crouchHeld = this.anyDown(KEYS.crouch);
    this.pressed.clear();

    const pad = this.pad();
    if (pad) {
      const held = pad.buttons.map((b) => b.pressed || b.value > 0.5);
      const edge = (i: number) => !!held[i] && !this.padPrev[i];
      const [lx, ly] = deadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
      if (lx !== 0 || ly !== 0) {
        sx = lx;
        sy = -ly; // pushing the stick up reports a negative value
        this.setDevice('gamepad');
      }
      // A held trigger turns the face buttons into hotbar slots, so they mustn't also jump,
      // attack or slide.
      const lt = !!held[PAD.LT];
      const rt = !!held[PAD.RT];
      if (lt || rt) {
        const base = lt ? 0 : 4;
        for (let k = 0; k < PAD_FACE.length; k++) if (edge(PAD_FACE[k])) abilitySlot = base + k + 1;
      } else {
        if (edge(PAD_BINDINGS.jump)) jumpPressed = true;
        if (held[PAD_BINDINGS.jump]) jumpHeld = true;
        if (edge(PAD_BINDINGS.attack)) attackPressed = true;
        if (edge(PAD_BINDINGS.slide)) slidePressed = true;
      }
      for (let k = 0; k < PAD_MOVEMENT.length; k++) {
        if (edge(PAD_MOVEMENT[k])) movementSlot = k + 1;
        if (held[PAD_MOVEMENT[k]] && movementHeld === 0) movementHeld = k + 1;
      }
      if (held[PAD_BINDINGS.sprint]) sprintHeld = true;
      if (held[PAD_BINDINGS.crouch]) crouchHeld = true;
      if (held.some((h, i) => h && !this.padPrev[i])) this.setDevice('gamepad');
      this.padPrev = held;
    }

    const fx = Math.sin(camYaw);
    const fz = Math.cos(camYaw);
    // Right of the camera's forward direction is (-fz, fx).
    return {
      moveX: fx * sy - fz * sx,
      moveZ: fz * sy + fx * sx,
      jumpPressed,
      jumpHeld,
      attackPressed,
      slidePressed,
      abilitySlot,
      movementSlot,
      movementHeld,
      sprintHeld,
      crouchHeld,
      aimX: 0, // aim assist (main.ts) fills these in when you attack or cast
      aimZ: 0,
      faceX: 0, // and these in combat, to strafe rather than turn
      faceZ: 0,
      stickX: sx,
      stickY: sy,
    };
  }

  // Held abilities and target switches, read once per rendered frame. Separate from pollActions()
  // so holding a button to aim never consumes the press that fires it.
  pollCombat(): CombatInput {
    const out: CombatInput = {
      slotHeld: HOTBAR_KEYS.findIndex((k) => this.down.has(k)) + 1,
      nextTarget: this.combat.nextTarget,
      prevTarget: this.combat.prevTarget,
      cancel: this.combat.cancel,
      stickX: 0,
      stickY: 0,
      movementHeld: MOVEMENT_KEYS.findIndex((k) => this.down.has(k)) + 1,
    };
    this.combat = { nextTarget: 0, prevTarget: 0, cancel: 0 };
    const pad = this.pad();
    if (pad) {
      const held = pad.buttons.map((b) => b.pressed || b.value > 0.5);
      const edge = (i: number) => !!held[i] && !this.combatPadPrev[i];
      const lt = !!held[PAD.LT];
      const rt = !!held[PAD.RT];
      if (lt || rt) {
        const base = lt ? 0 : 4;
        const face = PAD_FACE.findIndex((btn) => held[btn]);
        if (face >= 0) out.slotHeld = base + face + 1;
      }
      const [lx, ly] = deadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
      out.stickX = lx;
      out.stickY = -ly; // pushing the stick up reports a negative value
      // The bumpers run movement skills now, so the D-pad cycles targets.
      if (edge(PAD.RIGHT)) out.nextTarget++;
      if (edge(PAD.LEFT)) out.prevTarget++;
      for (let k = 0; k < PAD_MOVEMENT.length; k++) if (held[PAD_MOVEMENT[k]]) out.movementHeld = k + 1;
      this.combatPadPrev = held;
    }
    return out;
  }

  /** Open-world presses since the last call: keys, plus Y / Menu / D-pad on a controller. */
  pollLife(): LifeKey[] {
    const out = this.lifePresses;
    this.lifePresses = [];
    const pad = this.pad();
    if (pad) {
      const held = pad.buttons.map((b) => b.pressed || b.value > 0.5);
      const edge = (i: number) => !!held[i] && !this.lifePadPrev[i];
      const trigger = !!held[PAD.LT] || !!held[PAD.RT];
      if (edge(PAD.Y) && !trigger) out.push('interact');
      if (edge(PAD.MENU)) out.push('bag');
      if (this.worldMode && edge(PAD.DOWN)) out.push('mount');
      if (this.worldMode && edge(PAD.UP)) out.push('map');
      this.lifePadPrev = held;
    }
    return out;
  }

  rumble(strong: number, weak: number, ms: number): void {
    if (this.lastDevice !== 'gamepad') return;
    const pad = this.pad() as (Gamepad & { vibrationActuator?: Rumbler | null }) | null;
    const effect = pad?.vibrationActuator?.playEffect?.('dual-rumble', {
      startDelay: 0,
      duration: ms,
      strongMagnitude: strong,
      weakMagnitude: weak,
    });
    effect?.catch(() => {});
  }
}
