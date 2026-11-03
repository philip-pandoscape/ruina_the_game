import type { Actions } from '../sim/types';
import { CAMERA, GAMEPAD } from '../tuning';

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
  slide: ['ShiftLeft', 'ShiftRight', 'KeyK'],
  ability1: ['KeyE', 'Mouse2'],
  ability2: ['KeyQ'],
};

const PAD_BINDINGS = { jump: PAD.A, attack: PAD.X, slide: PAD.B, ability1: PAD.Y, ability2: PAD.RB };

const BLOCK_DEFAULT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

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
  private mouseDX = 0;
  private mouseDY = 0;
  private wheel = 0;
  private padPrev: boolean[] = [];
  private menuPresses: MenuPress[] = [];
  private menuPadPrev: boolean[] = [];
  private menuStick = '';

  constructor(canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (BLOCK_DEFAULT.has(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      if (!e.repeat && MENU_KEYS[e.code] && this.menuPresses.length < 16) this.menuPresses.push(MENU_KEYS[e.code]);
      this.down.add(e.code);
      this.setDevice('keyboard');
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
    canvas.addEventListener('mousedown', (e) => {
      this.setDevice('keyboard');
      if (document.pointerLockElement !== canvas) {
        // First click captures the mouse for camera control.
        try {
          void Promise.resolve(canvas.requestPointerLock()).catch(() => {});
        } catch {
          /* pointer lock not available */
        }
        return;
      }
      if (e.button === 0) this.pressed.add('Mouse0');
      if (e.button === 2) this.pressed.add('Mouse2');
    });
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== canvas) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    canvas.addEventListener('wheel', (e) => (this.wheel += e.deltaY), { passive: true });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // right-click is an ability
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
    let dYaw = -this.mouseDX * CAMERA.mouseSensitivity;
    let dPitch = this.mouseDY * CAMERA.mouseSensitivity;
    let dZoom = this.wheel * 0.0015;
    this.mouseDX = 0;
    this.mouseDY = 0;
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
      // D-pad up/down zooms.
      if (pad.buttons[PAD.UP]?.pressed) dZoom -= 1.6 * dt;
      if (pad.buttons[PAD.DOWN]?.pressed) dZoom += 1.6 * dt;
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
    let ability1Pressed = this.anyPressed(KEYS.ability1);
    let ability2Pressed = this.anyPressed(KEYS.ability2);
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
      if (edge(PAD_BINDINGS.jump)) jumpPressed = true;
      if (held[PAD_BINDINGS.jump]) jumpHeld = true;
      if (edge(PAD_BINDINGS.attack)) attackPressed = true;
      if (edge(PAD_BINDINGS.slide)) slidePressed = true;
      if (edge(PAD_BINDINGS.ability1)) ability1Pressed = true;
      if (edge(PAD_BINDINGS.ability2)) ability2Pressed = true;
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
      ability1Pressed,
      ability2Pressed,
      aimX: 0, // aim assist (main.ts) fills these in when you attack or cast
      aimZ: 0,
    };
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
