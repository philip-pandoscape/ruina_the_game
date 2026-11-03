import * as THREE from 'three';
import { loadBuild, pointsLeft, saveBuild, validBuild } from './build';
import { CROWD_TICK, CrowdSim } from './crowd/crowdSim';
import { CrowdView, type CrowdSource } from './crowd/crowdView';
import { Input } from './input/input';
import { NetCrowd } from './net/netCrowd';
import { Prediction, RemotePlayers } from './net/netPlayer';
import { NetSpells } from './net/netSpells';
import { FollowCamera } from './render/camera';
import { Hero } from './render/character';
import { TrainingDummy } from './render/dummy';
import { Hud } from './render/hud';
import { BATTLEFIELD_STAGE, Stage, TRAINING_STAGE } from './render/scene';
import { CIRCLE, SpellView } from './render/spells';
import { Vfx } from './render/vfx';
import { Sim } from './sim/sim';
import { TrainingRange } from './sim/training';
import { NO_ACTIONS, type Actions, type GameEvent, type PlayerState } from './sim/types';
import { makeBattlefield, makeWorld } from './sim/world';
import { ABILITY_ICONS, WEAPON_ICONS, WEAPON_NAMES } from './ui/icons';
import { SkillTreePanel } from './ui/skillTree';
import { ABILITIES, abilityOfKind, CAST, castFramesFor, comboFor, COMBAT, DUMMY, NO_ABILITY, STEP, type Build } from './tuning';

// URL options:
//   ?test          start paused so automated tests can step the game frame by frame
//   ?raid=10000    raid stress test: two armies of fighters on a big battlefield
//   &outline=0     raid without character outlines (to compare speed)
//   ?server=ws://localhost:7777   play on the Rust battle server (server/)
//     &team=0|1    which side to join (default: whichever the server picks)
//     &play=0      just watch instead of joining
//     &lag=150     testing: ask the server to delay this connection by 150 ms each way
const params = new URLSearchParams(location.search);
const testMode = params.has('test');
const serverUrl = params.get('server');
const raidCount = !serverUrl && params.has('raid') ? Math.max(100, Math.min(50000, Number(params.get('raid')) || 10000)) : 0;
const battlefield = raidCount > 0 || !!serverUrl;
const team = params.has('team') ? Number(params.get('team')) & 1 : 255;
const lagMs = Math.max(0, Math.min(2000, Number(params.get('lag')) || 0));

const canvas = document.getElementById('game') as HTMLCanvasElement;
const world = battlefield ? makeBattlefield() : makeWorld();
// Online, the server decides hits, so the local rules run without the training dummy and hit pause.
const sim = new Sim(world, { training: !serverUrl });
// Your skills and loadout, kept between visits. Online, the server checks it and sends it back.
let build: Build = loadBuild();
sim.setBuild(build);
const range = serverUrl ? null : new TrainingRange(sim);
const stage = new Stage(canvas, world, battlefield ? BATTLEFIELD_STAGE : TRAINING_STAGE);
const hero = new Hero();
stage.scene.add(hero.root);
const dummy = new TrainingDummy(world.dummy.x, world.dummy.z);
dummy.root.visible = !serverUrl;
stage.scene.add(dummy.root);
const vfx = new Vfx(stage.scene);
const spells = new SpellView(stage.scene, vfx);
const follow = new FollowCamera(innerWidth / innerHeight, battlefield ? 1200 : 320, battlefield ? 160 : 14);
follow.reset(world.spawn.facing);
const input = new Input(canvas);
const hud = new Hud();
hud.setDevice(input.lastDevice);
input.onDeviceChange = (d) => hud.setDevice(d);
const panel = new SkillTreePanel(build);
panel.onChange = applyBuild;
hud.onSkillsClick = () => panel.toggle();
const METEOR = ABILITIES[abilityOfKind(CAST.meteor)];
const HEAL = ABILITIES[abilityOfKind(CAST.heal)];
const DEG = Math.PI / 180;

// The raid's fighters come either from a local sim (?raid) or from the battle server (?server).
const crowd = raidCount ? new CrowdSim(raidCount) : null;
const net = serverUrl ? new NetCrowd(serverUrl) : null;
const netSpells = net ? new NetSpells(net) : null;
const crowdSource: CrowdSource | null = crowd ?? net;
let crowdView: CrowdView | null = null;
function addCrowdView(n: number): void {
  crowdView = new CrowdView(n, params.get('outline') !== '0');
  stage.scene.add(crowdView.group);
}
if (crowd) addCrowdView(crowd.n);
let crowdAcc = 0;
let lastViewSent = 0;

// Online play: your fighter is predicted locally and corrected by the server; other players are drawn
// from the server's updates.
const playing = !!net && params.get('play') !== '0';
const prediction = net && playing ? new Prediction(sim, net) : null;
const remotes = net ? new RemotePlayers(stage.scene) : null;
let lastSnapshot = 0;
let lastHp: number = COMBAT.maxHp;
let shownTeam = -1;
let scripted: Actions[] = []; // test hook: replaces the controller for a few frames
let autoAttack = false; // test hook: swing at the nearest enemy you can see
let autoCooldown = 0;
if (net) {
  net.onReady = (n) => {
    addCrowdView(n);
    if (playing) {
      net.join(team);
      net.sendBuild(build.perks, build.weapon, build.ability1, build.ability2);
    }
    if (lagMs) net.setLag(lagMs);
  };
}
if (net && !playing) hud.hideAbilities();

// A new build from the skill panel: save it, and use it (online, the server switches you over).
function applyBuild(b: Build): void {
  build = b;
  saveBuild(b);
  if (net) net.sendBuild(b.perks, b.weapon, b.ability1, b.ability2);
  else sim.setBuild(b);
}
if (remotes) {
  remotes.onHurt = (x, y, z, damage, dirX, dirZ) => {
    vfx.onEvent({ type: 'hit', frame: 0, index: damage >= 25 ? 2 : 0, damage, x, y, z, dirX, dirZ });
    hud.damage(x, y, z, damage, damage >= 25);
  };
}

// Test hook: swing at the nearest enemy you can see within reach (players first, then bots),
// using the positions drawn on this screen.
function autoAim(a: Actions): Actions {
  if (autoCooldown > 0) {
    autoCooldown--;
    return a;
  }
  const me = sim.player.pos;
  let best: { x: number; z: number } | null = null;
  let bestD = 2.3;
  for (const r of remotes?.list() ?? []) {
    const d = Math.hypot(r.x - me.x, r.z - me.z);
    if (r.team !== sim.player.team && r.hp > 0 && d < bestD) {
      bestD = d;
      best = r;
    }
  }
  if (!best && net) {
    for (let i = 0; i < net.n; i++) {
      if (!net.known[i] || net.down[i] || net.team[i] === sim.player.team) continue;
      const d = Math.hypot(net.rx[i] - me.x, net.rz[i] - me.z);
      if (d < bestD) {
        bestD = d;
        best = { x: net.rx[i], z: net.rz[i] };
      }
    }
  }
  if (!best) return a;
  autoCooldown = 30;
  const dx = best.x - me.x;
  const dz = best.z - me.z;
  const l = Math.hypot(dx, dz) || 1;
  return { ...a, moveX: dx / l, moveZ: dz / l, attackPressed: true };
}

// Enemies you could aim at, where they're drawn on this screen: the dummy, other players, bots.
function forEachEnemy(fn: (x: number, z: number) => void): void {
  const myTeam = sim.player.team;
  if (!serverUrl && sim.dummy.brokenFrame < 0) fn(sim.dummy.x, sim.dummy.z);
  for (const r of remotes?.list() ?? []) if (r.team !== myTeam && r.hp > 0) fn(r.x, r.z);
  if (net) {
    for (let i = 0; i < net.n; i++) if (net.known[i] && !net.down[i] && net.team[i] !== myTeam) fn(net.rx[i], net.rz[i]);
  }
}

function enemyAt(x: number, z: number, r: number): boolean {
  let hit = false;
  forEachEnemy((ex, ez) => {
    if (!hit && (ex - x) * (ex - x) + (ez - z) * (ez - z) < r * r) hit = true;
  });
  return hit;
}

// Aim assist: attacks and Meteor go toward the enemy you most likely mean, the nearest one close
// to the direction you're pushing (or facing; the bow and Meteor use the camera's direction when you
// stand still). With nothing to aim at, the bow and Meteor still go where the camera looks. The rules
// only read the aim when an attack or cast starts, so it's only worked out while one is pending.
function aimAssist(a: Actions): Actions {
  if (a.aimX !== 0 || a.aimZ !== 0) return a; // already aimed (tests)
  const p = sim.player;
  const isMeteor = (ability: number) => ability !== NO_ABILITY && ABILITIES[ability].kind === 'meteor';
  const casting =
    ((a.ability1Pressed || p.abilityBuffer1 > 0) && isMeteor(p.ability1)) || ((a.ability2Pressed || p.abilityBuffer2 > 0) && isMeteor(p.ability2));
  const attacking = a.attackPressed || p.attackBuffer > 0 || p.attackQueued;
  if (!casting && !attacking) return a;
  const bow = p.weapon === 3;
  const ranged = casting || bow;
  const moving = Math.hypot(a.moveX, a.moveZ) > 0.3;
  const dir = moving ? Math.atan2(a.moveX, a.moveZ) : ranged ? follow.yaw : p.facing;
  const swing = comboFor(p.weapon, p.perks)[0];
  const maxDist = casting ? (METEOR.maxRange ?? 16) : bow ? Math.min(30, swing.projectileRange ?? 30) : swing.reach + 1.6;
  const cone = (casting ? 30 : bow ? 14 : 55) * DEG;
  let best: { x: number; z: number } | null = null;
  let bestScore = Infinity;
  forEachEnemy((x, z) => {
    const dx = x - p.pos.x;
    const dz = z - p.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > maxDist || dist < 0.05) return;
    let off = Math.abs(Math.atan2(dx, dz) - dir) % (Math.PI * 2);
    if (off > Math.PI) off = Math.PI * 2 - off;
    if (off > cone) return;
    const score = dist / maxDist + off / cone;
    if (score < bestScore) {
      bestScore = score;
      best = { x, z };
    }
  });
  const target = best as { x: number; z: number } | null;
  if (target) return { ...a, aimX: target.x - p.pos.x, aimZ: target.z - p.pos.z };
  if (!ranged || moving) return a;
  const reach = casting ? (METEOR.range ?? 9) : 20;
  return { ...a, aimX: Math.sin(dir) * reach, aimZ: Math.cos(dir) * reach };
}

// Picks up a new server update: correct your prediction and refresh the other players.
function syncNet(): void {
  if (!net || net.snapshots === lastSnapshot) return;
  lastSnapshot = net.snapshots;
  if (prediction && net.you) {
    prediction.reconcile(net.you.ack, net.you.player);
    const hp = net.you.player.hp;
    if (hp < lastHp) {
      follow.shake(0.35);
      input.rumble(0.7, 0.5, 120);
    }
    lastHp = hp;
    if (shownTeam !== net.you.player.team) {
      shownTeam = net.you.player.team;
      hero.setTeam(shownTeam);
    }
  }
  remotes?.receive(net.players, net.lastTick);
  netSpells?.receive(net.you?.id ?? null);
}

// Soft round shadow right under the player, so you can always see where you'll land.
const blobMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false });
const blob = new THREE.Mesh(new THREE.CircleGeometry(0.42, 24).rotateX(-Math.PI / 2), blobMat);
blob.renderOrder = 1;
stage.scene.add(blob);

function resize(): void {
  stage.resize(innerWidth, innerHeight);
  follow.resize(innerWidth / innerHeight);
}
addEventListener('resize', resize);
resize();

const simPos = new THREE.Vector3();
const dummyTop = new THREE.Vector3();

// One fixed sim step, plus the effects its events trigger.
function stepOnce(actions: Actions): void {
  if (prediction) {
    if (!net?.you) return; // wait until the server has placed us
    prediction.step(actions);
  } else {
    sim.step(actions);
  }
  let events = sim.drainEvents();
  if (range) {
    // Training: arrows, meteors and heals against the dummy.
    range.step(events);
    events = events.concat(sim.drainEvents());
  }
  if (netSpells) {
    // Online: your own arrows, meteors and heals show straight away.
    const local = events.flatMap((e) => netSpells.local(e));
    events = events.concat(local, netSpells.step(STEP, sim.frame, enemyAt));
  }
  for (const e of events) showEvent(e);
  const p = sim.player;
  if (p.mode === 'slide' && sim.frame % 2 === 0) vfx.slideDust(p.pos.x, p.pos.z, p.slideDirX, p.slideDirZ);
  vfx.step(STEP);
  hud.step(STEP);
}

// Effects, camera shake, rumble and damage numbers for something that happened.
function showEvent(e: GameEvent): void {
  vfx.onEvent(e);
  if (e.type === 'hit') {
    const big = e.index === 2;
    follow.shake(comboFor(sim.player.weapon, sim.player.perks)[e.index]?.shake ?? 0.3);
    input.rumble(big ? 0.9 : 0.45, big ? 1.0 : 0.6, big ? 160 : 90);
    hud.damage(e.x, e.y, e.z, e.damage, big);
  } else if (e.type === 'land' && e.impact > 0.6) {
    follow.shake(0.15);
  } else if (e.type === 'dummyBreak') {
    follow.shake(0.5);
  } else if (e.type === 'explosion') {
    const d = Math.hypot(e.x - sim.player.pos.x, e.z - sim.player.pos.z);
    if (d < 16) {
      follow.shake(0.7 * (1 - d / 16));
      input.rumble(0.8 * (1 - d / 16), 0.6, 200);
    }
  } else if (e.type === 'cast') {
    hud.castFinished();
  }
}

// Ground warnings for a cast in progress: where a meteor will land, or the area a heal will cover.
function castCircle(p: PlayerState, x: number, z: number, hostile: boolean): void {
  if (p.mode !== 'cast' || p.castKind === 0) return;
  const k = p.castFrame / castFramesFor(abilityOfKind(p.castKind), p.perks);
  if (p.castKind === CAST.meteor) spells.circle(p.castTargetX, p.castTargetZ, METEOR.radius, k, hostile ? CIRCLE.enemy : CIRCLE.ally, 0.6);
  else spells.circle(x, z, HEAL.radius, k, CIRCLE.heal, 0.5);
}

// Arrows, meteors and cast warnings, drawn every frame.
function drawSpells(alpha: number, dt: number): void {
  spells.begin(dt, follow.yaw);
  if (range) {
    for (const a of range.arrows) {
      const back = a.speed * STEP * (1 - alpha); // blend between sim steps
      spells.arrow(a.x - a.dirX * back, a.y, a.z - a.dirZ * back, a.dirX, a.dirZ);
    }
    for (const m of range.meteors) spells.meteor(m.x, m.z, (m.frame + alpha) / m.fallFrames, METEOR.radius, false);
  }
  if (net && netSpells) {
    const renderTick = net.renderTick(performance.now());
    const ahead = prediction && net.you ? (prediction.seq - net.you.ack) / (60 / net.ticksPerSecond) : 0;
    const myId = playing ? (net.you?.id ?? null) : null;
    netSpells.draw(spells, renderTick, net.lastTick + ahead, myId, sim.player.team);
    for (const e of netSpells.due(renderTick, sim.frame)) showEvent(e);
    for (const r of remotes?.shown() ?? []) castCircle(r, r.pos.x, r.pos.z, r.team !== sim.player.team);
  }
  if (!net || playing) castCircle(sim.player, hero.root.position.x, hero.root.position.z, false);
  spells.end();
}

// The ability bar and cast bar.
function drawAbilityBar(): void {
  const p = sim.player;
  const slotAbility = p.castSlot === 1 ? p.ability1 : p.ability2;
  hud.setAbilities(
    {
      weapon: p.weapon,
      ability1: p.ability1,
      ability2: p.ability2,
      cooldown1: p.cooldown1,
      cooldown2: p.cooldown2,
      castKind: p.castKind,
      castSlot: p.castSlot,
      castFrame: p.castFrame,
      castFrames: p.castKind ? castFramesFor(slotAbility, p.perks) : 1,
      stun: p.stun,
      downFrame: p.downFrame,
    },
    input.lastDevice,
    pointsLeft(build.perks),
    {
      weapon: [WEAPON_ICONS[p.weapon] ?? '', WEAPON_NAMES[p.weapon] ?? ''],
      ability: (a) => (a === NO_ABILITY || !ABILITIES[a] ? null : [ABILITY_ICONS[a], ABILITIES[a].name]),
      cooldownFrames: (a) => ABILITIES[a]?.cooldownFrames ?? 1,
    },
  );
}

function followSim(dt: number): void {
  const p = sim.player.pos;
  follow.update(simPos.set(p.x, p.y, p.z), dt);
}

function draw(alpha: number, cameraDt: number, animDt: number): void {
  hero.update(sim.player, alpha, sim.frame);
  if (prediction) {
    prediction.ease(animDt);
    hero.root.position.add(prediction.offset);
  }
  dummy.update(sim.dummy);
  if (crowd) crowd.render(Math.min(1, crowdAcc / CROWD_TICK));
  if (net) net.frame(performance.now());
  if (net) remotes?.frame(net.renderTick(performance.now()), animDt, sim.frame, 60 / net.ticksPerSecond);
  if (crowdView && crowdSource) crowdView.update(crowdSource, animDt);
  drawSpells(alpha, animDt);
  if (!net || playing) drawAbilityBar();
  hud.setPlayerHp(prediction && net?.you ? sim.player.hp : null, COMBAT.maxHp, sim.player.team);
  const pos = hero.root.position;
  if (cameraDt > 0) follow.update(pos, cameraDt);
  stage.follow(pos.x, pos.z);

  const lift = Math.max(0.35, 1 - pos.y * 0.18);
  blob.position.set(pos.x, 0.02, pos.z);
  blob.scale.setScalar(lift);
  blobMat.opacity = 0.22 * lift;

  const timing = gpuTimerBegin();
  stage.renderer.render(stage.scene, follow.camera);
  if (timing) gpuTimerEnd();
  dummyTop.set(sim.dummy.x, 2.05, sim.dummy.z);
  hud.layout(follow.camera, innerWidth, innerHeight, dummyTop, sim.dummy.hp / DUMMY.hp, !serverUrl);
}

// ---------- Performance numbers ----------

const frameTimes: number[] = [];
let cpuMs = 0;

// Measures how long the graphics card spends drawing each frame (when the browser allows it).
// Unlike fps, this isn't capped at 60, so it shows how much headroom is left.
const gl = stage.renderer.getContext() as WebGL2RenderingContext;
const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
let gpuQuery: WebGLQuery | null = null;
let gpuMs = 0;

function gpuTimerBegin(): boolean {
  if (!timerExt) return false;
  if (gpuQuery) {
    if (!gl.getQueryParameter(gpuQuery, gl.QUERY_RESULT_AVAILABLE)) return false;
    if (!gl.getParameter(timerExt.GPU_DISJOINT_EXT)) {
      const ms = gl.getQueryParameter(gpuQuery, gl.QUERY_RESULT) / 1e6;
      gpuMs = gpuMs === 0 ? ms : gpuMs * 0.9 + ms * 0.1;
    }
    gl.deleteQuery(gpuQuery);
  }
  gpuQuery = gl.createQuery();
  gl.beginQuery(timerExt.TIME_ELAPSED_EXT, gpuQuery);
  return true;
}

function gpuTimerEnd(): void {
  if (timerExt) gl.endQuery(timerExt.TIME_ELAPSED_EXT);
}

function gpuName(): string {
  const gl = stage.renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
}

function perf() {
  const sorted = [...frameTimes].sort((a, b) => a - b);
  const avg = sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;
  const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
  const info = stage.renderer.info.render;
  return {
    avgMs: +avg.toFixed(2),
    p95Ms: +p95.toFixed(2),
    fps: avg > 0 ? Math.round(1000 / avg) : 0,
    cpuMs: +cpuMs.toFixed(2),
    gpuMs: timerExt ? +gpuMs.toFixed(2) : null,
    drawCalls: info.calls,
    triangles: info.triangles,
    particles: vfx.particleCount,
    fighters: crowdSource?.n ?? 0,
    downloadKBps: net ? +(net.bytesPerSec / 1024).toFixed(1) : null,
    messagesPerSec: net ? +net.messagesPerSec.toFixed(1) : null,
    server: net?.stats ?? null,
    crowdTickMs: crowd ? +crowd.tickMs.toFixed(2) : 0,
    crowdUploadMs: crowdView ? +crowdView.updateMs.toFixed(2) : 0,
    gpu: gpuName(),
  };
}

// ---------- Main loop ----------

let paused = testMode;
let acc = 0;
let last = performance.now();
let lastStats = 0;

function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  frameTimes.push(dt * 1000);
  if (frameTimes.length > 240) frameTimes.shift();
  const cpuStart = performance.now();

  if (!paused) {
    // The skill panel takes the controller while it's open (the world carries on around you).
    const menuOpen = panel.isOpen;
    for (const m of input.pollMenu()) {
      if (panel.isOpen) panel.menu(m);
      else if (m === 'toggle' && (!net || playing)) panel.open();
    }
    const cam = input.pollCamera(dt);
    if (!menuOpen) {
      follow.rotate(cam.dYaw, cam.dPitch);
      follow.zoom(cam.dZoom);
    }
    syncNet();
    acc += dt;
    let steps = 0;
    while (acc >= STEP && steps < 5) {
      const pad = input.pollActions(follow.yaw);
      const a = scripted.length ? scripted.shift()! : menuOpen ? NO_ACTIONS : pad;
      stepOnce(aimAssist(autoAttack ? autoAim(a) : a));
      acc -= STEP;
      steps++;
    }
    if (steps === 5) acc = 0; // don't spiral if the tab was in the background
    if (net && !playing && now - lastViewSent > 100) {
      lastViewSent = now;
      net.sendView(sim.player.pos.x, sim.player.pos.z);
    }
    if (crowd) {
      crowdAcc += dt;
      let ticks = 0;
      while (crowdAcc >= CROWD_TICK && ticks < 3) {
        crowd.step();
        crowdAcc -= CROWD_TICK;
        ticks++;
      }
      if (ticks === 3) crowdAcc = 0;
    }
    draw(acc / STEP, dt, dt);
  } else {
    draw(1, 0, 0);
  }
  cpuMs = cpuMs * 0.95 + (performance.now() - cpuStart) * 0.05;

  if (now - lastStats > 250) {
    lastStats = now;
    const s = perf();
    const base = `${s.fps} fps · ${s.drawCalls} draw calls · ${s.triangles.toLocaleString()} triangles`;
    const gpu = s.gpuMs !== null ? ` · GPU ${s.gpuMs} ms/frame` : '';
    if (net) {
      const srv = s.server;
      const server = srv
        ? ` · server: ${srv.realPlayers} real + ${srv.virtualPlayers.toLocaleString()} virtual players, ${srv.tickMs.toFixed(1)} ms per 50 ms tick`
        : '';
      hud.setStats(
        `${base} · ${s.fighters.toLocaleString()} fighters from server · download ${s.downloadKBps} KB/s${server}` +
          (net.connected ? '' : ' · NOT CONNECTED'),
      );
    } else if (crowd) {
      hud.setStats(`${base} · ${s.fighters.toLocaleString()} fighters · crowd sim ${s.crowdTickMs} ms/tick · CPU ${s.cpuMs} ms/frame${gpu}`);
    } else {
      hud.setStats(base);
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- Hooks for automated tests ----------

const api = {
  ready: true,
  // Steps the game with the same scripted actions every frame.
  advance(frames: number, actions: Partial<Actions> = {}): void {
    for (let i = 0; i < frames; i++) {
      stepOnce({ ...NO_ACTIONS, ...actions });
      followSim(STEP);
    }
    draw(1, 0, 0);
  },
  // Steps the game reading the real keyboard, mouse and controller.
  advanceLive(frames: number): void {
    for (let i = 0; i < frames; i++) {
      const cam = input.pollCamera(STEP);
      follow.rotate(cam.dYaw, cam.dPitch);
      follow.zoom(cam.dZoom);
      stepOnce(input.pollActions(follow.yaw));
      followSim(STEP);
    }
    draw(1, 0, 0);
  },
  render(): void {
    draw(1, 0, 0);
  },
  reset(opts: { x?: number; z?: number; facing?: number; camYaw?: number } = {}): void {
    const facing = opts.facing ?? world.spawn.facing;
    sim.reset({ x: opts.x ?? world.spawn.x, z: opts.z ?? world.spawn.z, facing }, 0, build);
    range?.reset();
    vfx.reset();
    hud.clear();
    follow.reset(opts.camYaw ?? facing);
    followSim(STEP);
    draw(1, 0, 0);
  },
  state() {
    return JSON.parse(JSON.stringify({ frame: sim.frame, hitstop: sim.hitstop, player: sim.player, dummy: sim.dummy }));
  },
  events() {
    return sim.log.map((e) => ({ ...e }));
  },
  perf,
  crowd() {
    if (net) return { fighters: net.n, known: net.knownCount(), connected: net.connected, downloadKBps: net.bytesPerSec / 1024, server: net.stats };
    if (!crowd) return null;
    return { fighters: crowd.n, alive: crowd.aliveCount(), kills: crowd.kills, ticks: crowd.tick, trianglesPerFighter: crowdView?.trianglesPerFighter };
  },
  setPaused(p: boolean): void {
    paused = p;
    acc = 0;
    last = performance.now();
  },
  setCamera(c: { yaw?: number; pitch?: number; distance?: number }): void {
    if (c.yaw !== undefined) follow.yaw = c.yaw;
    if (c.pitch !== undefined) follow.pitch = c.pitch;
    if (c.distance !== undefined) {
      follow.distance = c.distance;
      follow.zoom(0);
    }
    followSim(STEP);
  },
  camera() {
    return { yaw: follow.yaw, pitch: follow.pitch, distance: follow.distance };
  },
  device() {
    return input.lastDevice;
  },
  // Online play: your fighter, how often the server corrected the prediction, and the players nearby.
  net() {
    if (!net) return null;
    const p = sim.player;
    return {
      connected: net.connected,
      joined: !!net.you,
      id: net.you?.id ?? null,
      team: p.team,
      hp: p.hp,
      x: p.pos.x,
      y: p.pos.y,
      z: p.pos.z,
      mode: p.mode,
      stun: p.stun,
      weapon: p.weapon,
      perks: p.perks,
      ability1: p.ability1,
      ability2: p.ability2,
      cooldown1: p.cooldown1,
      cooldown2: p.cooldown2,
      castKind: p.castKind,
      seq: prediction?.seq ?? 0,
      ack: prediction?.lastAck ?? 0,
      pending: prediction?.pendingCount ?? 0,
      corrections: prediction?.corrections ?? 0,
      maxCorrection: prediction?.maxCorrection ?? 0,
      lastCorrection: prediction?.lastCorrection ?? 0,
      snapshots: net.snapshots,
      remotes: remotes?.list() ?? [],
      scriptLeft: scripted.length,
      renderTick: net.renderTick(performance.now()),
      lastTick: net.lastTick,
      server: net.stats,
    };
  },
  // Feeds a list of [frames, actions] in place of the controller (live play, for tests).
  scriptInput(segments: Array<[number, Partial<Actions>]>): void {
    for (const [frames, a] of segments) for (let i = 0; i < frames; i++) scripted.push({ ...NO_ACTIONS, ...a });
  },
  // Every crowd fighter's (x, y, z, yaw) as drawn this frame; y below zero means sinking or hidden.
  crowdRoots(): Float32Array | null {
    return crowdView?.roots() ?? null;
  },
  autoAttack(on: boolean): void {
    autoAttack = on;
  },
  // Skills and loadout: the build you've chosen, and what your fighter is actually using.
  build() {
    const p = sim.player;
    return { chosen: { ...build }, using: { perks: p.perks, weapon: p.weapon, ability1: p.ability1, ability2: p.ability2 } };
  },
  setBuild(b: Build): boolean {
    if (!validBuild(b)) return false;
    panel.setBuild(b);
    applyBuild(b);
    return true;
  },
  // Testing: send a build without checking it first, to see the server turn it down.
  sendRawBuild(b: Build): void {
    net?.sendBuild(b.perks, b.weapon, b.ability1, b.ability2);
  },
  skillPanel(open?: boolean): boolean {
    if (open === true && !panel.isOpen) panel.open();
    if (open === false && panel.isOpen) panel.close();
    return panel.isOpen;
  },
  spells() {
    return {
      arrowsDrawn: spells.arrowsDrawn,
      meteorsDrawn: spells.meteorsDrawn,
      circlesDrawn: spells.circlesDrawn,
      training: range ? { arrows: range.arrows.length, meteors: range.meteors.length } : null,
      online: netSpells?.counts ?? null,
    };
  },
  setLag(ms: number): void {
    net?.setLag(ms);
  },
};

(window as unknown as { __game: typeof api }).__game = api;
