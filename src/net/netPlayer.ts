import * as THREE from 'three';
import { Hero } from '../render/character';
import type { Sim } from '../sim/sim';
import { ON_FOOT, type Actions, type PlayerState } from '../sim/types';
import { comboShape } from '../tuning';
import { emptySkills } from '../skills';
import { MODE_DOWN, MODES } from './netCrowd';
import { HOTBAR_SLOTS, MOVEMENT_SKILL_CAP, MOVEMENT_SLOTS, MP, NO_ABILITY, NO_MOVEMENT, STAMINA } from '../tuning';
import type { NetCrowd, RawInput, RemoteRecord } from './netCrowd';
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
    (a.jumpPressed ? 1 : 0) |
    (a.jumpHeld ? 2 : 0) |
    (a.attackPressed ? 4 : 0) |
    (a.slidePressed ? 8 : 0) |
    (a.sprintHeld ? 16 : 0) |
    (a.crouchHeld ? 32 : 0);
  // Combat stance heading in 255 steps, 0 for none (face_axis in crates/server/src/protocol.rs).
  const facing = Math.hypot(a.faceX, a.faceZ) >= 0.5 ? (((Math.atan2(a.faceX, a.faceZ) % TAU) + TAU) % TAU) : -1;
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
    private net: NetCrowd,
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
 * A player's state as the open world's server sends it (crates/server/src/world_game.rs
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

// ---------- Other players: drawn with the full character, a fixed moment in the past ----------
//
// Each update is kept with its server tick. Other players are drawn at netCrowd.renderTick(),
// blending between the two updates around it. Because that tick is also sent with your inputs,
// the server can rewind them to exactly what you saw when it checks your swings.

interface Remote {
  hero: Hero;
  buffer: Array<{ tick: number; rec: RemoteRecord }>;
  shown: PlayerState;
  shownHp: number;
  runPhase: number;
  seen: number; // server tick of the newest update that included this player
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

function angleLerp(a: number, b: number, t: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

export class RemotePlayers {
  onHurt: ((x: number, y: number, z: number, damage: number, dirX: number, dirZ: number) => void) | null = null;
  private remotes = new Map<number, Remote>();

  constructor(private scene: THREE.Scene) {}

  get count(): number {
    return this.remotes.size;
  }

  list(): Array<{ id: number; x: number; z: number; hp: number; team: number; weapon: number }> {
    return [...this.remotes.values()].map((r) => ({ id: r.buffer[r.buffer.length - 1].rec.id, x: r.shown.pos.x, z: r.shown.pos.z, hp: r.shownHp, team: r.shown.team, weapon: r.shown.weapon }));
  }

  // Every other player as drawn right now (for cast warnings and aiming).
  shown(): PlayerState[] {
    return [...this.remotes.values()].map((r) => r.shown);
  }

  // A new update from the server, for server tick `tick`.
  receive(records: RemoteRecord[], tick: number): void {
    for (const rec of records) {
      let r = this.remotes.get(rec.id);
      if (!r) {
        const hero = new Hero();
        hero.setTeam(rec.team);
        // The battlefield is all fight: weapons stay out.
        hero.armed = true;
        this.scene.add(hero.root);
        const shown = blankState();
        shown.pos = { x: rec.x, y: rec.y, z: rec.z };
        r = { hero, buffer: [], shown, shownHp: rec.hp, runPhase: 0, seen: tick };
        this.remotes.set(rec.id, r);
      }
      r.buffer.push({ tick, rec });
      if (r.buffer.length > 40) r.buffer.shift();
      r.seen = tick;
    }
    for (const [id, r] of this.remotes) {
      if (tick - r.seen > 20) {
        this.scene.remove(r.hero.root);
        this.remotes.delete(id);
      }
    }
  }

  // Poses every other player as they were at server tick `at`.
  frame(at: number, dt: number, frame: number, framesPerTick: number): void {
    for (const r of this.remotes.values()) {
      const buf = r.buffer;
      // The two updates either side of `at` (or the nearest one if we're outside the buffer).
      let k = buf.length - 1;
      while (k > 0 && buf[k].tick > at) k--;
      const a = buf[k];
      const b = buf[Math.min(k + 1, buf.length - 1)];
      const span = b.tick - a.tick;
      // A jump of more than a few metres between two updates is a respawn: switch over instantly
      // rather than sliding them across the field.
      const teleport = Math.hypot(b.rec.x - a.rec.x, b.rec.z - a.rec.z) > 4;
      const f = span > 0 && !teleport ? Math.min(1, Math.max(0, (at - a.tick) / span)) : 0;
      const rec = a.rec;
      const { shown } = r;
      const prevY = shown.pos.y;
      shown.pos = { x: rec.x + (b.rec.x - rec.x) * f, y: rec.y + (b.rec.y - rec.y) * f, z: rec.z + (b.rec.z - rec.z) * f };
      shown.prevPos = { ...shown.pos };
      shown.facing = shown.prevFacing = angleLerp(rec.yaw, b.rec.yaw, f);
      shown.vel = { x: rec.vx, y: dt > 0 ? (shown.pos.y - prevY) / dt : 0, z: rec.vz };
      shown.grounded = rec.grounded;
      shown.team = rec.team;
      shown.hp = rec.hp;
      shown.stun = rec.stun;
      shown.downFrame = rec.mode === MODE_DOWN ? 1 : -1;
      shown.mode = MODES[rec.mode] ?? 'normal';
      shown.weapon = rec.weapon;
      shown.comboVariants = rec.comboVariants;
      shown.actionId = rec.actionId;
      shown.actionFrame = rec.actionFrame;
      shown.castAbility = rec.castAbility;
      shown.castFrame = rec.castFrame;
      shown.castTargetX = rec.castTargetX;
      shown.castTargetZ = rec.castTargetZ;
      // Animation counters advance smoothly between updates.
      const ahead = Math.max(0, Math.floor((at - a.tick) * framesPerTick));
      const combo = comboShape(rec.weapon, rec.comboVariants);
      const step = combo[rec.attackIndex] ?? combo[0];
      shown.attackIndex = rec.attackIndex;
      shown.attackFrame = Math.min(rec.attackFrame + ahead, step.startup + step.active + step.recovery);
      shown.flipFrame = rec.flipFrame >= 0 ? rec.flipFrame + ahead : -1;
      shown.landFrame = Math.min(999, rec.landFrame + ahead);
      if (shown.mode === 'normal' && shown.grounded) r.runPhase += Math.hypot(rec.vx, rec.vz) * dt;
      shown.runPhase = r.runPhase;
      r.hero.update(shown, 1, frame);

      // Show the hit when the on-screen version of them takes the damage.
      if (rec.hp < r.shownHp && this.onHurt) {
        this.onHurt(shown.pos.x, shown.pos.y + 1.1, shown.pos.z, r.shownHp - rec.hp, -Math.sin(shown.facing), -Math.cos(shown.facing));
      }
      r.shownHp = rec.hp;
    }
  }
}
