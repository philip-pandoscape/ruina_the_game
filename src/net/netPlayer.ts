import * as THREE from 'three';
import type { Sim } from '../sim/sim';
import { ON_FOOT, type Actions, type PlayerState } from '../sim/types';
import { emptySkills } from '../skills';
import { HOTBAR_SLOTS, MOVEMENT_SKILL_CAP, MOVEMENT_SLOTS, MP, NO_ABILITY, NO_MOVEMENT, STAMINA } from '../tuning';
import type { RawInput, WorldFeed } from './worldFeed';
import { TAU } from '../util/math';

// ---------- Your own fighter: predict instantly, correct when the server answers ----------

// Inputs travel to the server as small integers. Your own prediction uses exactly the same
// rounded values, so the browser and the server run identical inputs. Aim is in quarter metres.
// The raw stick (vehicles steer with it) only goes to open worlds, as two more bytes.
export function quantize(a: Actions): { actions: Actions; raw: RawInput; stick: [number, number] } {
  const toByte = (v: number) => Math.max(-127, Math.min(127, Math.round(v)));
  const qx = toByte(a.moveX * 127);
  const qz = toByte(a.moveZ * 127);
  const ax = toByte(a.aimX * 4);
  const az = toByte(a.aimZ * 4);
  const sx = toByte(a.stickX * 127);
  const sy = toByte(a.stickY * 127);
  const slot = a.abilitySlot >= 1 && a.abilitySlot <= HOTBAR_SLOTS ? a.abilitySlot : 0;
  // One byte carries both: hotbar slots first, then the movement slots after them.
  const move = a.movementSlot >= 1 && a.movementSlot <= MOVEMENT_SLOTS ? a.movementSlot : 0;
  const packed = move ? HOTBAR_SLOTS + move : slot;
  const held = a.movementHeld >= 1 && a.movementHeld <= MOVEMENT_SLOTS ? a.movementHeld : 0;
  const buttons =
    (a.jumpPressed ? 1 : 0) | (a.jumpHeld ? 2 : 0) | (a.attackPressed ? 4 : 0) | (a.slidePressed ? 8 : 0) | (a.sprintHeld ? 16 : 0) | (a.crouchHeld ? 32 : 0);
  // Combat stance heading in 255 steps, 0 for none (face_axis in crates/server/src/protocol.rs).
  const facing = Math.hypot(a.faceX, a.faceZ) >= 0.5 ? ((Math.atan2(a.faceX, a.faceZ) % TAU) + TAU) % TAU : -1;
  const face = facing < 0 ? 0 : 1 + (Math.round(facing / (TAU / 255)) % 255);
  const yaw = ((face - 1) * TAU) / 255;
  return {
    actions: {
      ...a,
      moveX: qx / 127,
      moveZ: qz / 127,
      aimX: ax / 4,
      aimZ: az / 4,
      faceX: face ? Math.sin(yaw) : 0,
      faceZ: face ? Math.cos(yaw) : 0,
      stickX: sx / 127,
      stickY: sy / 127,
      abilitySlot: slot,
      movementSlot: move,
      movementHeld: held,
    },
    raw: [qx & 255, qz & 255, buttons, ax & 255, az & 255, packed, held, face],
    stick: [sx & 255, sy & 255],
  };
}

function clonePlayer(p: PlayerState): PlayerState {
  return { ...p, pos: { ...p.pos }, prevPos: { ...p.prevPos }, vel: { ...p.vel } };
}

export class Prediction {
  seq = 0;
  lastAck = 0;
  corrections = 0; // how many server updates moved us noticeably
  maxCorrection = 0; // biggest single correction, in metres
  lastCorrection = 0;
  readonly offset = new THREE.Vector3(); // eases corrections in instead of snapping
  private pending: Array<{ seq: number; actions: Actions }> = [];
  private synced = false;
  /**
   * Open worlds: puts back the parts of the island that move with you (your vehicles, the clock),
   * as of the same server update, before your unconfirmed inputs are run again on top of it.
   */
  beforeReplay: (() => void) | null = null;

  constructor(
    private sim: Sim,
    private net: WorldFeed,
  ) {}

  get pendingCount(): number {
    return this.pending.length;
  }

  // Runs one frame of your input immediately and sends it to the server, along with which server
  // tick the other players are drawn at, so the server can check your swings against what you saw.
  step(a: Actions): void {
    const { actions, raw, stick } = quantize(a);
    this.seq++;
    this.pending.push({ seq: this.seq, actions });
    if (this.pending.length > 600) this.pending.shift();
    const view = Math.max(0, Math.round(this.net.renderTick(performance.now()) * 16));
    this.net.sendInput(this.seq, view, raw, stick);
    this.sim.step(actions);
  }

  // The server's word on where you are: start from it and replay the inputs it hasn't used yet.
  reconcile(ack: number, server: PlayerState): void {
    this.lastAck = Math.max(this.lastAck, ack);
    this.pending = this.pending.filter((p) => p.seq > ack);
    if (!this.synced) {
      // First update after joining: just take the server's spawn position.
      this.synced = true;
      this.sim.player = clonePlayer(server);
      this.beforeReplay?.();
      return;
    }
    const before = { ...this.sim.player.pos };
    const prevPos = { ...this.sim.player.prevPos };
    const was = this.sim.player;
    this.sim.player = clonePlayer(server);
    this.beforeReplay?.();
    // The replay runs the last few frames again rather than new ones, so it numbers them as they
    // were: the frame count is the clock everything is drawn by (src/render/character.ts), and
    // counting a round trip's worth of frames again on every server update ran it two to four
    // times as fast as time, in jerks.
    this.sim.frame -= this.pending.length;
    for (const p of this.pending) this.sim.step(p.actions);
    this.sim.drainEvents(); // replays shouldn't repeat dust puffs and other effects
    if (this.pending.length === 0) this.sim.player.prevPos = prevPos;

    const after = this.sim.player.pos;
    const dx = before.x - after.x;
    const dy = before.y - after.y;
    const dz = before.z - after.z;
    const err = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (err > 0.001) {
      this.corrections++;
      this.lastCorrection = err;
      this.maxCorrection = Math.max(this.maxCorrection, err);
      // Small corrections ease in; big ones (respawns, long knockbacks) snap. So does getting into
      // a seat or out of one (the server's answer to your F): eased, you'd be drawn sliding up from
      // the ground, and the vehicle, drawn under you, sinking into it and back.
      const seated = (q: PlayerState) => (q.mode === 'ride' ? `${q.host}:${q.vehicle}:${q.seat}` : '');
      if (err < 3 && seated(was) === seated(this.sim.player)) this.offset.add(new THREE.Vector3(dx, dy, dz));
      else this.offset.set(0, 0, 0);
    }
  }

  /** Tests: counts corrections afresh from here (a teleport is one, by the server's own hand). */
  clearCorrections(): void {
    this.corrections = 0;
    this.maxCorrection = 0;
    this.lastCorrection = 0;
  }

  ease(dt: number): void {
    this.offset.multiplyScalar(Math.exp(-dt * 12));
  }

  /** Starts over from the server's next word (a new connection: it counts inputs from scratch). */
  resync(): void {
    this.synced = false;
    this.pending = [];
    this.offset.set(0, 0, 0);
  }
}

/**
 * A player's state as the open world's server sends it (crates/server/src/play/mod.rs
 * player_state_json): the same fields as PlayerState, so only what JSON can't carry is filled in.
 */
export function stateFromServer(p: Record<string, unknown>): PlayerState {
  const s = { ...blankState(), ...(p as Partial<PlayerState>) } as PlayerState;
  s.pos = { ...(s.pos ?? { x: 0, y: 0, z: 0 }) };
  s.vel = { ...(s.vel ?? { x: 0, y: 0, z: 0 }) };
  s.prevPos = { ...s.pos };
  s.prevFacing = s.facing;
  return s;
}

export function blankState(): PlayerState {
  return {
    pos: { x: 0, y: 0, z: 0 },
    prevPos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    facing: 0,
    prevFacing: 0,
    mode: 'normal',
    grounded: true,
    jumpsUsed: 0,
    jumpCutDone: true,
    coyote: 0,
    jumpBuffer: 0,
    attackBuffer: 0,
    actionBuffer: 0,
    actionBufferId: NO_MOVEMENT,
    attackIndex: 0,
    attackFrame: 0,
    attackQueued: false,
    attackHit: false,
    flipFrame: -1,
    landFrame: 999,
    landImpact: 0.5,
    takeoffFrame: 999,
    runPhase: 0,
    hp: 100,
    stamina: STAMINA.max,
    staminaDelay: 0,
    mp: MP.max,
    stun: 0,
    downFrame: -1,
    team: 0,
    weapon: 0,
    skills: emptySkills(),
    comboVariants: 0,
    abilities: new Array<number>(HOTBAR_SLOTS).fill(NO_ABILITY),
    cooldowns: new Array<number>(HOTBAR_SLOTS).fill(0),
    movement: new Array<number>(MOVEMENT_SLOTS).fill(NO_MOVEMENT),
    movementCooldowns: new Array<number>(MOVEMENT_SKILL_CAP).fill(0),
    actionId: NO_MOVEMENT,
    actionFrame: 0,
    actionDirX: 0,
    actionDirZ: 1,
    actionSlot: 0,
    abilityBuffer: 0,
    abilityBufferSlot: 0,
    sprinting: false,
    crouching: false,
    crouchFrame: 0,
    castAbility: 255,
    castSlot: 0,
    castFrame: 0,
    castTargetX: 0,
    castTargetZ: 0,
    firedAbility: 255,
    ...ON_FOOT,
  };
}
