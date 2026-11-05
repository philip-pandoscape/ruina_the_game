import * as THREE from 'three';
import { defaultBuild, loadBuild, parseBuild, pointsLeft, saveBuild, swapSlots, validBuild } from './build';
import { CROWD_TICK, CrowdSim } from './crowd/crowdSim';
import { CrowdView, type CrowdSource } from './crowd/crowdView';
import { crouchKeySlides, Input } from './input/input';
import { INTERP_TICKS, NetCrowd, type NetActor } from './net/netCrowd';
import { NetMonsters } from './net/netMonsters';
import { Prediction, RemotePlayers, stateFromServer } from './net/netPlayer';
import { NetSpells } from './net/netSpells';
import { FollowCamera } from './render/camera';
import { Hero, type WeaponAt } from './render/character';
import { TrainingDummy } from './render/dummy';
import { ActorView } from './render/actors';
import { actorKindAt, actorKindIds, findKind } from './content/actors';
import { isAlive, type Actor } from './sim/actor';
import { behaviour, startBrain, stateName, stateProgress } from './sim/ai/brain';
import { targetOf } from './sim/combat/hit';
import { createTargeting } from './app/targeting';
import { Hud } from './render/hud';
import { BATTLEFIELD_STAGE, Stage, TRAINING_STAGE } from './render/scene';
import { CIRCLE, SpellView } from './render/spells';
import { Vfx } from './render/vfx';
import { Sim } from './sim/sim';
import { TrainingRange } from './sim/training';
import { NO_ACTIONS, type Actions, type GameEvent, type PlayerState } from './sim/types';
import { makeBattlefield, makeWorld } from './sim/world';
import { makeZoneWorld } from './sim/zone/world';
import { OpenStage } from './render/open/stage';
import { loadModels } from './render/open/models';
import { groundAt } from './sim/zone/colliders';
import { Life, type Command } from './sim/life/life';
import { runCommand, type FocusAction } from './sim/life/interact';
import type { LifeState } from './sim/life/state';
import { LifeView, sitIn } from './render/open/life';
import { LifeUI } from './ui/life/lifeUI';
import { clearLife, loadLife, saveData, saveLife } from './app/save';
import { goOnline } from './app/online';
import { leaveFor, plainUrl } from './app/resume';
import { signOut } from './net/account';
import { NetOverlay, OnlineBadge, showStopped } from './ui/signIn';
import { splash } from './ui/splash';
import { WorldPeers } from './net/worldPeers';
import type { WorldTick, YouState } from './net/worldLink';
import { addHouseColliders } from './sim/life/housing';
import { addScarecrowCollider } from './sim/life/farming';
import { BugReporter } from './app/bugs/reporter';
import { installLogCapture } from './app/bugs/logs';
import { dismount, ridden } from './sim/life/vehicles';
import { AutoWalk } from './app/autoWalk';
import { RIDE_CAMERA } from './content/traversal';
import { rideable, isBoat } from './content/vehicles';
import { angleDiff } from './sim/math';
import { hourAt, hourOfDay } from './sim/life/weather';
import { ABILITY_ICONS, WEAPON_ICONS, WEAPON_NAMES } from './ui/icons';
import type { MarkerKind } from './render/hud';
import { BOOK, levelOf, levelsFrom, resolveSkills, sameLevels, SKILL_POINTS, type ResolvedSkills } from './skills';
import { SkillsPanel } from './ui/skills/panel';
import { skillBudget, trainedBy } from './sim/life/progress';
import { ABILITIES, abilityMpFor, abilityRadius, AIM, MOVEMENT_SKILLS, CAMERA, castFramesFor, comboFor, COMBAT, DUMMY, groundRange, isGroundTargeted, meleeTargets, movementCooldownFor, movementStaminaFor, MP, NO_ABILITY, STAMINA, STEP, type Build } from './tuning';
import { heightAboveGround } from './sim/player/traverse';
import './ui/theme/theme.css';
import './ui/theme/hud.css';
import './ui/theme/windows.css';
import './ui/theme/skills.css';
import { initUiScale } from './ui/theme/scale';
import { Portraits } from './render/portrait';
import { Studio } from './render/studio';

// The UI is laid out on a virtual screen and scaled to the window; start that before anything
// builds UI.
initUiScale(document.getElementById('ui') as HTMLElement);

// URL options:
//   ?test          start paused so automated tests can step the game frame by frame
//   ?raid=10000    raid stress test: two armies of fighters on a big battlefield
//   &outline=0     raid without character outlines (to compare speed)
//   ?server=ws://localhost:7777   play on the Rust battle server's battlefield (server/)
//     &team=0|1    which side to join (default: whichever the server picks)
//     &play=0      just watch instead of joining
//     &lag=150     testing: ask the server to delay this connection by 150 ms each way
//   &softlock=0    turn off the automatic target pick; Tab still works
//   (none)         the open world: Emberholm, the starter isle, played on the game server: sign in
//                  and choose a character first, on the title screen; the server runs the island
//                  and keeps it (src/app/online.ts)
//     &as=name     development servers: sign straight in as name (a new account if it's new) and
//                  play the character it played last
//     &fresh       start your island over
//   ?yard          the old training yard, offline (also what ?test opens, unless ?world is given too)
//   ?world&test    the open world, offline and paused for automated tests (&load: the island
//                  kept in this browser, for bug-report replays)
//   ?bugs=0        no bug reporter (\ records a bug report; tests turn it on with &bugs)
//   &bugspeech=0   bug reports without live transcription; &buglang=en-GB to change its language
// Console output and errors are kept from here on, for bug reports.
installLogCapture();
const params = new URLSearchParams(location.search);
const testMode = params.has('test');
const serverUrl = params.get('server');
const raidCount = !serverUrl && params.has('raid') ? Math.max(100, Math.min(50000, Number(params.get('raid')) || 10000)) : 0;
const battlefield = raidCount > 0 || !!serverUrl;
const yardMode = params.has('yard') || (testMode && !params.has('world'));
const openWorld = !battlefield && !yardMode;
const team = params.has('team') ? Number(params.get('team')) & 1 : 255;
const lagMs = Math.max(0, Math.min(2000, Number(params.get('lag')) || 0));

// The island's models load from the start (online, while you sign in and choose a character).
const modelsLoading = openWorld ? loadModels().then((m) => (splash?.step('models'), m)) : null;

// Emberholm is played on the game server: sign in and choose a character, and it hands over their
// island and build, and keeps them from then on. Automated tests and the training yard stay
// offline. Online, all of it happens on the title screen (src/ui/splash.ts), which shows the island
// being built and then fades into the game.
const online = openWorld && !testMode ? await goOnline(params) : null;
if (splash) {
  splash.say('Raising the Island…');
  splash.toward('world', 3);
  await splash.paint();
}

const canvas = document.getElementById('game') as HTMLCanvasElement;
const world = battlefield ? makeBattlefield() : openWorld ? makeZoneWorld() : makeWorld();
const terrain = world.terrain ?? null;
/** Ground height under a point: the island's terrain, or 0 on the flat training grounds. */
const groundY = (x: number, z: number): number => (terrain ? terrain.height(x, z) : 0);
// Online (the battlefield, or Emberholm on the game server) the server decides hits, so the local
// rules run without the training dummy and hit pause, and only predict your own moves.
const serverRules = !!serverUrl || !!online;
const sim = new Sim(world, { training: !serverRules });
// Your skills and loadout, kept between visits: with your character on the game server in the open
// world, in this browser elsewhere. On the battlefield, the server checks it and sends it back.
// The welcome's is the build the server applied, already held to the points your island has earned
// (which this page doesn't know until the island arrives), so it's only checked for shape here.
let build: Build = online ? (parseBuild(online.welcome.build, Infinity) ?? defaultBuild()) : loadBuild();
sim.setBuild(build);
if (terrain && !serverRules) {
  // Offline on the island, start standing on the ground at the spawn rather than inside the hill
  // (online the server puts you there, the same way).
  const p = sim.player;
  p.pos.y = groundAt(terrain, world.index, p.pos.x, p.pos.z, terrain.height(p.pos.x, p.pos.z) + 1.2, 1.2);
  p.prevPos = { ...p.pos };
}
const range = serverRules ? null : new TrainingRange(sim);
if (splash) {
  splash.step('world');
  splash.say(splash.has('models') ? 'Planting the Forests…' : 'Loading Models…');
}
const models = modelsLoading ? await modelsLoading : {};
if (splash) {
  splash.say('Planting the Forests…');
  splash.toward('stage', 4);
  await splash.paint();
}
const openStage = openWorld ? new OpenStage(canvas, world, models) : null;
if (splash) {
  splash.step('stage');
  splash.say('Waking the Townsfolk…');
  splash.toward('ready', 5);
  await splash.paint();
}
const stage: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; follow(x: number, z: number, y?: number): void; resize(w: number, h: number): void } =
  openStage ?? new Stage(canvas, world, battlefield ? BATTLEFIELD_STAGE : TRAINING_STAGE);
const hero = new Hero();
stage.scene.add(hero.root);
const dummy = new TrainingDummy(world.dummy.x, world.dummy.z);
dummy.root.position.y = groundY(world.dummy.x, world.dummy.z);
// Training only: online the server owns what lives in the world.
const actorView = new ActorView(actorKindIds(), 64, terrain ? groundY : null);
const dummyActor = () => sim.actorOfKind('dummy');
dummy.root.visible = !serverRules;
stage.scene.add(dummy.root);
stage.scene.add(actorView.group);
const vfx = new Vfx(stage.scene);
const spells = new SpellView(stage.scene, vfx);
/**
 * The terrain's height at (x, z) and above it whatever is drawn over it within `pad` metres (farm soil
 * and furrows: yours and everyone else's here), for what lies on the ground to lie on top of.
 */
const drawnGround = (x: number, z: number, pad: number): number =>
  terrain ? terrain.height(x, z) + Math.max(lifeView?.raisedAt(x, z, pad) ?? 0, peers?.raisedAt(x, z, pad) ?? 0) : 0;
// Warning circles lie on the island's hills and farms (and on a deck or roof under whoever they're
// about), floating on the sea rather than sinking under it.
if (terrain) {
  spells.ground = {
    cell: terrain.cell,
    origin: terrain.min,
    height: (x, z, near, pad) => Math.max(terrain.water, Number.isFinite(near) ? groundAt(terrain, world.index, x, z, near, 0.5) : terrain.height(x, z), drawnGround(x, z, pad)),
  };
}
const follow = new FollowCamera(innerWidth / innerHeight, battlefield ? 1200 : openWorld ? 2600 : 320, battlefield ? 160 : openWorld ? 40 : 14);
// Over hills and water the camera must not dip into the ground or under the sea, and it pulls in
// rather than looking through a wall.
if (terrain) follow.groundAt = (x, z) => Math.max(terrain.water + 0.35, terrain.height(x, z) + 0.45);
if (world.index) {
  const idx = world.index;
  follow.blocker = (fx, fy, fz, cx, cy, cz) => {
    let best = 1;
    const mx = (fx + cx) / 2;
    const mz = (fz + cz) / 2;
    const reach = Math.hypot(cx - fx, cz - fz) / 2 + 1;
    const home = lifeView?.inside ?? null;
    idx.eachBox(mx, mz, reach, (b) => {
      if (b.top < -1e8) return;
      // Indoors the walls are cut down, so they do not block the view.
      if (home && Math.hypot(b.x - home.x, b.z - home.z) < Math.hypot(home.hw, home.hd) + 0.5) return;
      // The segment in the box's own frame, clipped against its padded footprint.
      const ax = fx - b.x;
      const az = fz - b.z;
      const bx = cx - b.x;
      const bz = cz - b.z;
      const la = [ax * b.cos - az * b.sin, ax * b.sin + az * b.cos];
      const lb = [bx * b.cos - bz * b.sin, bx * b.sin + bz * b.cos];
      const half = [b.hw + 0.25, b.hd + 0.25];
      let t0 = 0;
      let t1 = 1;
      for (let k = 0; k < 2; k++) {
        const d = lb[k] - la[k];
        if (Math.abs(d) < 1e-9) {
          if (Math.abs(la[k]) > half[k]) return;
          continue;
        }
        const ta = (-half[k] - la[k]) / d;
        const tb = (half[k] - la[k]) / d;
        t0 = Math.max(t0, Math.min(ta, tb));
        t1 = Math.min(t1, Math.max(ta, tb));
        if (t0 > t1) return;
      }
      // Passing over the roof is fine.
      if (fy + (cy - fy) * t0 > b.top) return;
      best = Math.min(best, t0);
    });
    return Math.max(0.12, best - 0.03);
  };
}
follow.reset(world.spawn.facing);
const input = new Input(canvas);
// C slides you on the run; standing still it only crouches, and in the air it only flares the glider.
input.crouchSlides = () => crouchKeySlides(sim.player);
const hud = new Hud();
hud.setDevice(input.lastDevice);

// Records bug reports (\ or both sticks); set up at the end of this file, once everything exists.
let bugs: BugReporter | null = null;

// ---------- The open world's life systems: trade, farming, housing, vehicles, quests ----------
const life = openWorld && world.zone ? new Life(world.zone) : null;
if (life) sim.life = life;
if (life) {
  // Every command the island is given goes into a bug report's event log.
  const command = life.command.bind(life);
  life.command = (c) => {
    const { t, ...rest } = c;
    bugs?.note('command', { type: t, ...rest });
    command(c);
  };
}
input.worldMode = !!life;
if (terrain) {
  vfx.ground = groundY;
  vfx.raised = (x, z, r) => drawnGround(x, z, r) - terrain.height(x, z);
}
const lifeView = life ? new LifeView(stage.scene, life, models, hero) : null;
if (lifeView && openStage) lifeView.onGroundChanged = () => openStage.foliage.invalidate();
// Auto-run (H) and travel by road from the map: it only makes the controls, so it works online too.
const walker = life ? new AutoWalk({ sim, world, life }) : null;
const lifeUI = life ? new LifeUI({ life, sim, world, camera: () => follow.camera, yaw: () => follow.yaw, device: () => input.lastDevice, walk: walker ?? undefined }) : null;
// Online: everyone else in your channel of Emberholm, the plots they hold, and whether this server
// offers the developer panel.
const peers = online && life && world.zone ? new WorldPeers(stage.scene, world.zone, models, sim, life, online.welcome.character.id, online.link) : null;
if (peers && openStage) peers.onGroundChanged = () => openStage.foliage.invalidate();
if (peers) peers.mineView = lifeView;
if (peers && life) life.othersVehicles = () => peers.vehicles(sim.player);
if (online && life) {
  const me = online.welcome.character.name;
  life.plotOwner = (plot) => {
    const holder = online.link.claims[plot];
    return holder && holder !== me ? holder : null;
  };
}
if (online && lifeUI) lifeUI.devTools = online.welcome.dev;
// Your character's name (an account can hold several).
if (online && lifeUI) lifeUI.playerName = online.welcome.character.name;
/**
 * The hour of the day the sky shows. Online it is the world's, from the server's clock, so everyone
 * in Emberholm sees the same sky at the same moment (each island's own clock ran on by itself while
 * its player was away); offline it is the island's.
 */
const skyHour = (): number => (!life ? 12 : online ? hourAt(life.zone.recipe.sky, online.link.serverNow() / 1000) : hourOfDay(life));
if (online && lifeUI) lifeUI.skyHour = skyHour;
// The rain and the wind run on the world's clock too (the server decides the rain; the wind you sail
// on is worked out here between its updates from the same clock).
if (online && life) life.worldClock = () => online.link.serverNow() / 1000;
// Faces for the UI. Yours (beside your health, in the skill tree) and all of you (the character
// window) come from a studio of their own: you as you look, whatever you're doing, wherever you are,
// at any hour (src/render/studio.ts). The person you're talking to is taken from the scene, kept a
// moment, then taken again.
const studio = new Studio(stage.renderer);
const portraits = new Portraits(stage.renderer, stage.scene);
/** The layer a townsperson's portrait draws on its own (with the scene's lights). */
const NPC_LAYER = 2;
/** A picture for the UI: 'player' (your face) or 'body' (all of you) from the studio, or an NPC's id. */
function portraitOf(who: string): string | null {
  if (who === 'player' || who === 'body') {
    return studio.shot(who === 'player' ? 'face' : 'body', { weapon: sim.player.weapon, team: serverUrl ? sim.player.team : 0, who: String(online?.welcome.character.id ?? '') });
  }
  const shot = portraits.get(who);
  if (!shot || shot.age > 1500) {
    // Just them, framed from in front of their face. You stand right beside whoever you talk to, so
    // with everything drawn your own head would fill the picture.
    const body = lifeView?.villager(who);
    if (body) {
      body.traverse((c) => c.layers.enable(NPC_LAYER));
      stage.scene.traverse((c) => (c as THREE.Light).isLight && c.layers.enable(NPC_LAYER));
      const up = (v: THREE.Vector3, y: number) => v.clone().setY(v.y + y);
      const f = body.rotation.y; // they turn to face you while you talk
      const fwd = new THREE.Vector3(Math.sin(f), 0, Math.cos(f));
      portraits.request(who, up(body.position, 1.42).addScaledVector(fwd, 1.9), up(body.position, 1.34), 128, 128, NPC_LAYER);
    }
  }
  return shot?.url ?? null;
}
if (lifeUI) lifeUI.portraitOf = portraitOf;
if (peers && lifeUI) lifeUI.others = () => peers.list();
// Online the game server runs your island and keeps it (server/src/world_game.rs): your commands go
// to it, and what it says your island holds replaces this copy as it arrives. ?fresh starts it
// over. Automated tests run the island here instead, starting fresh every time unless they ask for
// the one kept in this browser (?world&test&load, which is how bug reports are replayed).
if (life && online) {
  // Starting over: the old island must be gone before this page shows one.
  if (params.has('fresh')) await online.link.reset();
  life.remote = (c) => online.link.command((prediction?.seq ?? 0) + 1, c);
  // ?lag=ms plays a local server as one far away would feel.
  online.link.lag = lagMs;
}
if (life && testMode && params.has('load')) loadLife(life, sim);
// The island's skill points hold your build to what you've earned, as the server does on joining:
// a build they can't cover falls back to Sword Training. Online the welcome already says what the
// server chose, except when ?fresh has just started the island, and its points, over.
if (life && (!online || params.has('fresh')) && !validBuild(build, skillBudget(life.state))) {
  build = defaultBuild();
  sim.setBuild(build);
}

/** Moves you somewhere (the dev panel and tests), off whatever you were riding. */
function teleport(x: number, z: number, facing = sim.player.facing): void {
  if (!terrain) return;
  // Somewhere else entirely: whatever was walking you there has nothing left to follow.
  walker?.stop();
  // Online only the server can move you.
  if (online) {
    online.link.command((prediction?.seq ?? 0) + 1, { t: 'teleport', x, z, facing } as unknown as Parameters<Life['command']>[0]);
    return;
  }
  if (life && sim.player.mode === 'ride') dismount(life, sim);
  const p = sim.player;
  const y = groundAt(terrain, world.index, x, z, terrain.height(x, z) + 1.2, 1.2);
  p.pos = { x, y, z };
  p.prevPos = { x, y, z };
  p.vel = { x: 0, y: 0, z: 0 };
  p.facing = facing;
  p.prevFacing = facing;
  if (p.mode === 'glide' || p.mode === 'swim') p.mode = 'normal';
  p.grounded = true;
  follow.reset(follow.yaw);
}
if (lifeUI) {
  lifeUI.onTeleport = (x, z) => teleport(x, z);
  lifeUI.onReset = async () => {
    if (online) await online.link.reset();
    else clearLife();
    location.replace(location.pathname);
  };
}

// The camera swings in behind a vehicle or glider unless you have been steering it yourself, and
// pulls back so you can see where you are going.
let lastCameraTouch = -1e9;
let footDistance = -1;
function rideCamera(dt: number, now: number): void {
  const p = sim.player;
  const riding = p.mode === 'ride' || p.mode === 'glide';
  if (!riding) {
    if (footDistance > 0) {
      follow.distance += (footDistance - follow.distance) * (1 - Math.exp(-3 * dt));
      if (Math.abs(follow.distance - footDistance) < 0.05) footDistance = -1;
    }
    return;
  }
  if (footDistance < 0) footDistance = follow.distance;
  const v = life ? ridden(life, sim) : undefined;
  const want = p.mode === 'glide' ? RIDE_CAMERA.glideDistance : v && isBoat(rideable(v.def)) ? RIDE_CAMERA.boatDistance * Math.max(1, rideable(v.def).length / 9) : RIDE_CAMERA.rideDistance;
  follow.distance += (want - follow.distance) * (1 - Math.exp(-2.5 * dt));
  const moving = Math.hypot(p.vel.x, p.vel.z) > 1.5;
  if (moving && now - lastCameraTouch > RIDE_CAMERA.autoDelay * 1000) {
    follow.yaw += angleDiff(follow.yaw, p.facing) * (1 - Math.exp(-RIDE_CAMERA.autoFollow * dt));
  }
}
input.onDeviceChange = (d) => hud.setDevice(d);
// The training yard keeps the experience of its skills in this browser; the open world keeps it
// with your island (src/sim/life/progress.ts).
const YARD_XP = 'yggdrasil.skillxp';
const yardXp: Record<string, number> = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(YARD_XP) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
})();
let yardSaved = 0;
function yardTrain(e: GameEvent): void {
  const b = trainedBy(e);
  if (b < 0) return;
  const id = BOOK[b].id;
  const before = levelOf(yardXp[id] ?? 0);
  yardXp[id] = (yardXp[id] ?? 0) + 1;
  if (levelOf(yardXp[id]) > before || performance.now() - yardSaved > 3000) {
    yardSaved = performance.now();
    try {
      localStorage.setItem(YARD_XP, JSON.stringify(yardXp));
    } catch {
      /* storage unavailable */
    }
  }
}
if (!life) sim.levels = levelsFrom(yardXp);
/** Points you may have in the tree: earned on the island, a training budget elsewhere. */
const skillPoints = () => (life ? skillBudget(life.state) : SKILL_POINTS);
const panel = new SkillsPanel(build, {
  budget: skillPoints,
  budgetNote: () => (life ? 'Earned from quests and milestones' : 'Training yard: points to try builds with'),
  xp: () => (life ? life.state.skillXp ?? {} : yardXp),
  levels: () => sim.levels,
  portrait: () => portraitOf('player'),
  device: () => input.lastDevice,
});
panel.onChange = applyBuild;
hud.onSkillsClick = () => panel.toggle('book');
// Rearranging the bar in play, without opening the panel.
hud.onSwapSlots = (from, to) => applyBuild(swapSlots(build, from, to));
// A window that closes itself after something clicked in it (a pack made, a vehicle summoned, off
// to place something) gives the mouse back to the camera, if the camera had it when the window
// opened. Not while the skill book or tree is open, nor while the world waits for the server.
if (lifeUI) {
  lifeUI.onMouseBack = () => {
    if (!panel.isOpen && !frozen) input.capture();
  };
}
const DEG = Math.PI / 180;

// What the target plate's cast bar calls a monster's cast, by the behaviour state casting it.
const CASTS: Record<string, string> = { gather: 'Gathering' };

/** The cast a marked actor is in the middle of, for the bar under its health. */
function castOf(key: string): { label: string; progress: number } | null {
  if (!key.startsWith('actor:')) return null;
  if (net) {
    // Online, as the server has it now: a cast bar is a warning, so it shouldn't run late.
    const id = Number(key.slice(6));
    const a = presentActors.find((x) => x.id === id);
    const k = a ? actorKindAt(a.kind) : undefined;
    const s = a && k?.brain ? behaviour(k.brain)?.states[a.state] : undefined;
    if (!a || a.deadFrame >= 0 || s?.act !== 'channel') return null;
    return { label: CASTS[s.name] ?? s.name, progress: a.progress };
  }
  if (serverRules) return null;
  const a = sim.actors.get(Number(key.slice(6)));
  const s = a?.brain ? behaviour(a.brain)?.states[a.state] : undefined;
  if (!a || !isAlive(a) || s?.act !== 'channel') return null;
  return { label: CASTS[s.name] ?? s.name, progress: stateProgress(a) };
}

// What the target plate calls each kind. Content, not rules, so it lives next to the UI.
const NAMES: Record<string, string> = {
  dummy: 'Training Dummy',
  slimelet: 'Slimelet',
  slime: 'Slime',
  'great-slime': 'Great Slime',
  'slime-monarch': 'Slime Monarch',
};

// The raid's fighters come either from a local sim (?raid) or from the battle server (?server).
const crowd = raidCount ? new CrowdSim(raidCount) : null;
const net = serverUrl ? new NetCrowd(serverUrl) : online ? NetCrowd.detached((seq, raw, stick) => online.link.sendInput(seq, [...raw, ...stick])) : null;
const netSpells = net ? new NetSpells(net, resolveSkills(build.skills)) : null;
// The server's monsters: drawn between its updates, at the moment other players are drawn
// (shownActors), and as it has them now (presentActors) for what has to be on time - warnings, and
// guessing whether your swing connects. NetMonsters gives online hits their sparks and flashes.
const netMonsters = net ? new NetMonsters(groundY) : null;
let shownActors: NetActor[] = [];
let presentActors: NetActor[] = [];
const shownById = new Map<number, NetActor>();
const crowdSource: CrowdSource | null = crowd ?? (serverUrl ? net : null);
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
// Other players on the battlefield; in Emberholm they're drawn with their vehicles and gliders by
// WorldPeers instead.
const remotes = serverUrl ? new RemotePlayers(stage.scene) : null;
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
      net.sendBuild(build.skills, build.weapon, build.abilities, build.movement);
    }
    if (lagMs) net.setLag(lagMs);
  };
}
if (net && !playing) hud.hideAbilities();

// A new build from the skill panel: save it, and use it (online, the server switches you over).
function applyBuild(b: Build): void {
  build = b;
  if (online) online.link.saveBuild(b);
  else saveBuild(b);
  if (net) net.sendBuild(b.skills, b.weapon, b.abilities, b.movement);
  if (netSpells) netSpells.stats = resolveSkills(b.skills);
  else sim.setBuild(b);
}
if (remotes) {
  // Flinch and sparks for any hit you can see. The number itself only comes from the server's
  // attributed events, so other people's hits don't put damage numbers on your screen.
  remotes.onHurt = (x, y, z, damage, dirX, dirZ) => {
    vfx.onEvent({ type: 'hit', frame: 0, index: damage >= 25 ? 2 : 0, damage, x, y, z, dirX, dirZ });
  };
}

// Which icon goes beside a floating number, from the cause the server packed into the event.
function causeIcon(cause: number): string {
  if (cause >= 1 && cause <= 4) return WEAPON_ICONS[cause - 1] ?? '';
  if (cause === 5) return ABILITY_ICONS[1]; // meteor
  if (cause === 6) return ABILITY_ICONS[0]; // heal
  if (cause === 7) return '\u{1f43a}'; // a bot got you
  if (cause === 8) return '\u{1f7e2}'; // a monster's slam
  return '';
}
if (netSpells) {
  netSpells.onMarker = (kind: MarkerKind, x, y, z, amount, cause) => {
    if (kind === 'hit' && netMonsters) {
      // One of your blows: on a monster, the number goes on it as drawn, and a hit this screen
      // didn't already show (a guess missed it) gets its sparks and shake now.
      const p = sim.player;
      const from = { x: p.pos.x, z: p.pos.z, index: p.mode === 'attack' ? p.attackIndex : 0 };
      const at = netMonsters.confirm(x, y, z, cause, from, net?.actorTimeline.newest() ?? [], shownById, sim.frame, performance.now());
      for (const e of at.show) showEvent(e);
      hud.marker(kind, at.x, at.y, at.z, amount, causeIcon(cause));
      return;
    }
    hud.marker(kind, x, y, z, amount, causeIcon(cause));
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
  if (!serverRules) for (const a of sim.actors.all()) if (isAlive(a) && a.faction !== 0 && a.faction !== 2) fn(a.x, a.z);
  // The server's monsters (not townsfolk, not other players' things), where they're drawn.
  for (const a of shownActors) {
    const f = actorKindAt(a.kind)?.faction ?? 0;
    if (a.deadFrame < 0 && f !== 0 && f !== 2) fn(a.x, a.z);
  }
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

// Combat stance: with an enemy marked, or for a moment after you swing or cast, you keep facing
// where the camera looks, so the stick strafes and backs off, and dodges and double jumps go any of
// eight ways. Out of a fight you turn and run the way you push; sprinting always does (the rules
// see to that). Swimming, gliding and riding ignore it.
const STANCE_LINGER = 90; // frames the stance holds after your last swing or cast
let lastFight = -Infinity;
/** In a fight: an enemy marked, or a swing or cast just made. The hero's weapon is out for it. */
const inAFight = (): boolean => lockOn.mark() !== null || sim.frame - lastFight < STANCE_LINGER;
function combatStance(a: Actions): Actions {
  if (a.faceX !== 0 || a.faceZ !== 0) return a; // already given (tests)
  if (net && !playing) return a;
  const p = sim.player;
  if (p.mode === 'attack' || p.mode === 'cast') lastFight = sim.frame;
  if (!inAFight() || p.mode === 'ride' || p.mode === 'swim' || p.mode === 'glide') return a;
  return { ...a, faceX: Math.sin(follow.yaw), faceZ: Math.cos(follow.yaw) };
}

// Aim assist: attacks and Meteor go toward the enemy you most likely mean, the nearest one close
// to the direction you're pushing (or facing; the bow and Meteor use the camera's direction when you
// stand still). With nothing to aim at, the bow and Meteor still go where the camera looks. The rules
// only read the aim when an attack or cast starts, so it's only worked out while one is pending.
function aimAssist(a: Actions): Actions {
  if (a.aimX !== 0 || a.aimZ !== 0) return a; // already aimed (tests)
  const p = sim.player;
  const pending = a.abilitySlot || (p.abilityBuffer > 0 ? p.abilityBufferSlot : 0);
  const aiming = pending >= 1 ? (p.abilities[pending - 1] ?? NO_ABILITY) : NO_ABILITY;
  const casting = aiming !== NO_ABILITY && isGroundTargeted(aiming);
  const attacking = a.attackPressed || p.attackBuffer > 0 || p.attackQueued;
  if (!casting && !attacking) return a;
  const bow = p.weapon === 3;
  const ranged = casting || bow;
  const moving = Math.hypot(a.moveX, a.moveZ) > 0.3;
  const dir = moving ? Math.atan2(a.moveX, a.moveZ) : ranged ? follow.yaw : p.facing;
  const swing = comboFor(p.weapon, sim.stats)[0];
  const maxDist = casting ? (groundRange(aiming) ?? 16) : bow ? Math.min(30, swing.projectileRange ?? 30) : swing.reach + 1.6;
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
  const reach = casting ? (ABILITIES[aiming]?.range ?? 9) : 20;
  return { ...a, aimX: Math.sin(dir) * reach, aimZ: Math.cos(dir) * reach };
}

// ---------- Targeting ----------
// A soft lock you can override with Tab; see app/targeting.ts.
const lockOn = createTargeting({
  sim,
  camera: () => follow.camera,
  yaw: () => follow.yaw,
  remotes,
  crowdSource,
  net,
  playing,
  online: serverRules,
  softLock: params.get('softlock') !== '0',
  names: NAMES,
  netActors: () => shownActors,
});
const updateTarget = () => lockOn.update();
const cycleTarget = (step: number) => lockOn.cycle(step);

// ---------- Ground-aimed casts: hold to place the circle, release to cast ----------

// The circle is a cursor you push around, held as an offset from wherever you are. It can't be
// a raycast through the middle of the screen: the camera always looks straight at you, so that
// point is always your own feet however you tilt the sticks.
const aimOffset = { x: 0, z: 0 };
const reticle = { x: 0, z: 0, range: 0, radius: 0 };
let aimingSlot = 0; // 0 none, 1 or 2 while that ability is held down

// Opening the circle: start it on whoever is marked, so the common case of "drop it on that one"
// needs no aiming at all. Otherwise put it out in front of the camera.
function startAiming(maxRange: number): void {
  const px = sim.player.pos.x;
  const pz = sim.player.pos.z;
  const mark = lockOn.mark();
  if (mark) {
    aimOffset.x = mark.x - px;
    aimOffset.z = mark.z - pz;
  } else {
    aimOffset.x = Math.sin(follow.yaw) * maxRange * AIM.startRange;
    aimOffset.z = Math.cos(follow.yaw) * maxRange * AIM.startRange;
  }
  clampAim(maxRange);
}

// Pushes the circle, in the directions the camera is facing, and keeps it inside the ability's
// range rather than refusing to cast (GW2's "lock ground target at maximum range").
function moveAim(right: number, away: number, maxRange: number): void {
  if (right !== 0 || away !== 0) {
    const fx = Math.sin(follow.yaw);
    const fz = Math.cos(follow.yaw);
    aimOffset.x += fx * away - fz * right;
    aimOffset.z += fz * away + fx * right;
  }
  clampAim(maxRange);
}

function clampAim(maxRange: number): void {
  const d = Math.hypot(aimOffset.x, aimOffset.z);
  if (d > maxRange) {
    aimOffset.x = (aimOffset.x / d) * maxRange;
    aimOffset.z = (aimOffset.z / d) * maxRange;
  }
  reticle.x = sim.player.pos.x + aimOffset.x;
  reticle.z = sim.player.pos.z + aimOffset.z;
  reticle.range = maxRange;
}

// Reads the aiming controls once per rendered frame, before any sim steps use them. `cam` is
// what the camera would have done; while the circle is up, that input moves the circle instead,
// so the view stays put and you can see where the spell is going.
let combat = input.pollCombat();
// Escape while placing a circle, kept until a rules step has seen it: a fast screen draws frames
// that run no step at all, and a press read in one of those would otherwise be lost.
let cancelWaiting = false;
function updateCombatAim(cam: { dYaw: number; dPitch: number }, dt: number): boolean {
  combat = input.pollCombat();
  for (let i = 0; i < combat.nextTarget; i++) cycleTarget(1);
  for (let i = 0; i < combat.prevTarget; i++) cycleTarget(-1);
  if (combat.cancel > 0 && aimingSlot === 0) {
    // Escape with nothing being aimed drops the target instead.
    lockOn.clear();
  } else if (combat.cancel > 0) {
    cancelWaiting = true;
  }
  updateTarget();

  if (aimingSlot === 0) {
    follow.stopAiming();
    return false;
  }
  const ability = sim.player.abilities[aimingSlot - 1] ?? NO_ABILITY;
  const r = groundRange(ability);
  if (r === null) {
    aimingSlot = 0;
    follow.stopAiming();
    return false;
  }
  reticle.radius = abilityRadius(ability, sim.stats);
  if (input.lastDevice === 'gamepad') {
    // Left stick places the circle; the character stays put while you aim.
    moveAim(combat.stickX * AIM.stickSpeed * dt, combat.stickY * AIM.stickSpeed * dt, r);
  } else {
    // Mouse, with the pointer captured: the movement that would have turned the camera slides
    // the circle instead. dYaw is negated because turning right moves the view right.
    moveAim((-cam.dYaw / CAMERA.mouseSensitivity) * AIM.mouseSpeed, (-cam.dPitch / CAMERA.mouseSensitivity) * AIM.mouseSpeed, r);
  }
  follow.aimAt(reticle.x, reticle.z);
  return true;
}

// Turns the raw buttons into the actions the rules see: holding a ground-aimed ability arms it
// instead of casting, releasing it casts at the circle, and the marked enemy supplies the aim.
function targeting(a: Actions): Actions {
  // The first step after an Escape takes it, whatever happens next.
  const cancel = cancelWaiting;
  cancelWaiting = false;
  if (net && !playing) return a;
  // An action that already carries an aim was aimed by whoever made it (the test hooks, and
  // autoAim): it casts straight away rather than arming the circle, matching aimAssist().
  if (a.aimX !== 0 || a.aimZ !== 0) return a;
  let out = a;
  if (aimingSlot === 0 && a.abilitySlot >= 1) {
    const ability = sim.player.abilities[a.abilitySlot - 1] ?? NO_ABILITY;
    if (groundRange(ability) !== null) {
      // Ground-aimed: the press arms the circle instead of casting.
      aimingSlot = a.abilitySlot;
      out = { ...out, abilitySlot: 0 };
      reticle.radius = abilityRadius(ability, sim.stats);
      startAiming(groundRange(ability) ?? 16);
    }
  }
  if (aimingSlot !== 0) {
    // Escape, or B on a pad (which would otherwise slide), backs out without casting.
    if (cancel || out.slidePressed) {
      aimingSlot = 0;
      return { ...out, slidePressed: false, abilitySlot: 0 };
    }
    if (combat.slotHeld !== aimingSlot) {
      const slot = aimingSlot;
      aimingSlot = 0;
      return { ...out, abilitySlot: slot, aimX: reticle.x - sim.player.pos.x, aimZ: reticle.z - sim.player.pos.z };
    }
    // On a pad the left stick is placing the circle, so it mustn't also walk you around.
    if (input.lastDevice === 'gamepad') return { ...out, moveX: 0, moveZ: 0, abilitySlot: 0 };
    return { ...out, abilitySlot: 0 };
  }
  const p = sim.player;
  const swinging = out.attackPressed || p.attackBuffer > 0 || p.attackQueued;
  const mark = lockOn.mark();
  // A blade only turns to the mark when it can reach it: swinging at the slime beside you while
  // one further off is marked hits the one beside you (aimAssist), not the air. The bow shoots at
  // the mark wherever it is.
  const reach = p.weapon === 3 ? Infinity : comboFor(p.weapon, sim.stats)[0].reach + 1.6;
  if (mark && swinging && Math.hypot(mark.x - p.pos.x, mark.z - p.pos.z) <= reach) return { ...out, aimX: mark.x - p.pos.x, aimZ: mark.z - p.pos.z };
  return out;
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
    // Team colours are the battlefield's; on Emberholm everyone is on the same side.
    if (serverUrl && shownTeam !== net.you.player.team) {
      shownTeam = net.you.player.team;
      hero.setTeam(shownTeam);
    }
  }
  remotes?.receive(net.players, net.lastTick);
  netSpells?.receive(net.you?.id ?? null);
}

// What the player would land on right now (terrain, a deck, a roof), for the shadow blob.
function groundUnder(x: number, z: number, y: number): number {
  return terrain ? groundAt(terrain, world.index, x, z, y, 0.05) : 0;
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
/** What F does that runs ahead online (see life.remote): packs in and out of hands and vehicles, getting in. */
const QUICK = new Set<FocusAction>(['pickup', 'load', 'unload', 'board']);
const dummyTop = new THREE.Vector3();
const markPos = new THREE.Vector3();

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
  if (prediction && netMonsters) {
    // Online: your swing connecting with a monster sparks and shakes the moment it strikes.
    const p = sim.player;
    const attacking = p.mode === 'attack';
    const swing = attacking ? (comboFor(p.weapon, sim.stats)[p.attackIndex] ?? null) : null;
    const hits = netMonsters.swing(
      { attacking, attackIndex: p.attackIndex, attackFrame: p.attackFrame, step: swing, x: p.pos.x, y: p.pos.y, z: p.pos.z, facing: p.facing, above: swing ? heightAboveGround(sim) : 0, max: meleeTargets(p.weapon, sim.stats) },
      presentActors,
      shownById,
      sim.frame,
      performance.now(),
    );
    // The swing pauses on the hit as it does offline, in the drawing only.
    if (hits.length && swing) hero.hitPause(swing.hitstop, p.attackIndex);
    events = events.concat(hits);
  }
  for (const e of events) showEvent(e);
  if (!life && !net) {
    for (const e of events) yardTrain(e);
    const lv = levelsFrom(yardXp);
    if (!sameLevels(lv, sim.levels)) sim.levels = lv;
  }
  const le = life ? life.drainEvents() : [];
  bugs?.step(sim.frame, actions, events, le);
  if (life) {
    lifeUI?.onEvents(le);
    for (const e of le) {
      if (e.t === 'harvest') vfx.lifeEffect('harvest', e.x, e.y, e.z);
      else if (e.t === 'gather') vfx.lifeEffect(e.kind, e.x, e.y, e.z);
      else if (e.t === 'build') vfx.lifeEffect('build', e.x, groundY(e.x, e.z), e.z);
      else if (e.t === 'thunder') vfx.lifeEffect('thunder', e.x, e.y, e.z);
      else if (e.t === 'sold') vfx.lifeEffect('coins', sim.player.pos.x, sim.player.pos.y, sim.player.pos.z);
    }
  }
  const p = sim.player;
  // Dust while sliding. Which action that is comes from its pose, not from a mode of its own.
  if (p.mode === 'action' && MOVEMENT_SKILLS[p.actionId]?.action.pose === 'slide' && sim.frame % 2 === 0) {
    vfx.slideDust(p.pos.x, p.pos.z, p.actionDirX, p.actionDirZ);
  }
  vfx.step(STEP);
  hud.step(STEP);
}

// Effects, camera shake, rumble and damage numbers for something that happened.
function showEvent(e: GameEvent): void {
  vfx.onEvent(e);
  if (e.type === 'hit') {
    const big = e.index === 2;
    follow.shake(comboFor(sim.player.weapon, sim.stats)[e.index]?.shake ?? 0.3);
    input.rumble(big ? 0.9 : 0.45, big ? 1.0 : 0.6, big ? 160 : 90);
    // Online the server sends an attributed event for this instead, so it isn't drawn twice.
    if (!serverRules) hud.marker('hit', e.x, e.y, e.z, e.damage, WEAPON_ICONS[sim.player.weapon] ?? '');
  } else if (e.type === 'land' && e.impact > 0.6) {
    follow.shake(0.15);
  } else if (e.type === 'actorDie' && e.kind === 'dummy') {
    follow.shake(0.5);
  } else if (e.type === 'hurt') {
    // A monster got you. Online the server's own attributed event draws the number instead.
    hud.marker('hurt', e.x, e.y, e.z, e.damage, causeIcon(8));
    follow.shake(0.55);
    input.rumble(0.9, 0.8, 180);
  } else if (e.type === 'slam') {
    const d = Math.hypot(e.x - sim.player.pos.x, e.z - sim.player.pos.z);
    if (d < 10) follow.shake(0.3 * (1 - d / 10) * Math.min(2, e.radius));
  } else if (e.type === 'explosion') {
    const d = Math.hypot(e.x - sim.player.pos.x, e.z - sim.player.pos.z);
    if (d < 16) {
      follow.shake(0.7 * (1 - d / 16));
      input.rumble(0.8 * (1 - d / 16), 0.6, 200);
    }
  } else if (e.type === 'cast') {
    hud.castFinished();
  } else if (e.type === 'short') {
    hud.refuse(e.what === 'mp' ? 'Not Enough MP' : 'Not Enough Stamina');
  } else if (e.type === 'splash') {
    vfx.lifeEffect('splash', e.x, e.y, e.z);
    if (e.speed > 8) follow.shake(0.2);
  } else if (e.type === 'glideOpen') {
    vfx.lifeEffect('glide', e.x, e.y, e.z);
    input.rumble(0.3, 0.4, 90);
  }
}

// Ground warnings for a cast in progress: where a meteor will land, or the area a heal will cover.
// `mine` carries your own resolved skills; other players only send how far along they are, so
// their circle fills against the ability's base time. A cosmetic difference at worst.
function castCircle(p: PlayerState, x: number, z: number, hostile: boolean, mine: ResolvedSkills | null): void {
  const ability = p.castAbility;
  if (p.mode !== 'cast' || ability === NO_ABILITY || !ABILITIES[ability]) return;
  const frames = mine ? castFramesFor(ability, mine) : ABILITIES[ability].castFrames;
  const k = p.castFrame / frames;
  const radius = mine ? abilityRadius(ability, mine) : Math.max(0, ...ABILITIES[ability].effects.map((e) => e.radius));
  // A placed cast warns at the spot; one centred on the caster warns around them.
  if (ABILITIES[ability].target === 'ground') {
    spells.circle(p.castTargetX, p.castTargetZ, radius, k, hostile ? CIRCLE.enemy : CIRCLE.ally, 0.6, p.pos.y);
  } else {
    spells.circle(x, z, radius, k, CIRCLE.heal, 0.5, p.pos.y);
  }
}

// Monsters about to do something to you: where a slam will land, from the moment one picks the
// spot until it comes down. Read off the behaviour's acts, so a new monster's slam warns the same way.
// A gather shows the reach of its pull, filling as the cast goes on.
function monsterWarning(kind: string, state: number, progress: number, x: number, z: number, tx: number, tz: number): boolean {
  const k = findKind(kind);
  const b = k?.brain ? behaviour(k.brain) : undefined;
  const act = b?.states[state]?.act;
  let drawn = false;
  if (act === 'channel' && b?.gather) {
    spells.circle(x, z, b.gather.radius, progress, CIRCLE.gather, 0.55);
    drawn = true;
  }
  if (!k?.slam || (act !== 'windup' && act !== 'leap')) return drawn;
  spells.circle(tx, tz, k.slam.radius, act === 'windup' ? progress : 1, CIRCLE.enemy, 0.9);
  return true;
}

function monsterWarnings(): void {
  if (net) {
    // As the server has them now, so a warning never runs late...
    const warned = new Set<number>();
    for (const a of presentActors) {
      if (a.deadFrame >= 0) continue;
      const k = actorKindAt(a.kind);
      if (k && monsterWarning(k.id, a.state, a.progress, a.x, a.z, a.targetX, a.targetZ)) warned.add(a.id);
    }
    // ...and kept until the monster drawn on screen has done what it warned of (a slam stays
    // marked until the slime you see lands on it).
    for (const a of shownActors) {
      if (a.deadFrame >= 0 || warned.has(a.id)) continue;
      const k = actorKindAt(a.kind);
      if (k) monsterWarning(k.id, a.state, a.progress, a.x, a.z, a.targetX, a.targetZ);
    }
    return;
  }
  for (const a of sim.actors.all()) {
    if (isAlive(a) && !a.gone) monsterWarning(a.kind, a.state, stateProgress(a), a.x, a.z, a.targetX, a.targetZ);
  }
}

// Arrows, meteors and cast warnings, drawn every frame.
function drawSpells(alpha: number, dt: number): void {
  spells.begin(dt, follow.yaw);
  if (range) {
    for (const a of range.arrows) {
      const back = a.speed * STEP * (1 - alpha); // blend between sim steps
      spells.arrow(a.x - a.dirX * back, a.y, a.z - a.dirZ * back, a.dirX, a.dirZ);
    }
    for (const m of range.meteors) spells.meteor(m.x, m.z, (m.frame + alpha) / m.fallFrames, m.radius, false);
  }
  if (net && netSpells) {
    const renderTick = net.renderTick(performance.now());
    const ahead = prediction && net.you ? (prediction.seq - net.you.ack) / (60 / net.ticksPerSecond) : 0;
    const myId = playing ? (net.you?.id ?? null) : null;
    netSpells.draw(spells, renderTick, net.lastTick + ahead, myId, sim.player.team);
    for (const e of netSpells.due(renderTick, sim.frame)) showEvent(e);
    for (const r of remotes?.shown() ?? []) castCircle(r, r.pos.x, r.pos.z, r.team !== sim.player.team, null);
  }
  if (!net || playing) castCircle(sim.player, hero.root.position.x, hero.root.position.z, false, sim.stats);
  monsterWarnings();
  if (aimingSlot !== 0) {
    const y = sim.player.pos.y;
    spells.circle(sim.player.pos.x, sim.player.pos.z, reticle.range, 0, CIRCLE.range, 0.35, y);
    spells.circle(reticle.x, reticle.z, reticle.radius, 1, CIRCLE.aim, 0.95, y);
  }
  spells.end();
}

// The ability bar and cast bar.
function drawAbilityBar(): void {
  const p = sim.player;
  const slotAbility = p.abilities[p.castSlot - 1] ?? NO_ABILITY;
  hud.setAbilities(
    {
      weapon: p.weapon,
      abilities: p.abilities,
      cooldowns: p.cooldowns,
      movement: p.movement,
      movementCooldowns: p.movementCooldowns,
      stamina: p.stamina,
      mp: p.mp,
      castAbility: p.castAbility,
      castSlot: p.castSlot,
      castFrame: p.castFrame,
      castFrames: p.castAbility !== NO_ABILITY ? castFramesFor(slotAbility, sim.stats) : 1,
      stun: p.stun,
      downFrame: p.downFrame,
    },
    input.lastDevice,
    pointsLeft(build.skills, skillPoints()),
    {
      weapon: [WEAPON_ICONS[p.weapon] ?? '', WEAPON_NAMES[p.weapon] ?? ''],
      ability: (a) => (a === NO_ABILITY || !ABILITIES[a] ? null : [ABILITY_ICONS[a], ABILITIES[a].name]),
      cooldownFrames: (a) => ABILITIES[a]?.cooldownFrames ?? 1,
      mpCost: (a) => abilityMpFor(a, sim.stats),
      move: (m) => (MOVEMENT_SKILLS[m] ? [MOVEMENT_SKILLS[m].icon, MOVEMENT_SKILLS[m].name] : null),
      moveCooldownFrames: (m) => movementCooldownFor(m, sim.stats),
      staminaCost: (m) => movementStaminaFor(m, sim.stats),
    },
  );
}

function followSim(dt: number): void {
  const p = sim.player.pos;
  follow.update(simPos.set(p.x, p.y, p.z), dt);
}

// Where the server's monsters are drawn this frame, and what they've just done.
function refreshActors(now: number): void {
  if (!net) return;
  const tick = net.renderTick(now);
  shownActors = net.actorTimeline.at(tick);
  presentActors = net.actorTimeline.at(tick + INTERP_TICKS);
  shownById.clear();
  for (const a of shownActors) shownById.set(a.id, a);
  if (!netMonsters) return;
  // Anyone's blow flashes what it hit at the moment that blow is drawn.
  const tickMs = 1000 / net.ticksPerSecond;
  netMonsters.hurts(net.actorTimeline, (t, at) => at + Math.max(0, t - net.renderTick(at)) * tickMs);
  for (const e of netMonsters.transitions(shownActors, sim.frame)) showEvent(e);
}

function draw(alpha: number, cameraDt: number, animDt: number): void {
  // Weapon out in a fight, put away a little after one (the battlefield is all fight).
  hero.armed = battlefield || inAFight();
  prediction?.ease(animDt);
  // Riding: the vehicle goes where it is this frame before you're posed in its seat, so you tilt
  // with it on a hill and your hands find its wheel or oars where they are now. Driving, yours is
  // put under you (and anyone riding along with you sits in it after); riding along with someone,
  // their vehicle is placed first, with everyone else.
  const along = sim.player.mode === 'ride' && !!sim.player.host;
  if (along) peers?.frame(animDt, sim.frame, follow.camera.position);
  sitIn(hero, lifeView?.placeRide(sim.player, alpha, prediction?.offset ?? null, animDt) ?? (along ? (peers?.seatFor(sim.player) ?? null) : null));
  hero.update(sim.player, alpha, sim.frame);
  if (prediction && !hero.seat) hero.root.position.add(prediction.offset);
  const d = dummyActor();
  if (d) dummy.update(d);
  if (net) {
    const now = performance.now();
    refreshActors(now);
    actorView.fromNetwork(shownActors, (id) => netMonsters?.flash(id, now) ?? 0);
  }
  // Townsfolk with their own models are drawn by the life view instead of the crowd.
  else actorView.update(lifeView?.drawsTownsfolk ? sim.actors.all().filter((a) => a.faction !== 2) : sim.actors.all());
  if (lifeView && lifeUI) lifeView.talkingTo = lifeUI.talkingTo;
  if (crowd) crowd.render(Math.min(1, crowdAcc / CROWD_TICK));
  if (net) net.frame(performance.now());
  if (net) remotes?.frame(net.renderTick(performance.now()), animDt, sim.frame, 60 / net.ticksPerSecond);
  if (crowdView && crowdSource) crowdView.update(crowdSource, animDt);
  drawSpells(alpha, animDt);
  if (!along) peers?.frame(animDt, sim.frame, follow.camera.position);
  if (life && lifeView) {
    lifeView.update(sim, animDt, follow.camera.position);
    lifeUI?.update(animDt);
    // Wakes behind boats, dust behind fast wheels.
    for (const v of life.state.vehicles) {
      const speed = Math.abs(v.speed);
      if (speed < 3 || Math.random() > speed / 25) continue;
      const def = rideable(v.def);
      const bx = v.x - Math.sin(v.heading) * def.length * 0.5;
      const bz = v.z - Math.cos(v.heading) * def.length * 0.5;
      if (isBoat(def)) vfx.lifeEffect('wake', bx, terrain!.water, bz);
      else if (v.grounded && def.class === 'wheeled') vfx.lifeEffect('wheels', bx, v.y, bz);
    }
  }
  if (!net || playing) drawAbilityBar();
  // Health, MP and stamina: in the open world beside your portrait, elsewhere over the hotbar.
  const vitals = { hp: sim.player.hp, maxHp: COMBAT.maxHp, mp: sim.player.mp, maxMp: MP.max, stamina: sim.player.stamina, maxStamina: STAMINA.max };
  hud.setVitals(!lifeUI && (!net || (prediction && net.you)) ? vitals : null, serverUrl ? sim.player.team : null);
  lifeUI?.setVitals(vitals);
  const pos = hero.root.position;
  if (cameraDt > 0) follow.update(pos, cameraDt);
  stage.follow(pos.x, pos.z, pos.y);
  openStage?.update(animDt, follow.camera, pos.x, pos.z);
  if (openStage && life) {
    const sky = life.zone.recipe.sky;
    openStage.setTime(skyHour(), sky.sunrise, sky.sunset);
  }

  // On a farm the shadow lies on its soil, which is drawn a little over the ground you stand on.
  const under = terrain ? Math.max(terrain.water, groundUnder(pos.x, pos.z, pos.y), drawnGround(pos.x, pos.z, 0.42)) : 0;
  const lift = Math.max(0.35, Math.min(1, 1 - (pos.y - under) * 0.18));
  blob.position.set(pos.x, under + 0.03, pos.z);
  blob.visible = sim.player.mode !== 'swim';
  blob.scale.setScalar(lift);
  blobMat.opacity = 0.22 * lift;

  const timing = gpuTimerBegin();
  portraits.flush();
  stage.renderer.render(stage.scene, follow.camera);
  if (timing) gpuTimerEnd();
  bugs?.afterRender();
  const dAct = dummyActor();
  const markNow = lockOn.mark();
  dummyTop.set(dAct?.x ?? 0, 2.05 + groundY(dAct?.x ?? 0, dAct?.z ?? 0), dAct?.z ?? 0);
  hud.setTarget(
    markNow ? { pos: markPos.set(markNow.x, markNow.y + 2.15 + groundY(markNow.x, markNow.z), markNow.z), hp: markNow.hp, name: markNow.name, locked: lockOn.locked, cast: castOf(markNow.key) } : null,
  );
  // The dummy has its own health bar in the training yard; hide it when the target plate is
  // already showing the same thing, or they stack on top of each other.
  const plateOnDummy = !!markNow && markNow.name === NAMES.dummy;
  hud.layout(follow.camera, innerWidth, innerHeight, dummyTop, (dAct?.hp ?? 0) / DUMMY.hp, !serverRules && !plateOnDummy);
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
/**
 * Online, while the server is away (being updated, or the connection dropped): no rules steps,
 * nothing pressed counts, and the last frame stays up under the screen that says so.
 */
let frozen = false;
let acc = 0;
let last = performance.now();
let lastStats = 0;
/** Frames drawn so far (the title screen fades once the first few are up). */
let framesDrawn = 0;

/** Throws away whatever was pressed (while frozen): it mustn't all happen at once when play resumes. */
function dropInput(): void {
  input.pollLife(true);
  input.pollMenu();
  input.pollCamera(0);
  input.pollCombat();
  input.pollActions(follow.yaw);
}

function frame(now: number): void {
  // Asked for first, so one frame that throws can't stop the game.
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  frameTimes.push(dt * 1000);
  if (frameTimes.length > 240) frameTimes.shift();
  const cpuStart = performance.now();

  if (frozen) {
    dropInput();
  } else if (!paused) {
    // A window open on a controller has the pad: its stick and buttons drive the window, so you
    // stand still. With a keyboard and mouse you can walk with a window open (walking away from
    // whoever you're talking to closes it). The skill panel and the map take every device.
    const padToMenu = panel.isOpen || (!!lifeUI?.takesPad && input.lastDevice === 'gamepad');
    // Open-world keys first, so a panel they open takes this frame's input. The skill book and
    // tree sit over everything while they're open, so the world's keys wait.
    if (lifeUI) {
      const keys = input.pollLife(padToMenu);
      if (!panel.isOpen) {
        for (const k of keys) {
          bugs?.note('key', { type: k });
          lifeUI.press(k);
        }
      }
    }
    const menuOpen = padToMenu || !!lifeUI?.modal;
    for (const m of input.pollMenu()) {
      bugs?.note('menu', { type: m });
      if (panel.isOpen) {
        panel.menu(m);
        continue;
      }
      // An open life panel (dialog, shop, bag...) takes the D-pad and A / B next.
      if (lifeUI?.menu(m)) continue;
      if (m === 'toggle' && (!net || playing)) panel.open('book');
      else if (m === 'tree' && (!net || playing)) panel.open('tree');
    }
    panel.tick();
    // Just closed (B, say): whatever closed it is still held, and mustn't count as a press in the
    // game once the menu is gone - B would slide. Reading the controls now uses those presses up,
    // even on a frame that runs no rules step to read them. A docked window that still has the
    // controller hasn't closed.
    if (menuOpen && !panel.isOpen && !lifeUI?.modal && !(lifeUI?.takesPad && input.lastDevice === 'gamepad')) input.pollActions(follow.yaw);
    const cam = input.pollCamera(dt);
    syncNet();
    const placing = !menuOpen && updateCombatAim(cam, dt);
    if (!menuOpen && !placing) {
      follow.rotate(cam.dYaw, cam.dPitch);
      follow.zoom(cam.dZoom);
      if (cam.dYaw !== 0 || cam.dPitch !== 0) lastCameraTouch = now;
    }
    if (life) rideCamera(dt, now);
    // Travelling by road on foot, the camera comes round behind you as it does on a mount, unless
    // you have been turning it yourself.
    if (walker?.mode === 'travel' && sim.player.mode !== 'ride' && now - lastCameraTouch > RIDE_CAMERA.autoDelay * 1000 && Math.hypot(sim.player.vel.x, sim.player.vel.z) > 1.5) {
      follow.yaw += angleDiff(follow.yaw, sim.player.facing) * (1 - Math.exp(-RIDE_CAMERA.autoFollow * dt));
    }
    // Online the world waits while the connection is down: inputs that can't reach the server
    // would only be taken back.
    if (online && !online.link.open) acc = 0;
    acc += dt;
    let steps = 0;
    while (acc >= STEP && steps < 5) {
      const pad = input.pollActions(follow.yaw);
      // With the panel open and an ability waiting to be placed, a hotbar press assigns it
      // instead of casting it.
      if (menuOpen && pad.abilitySlot >= 1 && panel.isAssigning) panel.assignToSlot(pad.abilitySlot);
      const own = scripted.length ? scripted.shift()! : menuOpen ? NO_ACTIONS : pad;
      // Auto-run or travel by road moves you, until your own moving takes over.
      const a = walker ? walker.steer(own, follow.yaw) : own;
      // targeting() supplies an aim when it has a mark or a placed circle; aimAssist() only
      // fills in the gaps it leaves; combatStance() keeps you facing the fight.
      stepOnce(combatStance(aimAssist(targeting(autoAttack ? autoAim(a) : a))));
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
    framesDrawn++;
  } else {
    draw(1, 0, 0);
    framesDrawn++;
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
}
requestAnimationFrame(frame);

// ---------- Hooks for automated tests ----------

const api = {
  ready: true,
  // Steps the game with the same scripted actions every frame (auto-walk, when on, moves you), and
  // draws the last; `drawn` false leaves that to the caller (a long walk sampled as it goes needn't
  // draw every sample, which a browser drawing in software, as CI's does, takes a second over).
  advance(frames: number, actions: Partial<Actions> = {}, drawn = true): void {
    for (let i = 0; i < frames; i++) {
      const own = { ...NO_ACTIONS, ...actions };
      stepOnce(walker ? walker.steer(own, follow.yaw) : own);
      followSim(STEP);
    }
    if (drawn) draw(1, 0, 0);
  },
  // Steps the game reading the real keyboard, mouse and controller, and draws the last (`drawn`
  // false leaves that to the caller, as advance's does).
  advanceLive(frames: number, drawn = true): void {
    for (let i = 0; i < frames; i++) {
      const cam = input.pollCamera(STEP);
      follow.rotate(cam.dYaw, cam.dPitch);
      follow.zoom(cam.dZoom);
      const own = input.pollActions(follow.yaw);
      stepOnce(walker ? walker.steer(own, follow.yaw) : own);
      followSim(STEP);
    }
    if (drawn) draw(1, 0, 0);
  },
  /** Auto-run and travel by road: what is walking you, where to, and how far is left. */
  walk() {
    if (!walker) return null;
    const r = walker.route;
    return { mode: walker.mode, marker: walker.marker, left: walker.left, length: r?.length ?? 0, short: r?.short ?? 0, refusal: walker.refusal() };
  },
  /** Marks (x, z) and sets off along the roads to it, as a click on the map does. False when you can't from here. */
  travelTo(x: number, z: number, label = 'Marked Spot'): boolean {
    if (!walker) return false;
    walker.mark(x, z, label);
    return walker.travel();
  },
  render(): void {
    draw(1, 0, 0);
  },
  reset(opts: { x?: number; z?: number; facing?: number; camYaw?: number } = {}): void {
    const facing = opts.facing ?? world.spawn.facing;
    sim.reset({ x: opts.x ?? world.spawn.x, z: opts.z ?? world.spawn.z, facing }, 0, build);
    if (terrain) {
      // Stand on the ground there, not inside it.
      const p = sim.player;
      p.pos.y = groundAt(terrain, world.index, p.pos.x, p.pos.z, terrain.height(p.pos.x, p.pos.z) + 1.2, 1.2);
      p.prevPos = { ...p.pos };
    }
    life?.afterReset(sim);
    range?.reset();
    vfx.reset();
    hud.clear();
    follow.reset(opts.camYaw ?? facing);
    followSim(STEP);
    draw(1, 0, 0);
  },
  state() {
    return JSON.parse(JSON.stringify({ frame: sim.frame, hitstop: sim.hitstop, player: sim.player, dummy: dummyActor() }));
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
  // Where the eye actually is, which the targeting view lifts. follow.pitch is what you chose and
  // doesn't change while aiming, so it can't be used to see this.
  cameraHeight(): number {
    return follow.camera.position.y;
  },
  /**
   * Where the hero's weapon is drawn: 'hand' when held, 'away' when put away (at the hip, across the
   * back), 'hidden' when it isn't drawn at all (travelling, a pack on the back).
   */
  heroWeapon(): WeaponAt {
    return hero.weaponState;
  },
  /**
   * At the controls of a vehicle: where each hand is and where what it holds is (the oars' handles,
   * a wheel's rim), left then right, in the world as last drawn; null with nothing to hold.
   */
  holds() {
    const h = hero.seatHolds?.hands;
    if (!h) return null;
    const at = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3()).toArray();
    return { hands: [at(hero.detail.joint('handL')), at(hero.detail.joint('handR'))], holds: h.map(at) };
  },
  // Targeting, the ground-aim circle, and the floating numbers currently on screen.
  combat() {
    return {
      target: (() => {
        const m = lockOn.mark();
        return m ? { key: m.key, name: m.name, hp: m.hp, x: m.x, z: m.z } : null;
      })(),
      locked: lockOn.locked,
      aiming: aimingSlot,
      reticle: aimingSlot !== 0 ? { x: reticle.x, z: reticle.z, range: reticle.range, radius: reticle.radius } : null,
      markers: hud.markerLog(),
    };
  },
  // Pretends Tab (1) or Shift-Tab (-1) was pressed.
  cycleTarget(step = 1): void {
    cycleTarget(step);
  },
  clearMarkers(): void {
    hud.clearMarkerLog();
  },
  // Testing: take a hit as if another fighter had landed it.
  takeHit(damage: number, dirX: number, dirZ: number, knock: number): void {
    sim.takeHit(damage, dirX, dirZ, knock);
  },
  // Testing: your stamina and MP as they would be part way through a fight (offline only).
  setVitals(v: { stamina?: number; mp?: number }): void {
    if (v.stamina !== undefined) sim.player.stamina = v.stamina;
    if (v.mp !== undefined) sim.player.mp = v.mp;
    draw(1, 0, 0);
  },
  // The skill panel: whether it's open and whether it's waiting for a hotbar slot.
  panel() {
    return { ...panel.state(), abilities: [...build.abilities] };
  },
  /** Puts the skill book's cursor on a skill (by id) or a slot, or the tree's on a node. */
  panelFocus(where: { book?: string; slot?: number; move?: number; node?: string }): void {
    panel.setFocus(where);
  },
  openPanel(view: 'book' | 'tree' = 'book'): void {
    panel.open(view);
  },
  /** Plans the way to a tree node and learns it, as clicking it and Learn would. */
  learnNode(id: string): boolean {
    return panel.learnNode(id);
  },
  selectBook(id: string): void {
    panel.selectBook(id);
  },
  /** Skill points, levels and experience, as the book shows them. */
  skills() {
    return {
      budget: skillPoints(),
      left: pointsLeft(build.skills, skillPoints()),
      levels: Object.fromEntries(BOOK.map((b, i) => [b.id, sim.levels[i] ?? 1])),
      xp: { ...(life ? (life.state.skillXp ?? {}) : yardXp) },
    };
  },
  // What a drag between two hotbar slots ends up doing.
  swapSlots(a: number, b: number): void {
    applyBuild(swapSlots(build, a, b));
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
      skills: [...p.skills],
      abilities: [...p.abilities],
      cooldowns: [...p.cooldowns],
      sprinting: p.sprinting,
      crouching: p.crouching,
      castAbility: p.castAbility,
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
    return { chosen: { ...build }, using: { skills: [...p.skills], weapon: p.weapon, abilities: [...p.abilities], movement: [...p.movement] } };
  },
  setBuild(b: Build): boolean {
    // Only what your points allow: on the island, what its quests and milestones have earned.
    if (!validBuild(b, skillPoints())) return false;
    panel.setBuild(b);
    applyBuild(b);
    return true;
  },
  // Testing: send a build without checking it first, to see the server turn it down.
  sendRawBuild(b: Build): void {
    net?.sendBuild(b.skills, b.weapon, b.abilities, b.movement);
  },
  // Puts an actor of a kind somewhere specific, so a test does not have to wait for one to
  // wander over. `i` indexes the actors of that kind, in spawn order.
  placeActor(kind: string, i: number, x: number, z: number): void {
    const a = sim.actors.all().filter((v) => v.kind === kind)[i];
    if (!a) return;
    a.x = x;
    a.z = z;
    a.y = 0;
    a.homeX = x;
    a.homeZ = z;
  },
  // What the server says is in the world around you; empty when playing offline.
  netActors() {
    return net?.actors ?? [];
  },
  /** The server's monsters as drawn this frame (between its updates), with how white each one is. */
  shownActors() {
    const now = performance.now();
    return shownActors.map((a) => ({ ...a, flash: netMonsters?.flash(a.id, now) ?? 0 }));
  },
  /** Online hit effects so far: swings guessed to land, the server's confirmations (and how many matched a guess or came late), flashes, and slams and deaths shown. */
  netFx() {
    return netMonsters ? { ...netMonsters.counts } : null;
  },
  actors(kind?: string) {
    return sim.actors
      .all()
      .filter((a) => !kind || a.kind === kind)
      .map((a) => ({
        id: a.id,
        kind: a.kind,
        x: +a.x.toFixed(3),
        y: +a.y.toFixed(3),
        z: +a.z.toFixed(3),
        hp: a.hp,
        maxHp: a.maxHp,
        alive: isAlive(a),
        state: stateName(a),
        deadFrame: a.deadFrame,
        flash: a.flashFrame,
        mass: a.mass,
        gone: a.gone,
        transient: a.transient,
        angry: a.angry,
        rallyTo: a.rallyTo,
        calling: a.calling,
        fuse: a.fuse,
        group: a.group,
        slamCd: a.slamCd,
        gatherCd: a.gatherCd,
        targetX: +a.targetX.toFixed(3),
        targetZ: +a.targetZ.toFixed(3),
      }));
  },
  // Testing: a blow from you to one actor, by id, as if a weapon had landed it.
  hurtActor(id: number, amount: number): void {
    const a = sim.actors.get(id);
    if (a && isAlive(a)) sim.damage(targetOf(a), amount, 0, 0, sim.player.weapon);
  },
  // Testing: sets fields on an actor by id (a cooldown, a fuse), to set up a moment directly.
  setActor(id: number, fields: Partial<Actor>): void {
    const a = sim.actors.get(id);
    if (a) Object.assign(a, fields);
  },
  // Testing: puts a new actor of a kind in the world, as if a fight had made it (it won't respawn).
  spawnActor(kind: string, x: number, z: number): number {
    const a = sim.actors.spawn({ kind, x, z, seed: (sim.frame * 2654435761 + sim.actors.all().length * 40503) >>> 0 });
    a.transient = true;
    startBrain(a, sim.sighting());
    return a.id;
  },
  // Testing: monsters that never get angry, for tests about something else that hit them.
  calmMonsters(on = true): void {
    sim.actors.calm = on;
    if (on) for (const a of sim.actors.all()) a.angry = 0;
  },
  skillPanel(open?: boolean): boolean {
    if (open === true && !panel.isOpen) panel.open('book');
    if (open === false && panel.isOpen) panel.close();
    return panel.isOpen;
  },
  /** Testing: the height of the highest ground circle drawn over (x, z), or null where there is none. */
  circleHeight(x: number, z: number): number | null {
    return spells.heightAt(x, z);
  },
  /** Testing: the height of your farm's soil or furrows drawn over (x, z), or null where there is none. */
  farmGround(x: number, z: number): number | null {
    return lifeView?.farmGroundAt(x, z) ?? null;
  },
  /** Testing: where the shadow under you is drawn. */
  shadowHeight(): number {
    return blob.position.y;
  },
  /** A portrait the UI shows (an image URL): 'player' (your face), 'body' (all of you) or an NPC's id; and how many of yours the studio has taken. */
  portrait(who: string) {
    return { url: portraitOf(who), taken: studio.taken };
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
  // ---- Open world ----
  /** Where your vehicles are drawn this frame. */
  drawnVehicles() {
    return lifeView?.drawnVehicles() ?? [];
  },
  /** The life systems' state, as plain data. */
  life() {
    if (!life) return null;
    return JSON.parse(JSON.stringify({ ...life.state, focus: life.focus, placing: life.placing, resting: life.resting }));
  },
  /** Where the quest you're on leads you (the ring on the maps, the marker on the compass). */
  questGoal() {
    return lifeUI?.goal() ?? null;
  },
  /** The hour of the day the sky shows, 0..24 (online the world's, from the server's clock). */
  dayHour(): number | null {
    return life ? skyHour() : null;
  },
  /** Queues a life command (it runs on the next sim step). */
  lifeCommand(c: Parameters<Life['command']>[0]): void {
    life?.command(c);
  },
  /** Jumps the player to (x, z) on the ground (`drawn` false leaves drawing it to the caller, as advance's does). */
  teleport(x: number, z: number, facing?: number, drawn = true): void {
    teleport(x, z, facing);
    followSim(STEP);
    if (drawn) draw(1, 0, 0);
  },
  /** Where things are on this island. */
  zone() {
    if (!world.zone) return null;
    const r = world.zone.recipe;
    return JSON.parse(JSON.stringify({ places: r.places, npcs: r.npcs, outposts: r.outposts, workbenches: r.workbenches, housePlots: r.housePlots, updrafts: r.updrafts, nodes: r.nodes, spawn: r.spawn, ramps: world.zone.gen.ramps.map((pts) => [pts[0], pts[pts.length - 1]]) }));
  },
  /** A carved mountain path as points from bottom to top (every few metres). */
  rampPath(i = 0): Array<[number, number]> {
    const r = world.zone?.gen.ramps[i] ?? [];
    return r.filter((_, k) => k % 3 === 0 || k === r.length - 1).map(([x, z]) => [x, z]);
  },
  ground(x: number, z: number): number {
    return terrain ? terrain.height(x, z) : 0;
  },
  /** What the ground is made of under a point (SURFACE in src/sim/terrain.ts). */
  surface(x: number, z: number): number {
    return terrain ? terrain.surfaceAt(x, z) : 0;
  },
  /**
   * Scene objects whose name starts with `prefix`, with where they are (tests and debugging):
   * the origin, and the centre of what is drawn, which differ for models anchored at an edge.
   */
  sceneObjects(prefix: string) {
    type Seen = { name: string; x: number; y: number; z: number; visible: boolean; centre: { x: number; y: number; z: number } };
    const out: Seen[] = [];
    const v = new THREE.Vector3();
    const c = new THREE.Vector3();
    const box = new THREE.Box3();
    const r = (n: number) => +n.toFixed(2);
    stage.scene.traverse((o) => {
      if (!o.name.startsWith(prefix)) return;
      o.getWorldPosition(v);
      box.setFromObject(o).getCenter(c);
      let shown = o.visible;
      for (let p = o.parent; p && shown; p = p.parent) shown = p.visible;
      out.push({ name: o.name, x: r(v.x), y: r(v.y), z: r(v.z), visible: shown, centre: { x: r(c.x), y: r(c.y), z: r(c.z) } });
    });
    return out;
  },
  /** Writes the island to this browser now (tests and bug-report replays). Online the server keeps it. */
  saveNow(): void {
    if (!online && life) saveLife(life, sim);
  },
  clearSave(): void {
    if (online) void online.link.reset();
    else clearLife();
  },
  /** Online play: who you are and the connection (null offline). */
  /** Online: everyone else in your channel, as drawn. */
  peers() {
    return peers?.list() ?? [];
  },
  online() {
    return online
      ? {
          account: online.account.username,
          character: online.welcome.character,
          channel: online.welcome.channel,
          dev: online.welcome.dev,
          claims: online.link.claims,
          status: online.link.status,
          frozen,
          ticks: online.link.ticks,
          lifeLoaded: online.lifeLoaded?.() ?? false,
          lastSaved: online.link.lastSaved,
          ack: prediction?.lastAck ?? 0,
          seq: prediction?.seq ?? 0,
          corrections: prediction?.corrections ?? 0,
          maxCorrection: prediction?.maxCorrection ?? 0,
        }
      : null;
  },
  /** Which life panel is open, if any. */
  lifePanel(): string | null {
    return lifeUI?.openPanel ?? null;
  },
  closeLifePanel(): void {
    lifeUI?.closeAll();
  },
  pressLife(k: Parameters<LifeUI['press']>[0]): void {
    lifeUI?.press(k);
  },
  setLag(ms: number): void {
    if (online) online.link.lag = ms;
    else net?.setLag(ms);
  },
  /** The bug reporter: what it is doing and the last report it saved (null when it is off). */
  bugs() {
    return bugs?.status() ?? null;
  },
  /** Same as pressing \ (toggle) or Backspace twice (discard). */
  bugReport(action: 'toggle' | 'discard' = 'toggle'): void {
    if (action === 'discard') bugs?.discard();
    else bugs?.toggle();
  },
};

(window as unknown as { __game: typeof api }).__game = api;

// ---------- Bug reports ----------
// \ (or clicking both sticks) records one: see src/app/bugs/reporter.ts. The dev server saves it
// to bugs/, and /fix-bugs in Claude Code works through them. Off in automated tests unless asked for.

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Everything a bug report wants to know about the game at one moment. */
function bugSnapshot(): Record<string, unknown> {
  const p = sim.player;
  const mark = lockOn.mark();
  const eye = follow.camera.position;
  return {
    mode: openWorld ? 'open world (Emberholm)' : serverUrl ? 'online battle' : raidCount ? 'raid stress test' : 'training yard',
    frame: sim.frame,
    paused,
    device: input.lastDevice,
    player: p,
    camera: { yaw: r3(follow.yaw), pitch: r3(follow.pitch), distance: r2(follow.distance), eye: [r2(eye.x), r2(eye.y), r2(eye.z)] },
    panels: { life: api.lifePanel(), skills: panel.isOpen ? panel.view : null, aimingSlot },
    target: mark ? { name: mark.name, hp: mark.hp, x: r2(mark.x), z: r2(mark.z), locked: lockOn.locked } : null,
    riding: life && p.mode === 'ride' ? (ridden(life, sim) ?? null) : null,
    walk: walker ? { mode: walker.mode, marker: walker.marker, left: r2(walker.left) } : null,
    nearby: sim.actors
      .all()
      .map((a) => ({ id: a.id, kind: a.kind, x: r2(a.x), y: r2(a.y), z: r2(a.z), hp: a.hp, alive: isAlive(a), state: stateName(a), dist: r2(Math.hypot(a.x - p.pos.x, a.z - p.pos.z)) }))
      .filter((a) => a.dist < 40)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 24),
    life: life ? { ...life.state, focus: life.focus, placing: life.placing, resting: life.resting } : null,
    build,
    net: api.net(),
    perf: perf(),
  };
}

/** The player in a few numbers, ten times a second, for a report's timeline. */
function bugSample(): Record<string, unknown> {
  const p = sim.player;
  const s: Record<string, unknown> = {
    f: sim.frame,
    x: r2(p.pos.x),
    y: r2(p.pos.y),
    z: r2(p.pos.z),
    vx: r2(p.vel.x),
    vy: r2(p.vel.y),
    vz: r2(p.vel.z),
    mode: p.mode,
    grounded: p.grounded,
    facing: r3(p.facing),
  };
  if (p.hp !== COMBAT.maxHp) s.hp = p.hp;
  if (p.sprinting) s.sprinting = true;
  if (p.crouching) s.crouching = true;
  if (life) {
    const v = p.mode === 'ride' ? ridden(life, sim) : undefined;
    if (v) s.ride = { id: v.id, def: v.def, x: r2(v.x), y: r2(v.y), z: r2(v.z), speed: r2(v.speed), heading: r3(v.heading) };
    if (life.focus) s.focus = `${life.focus.action}: ${life.focus.label}${life.focus.ok ? '' : ' (not now)'}`;
    if (life.placing) s.placing = true;
  }
  const lp = api.lifePanel();
  if (lp) s.panel = lp;
  else if (panel.isOpen) s.panel = panel.view === 'tree' ? 'skill tree' : 'skill book';
  return s;
}

if (testMode ? params.has('bugs') : params.get('bugs') !== '0') {
  bugs = new BugReporter({
    canvas,
    snapshot: bugSnapshot,
    save: () => (life ? saveData(life, sim) : null),
    sample: bugSample,
    device: () => input.lastDevice,
    test: testMode,
    speech: params.get('bugspeech') !== '0',
    lang: params.get('buglang') || navigator.language || 'en-US',
  });
  // Mouse readings thrown away as impossible, so a report can show whether one caused a camera jump.
  input.mouse.onDrop = (dx, dy, why) => bugs?.note('mouse', { type: why, dx, dy, raw: input.rawMouse });
  if (lifeUI) {
    lifeUI.onBugReport = () => bugs?.toggle();
    lifeUI.bugKey = () => bugs?.key ?? '\\';
  }
}

// ---------- The game server ----------
// Set up last, once everything it touches exists. The badge shows who you are and whether the
// server is there, with Characters (back to the character select screen) and Sign Out. While the
// server is away - being updated, or the connection dropped - the world freezes under a screen
// that says so, and carries on when it's back; play stops for good if another window takes this
// character or the sign-in ends.

if (online) {
  const { link } = online;
  const exitToSelect = () => leaveFor(plainUrl());
  const badge = new OnlineBadge(`${online.welcome.character.name} · Emberholm ${online.welcome.channel}`, {
    characters: exitToSelect,
    signOut: async () => {
      await signOut();
      leaveFor(plainUrl());
    },
  });
  if (lifeUI) lifeUI.onExitToSelect = exitToSelect;
  const overlay = new NetOverlay();
  let dropTimer = 0;
  const freeze = (on: boolean) => {
    if (frozen === on) return;
    frozen = on;
    acc = 0;
    if (on && document.pointerLockElement) document.exitPointerLock();
  };
  const stopIf = (s: typeof link.status) => {
    badge.set(s);
    clearTimeout(dropTimer);
    if (s === 'online') {
      freeze(false);
      overlay.hide();
    } else if (s === 'updating') {
      freeze(true);
      overlay.show('updating');
    } else if (s === 'reconnecting') {
      // Frozen at once; a blip shorter than this isn't worth a screen.
      freeze(true);
      dropTimer = window.setTimeout(() => overlay.show('reconnecting'), 400);
    } else {
      freeze(false);
      overlay.hide();
      paused = true;
      showStopped(s);
      // Still loading: the title screen mustn't hide why play stopped.
      void splash?.fadeOut();
    }
  };
  link.onStatus = stopIf;
  // A new connection counts inputs from scratch: start again from the server's next word.
  link.onReconnect = () => {
    prediction?.resync();
    ahead.length = 0;
  };
  link.onError = (text) => life?.fromServer({ t: 'toast', text, kind: 'bad' });

  // Your island as the server has it, and the parts that move with you as of each update.
  let you: YouState | null = null;
  /** Commands run here ahead of the server (see life.remote below), with the input each went with. */
  const ahead: Array<{ seq: number; c: Command }> = [];
  let lastRev = -1;
  let lifeLoaded = false;
  const solidScarecrows = new Set<number>();
  /** What's built on your island (farms and houses, where), last time the grass was laid round it. */
  let groundKey = '';
  /** Your island as the server last sent it, kept as it came. */
  let base: LifeState | null = null;
  if (prediction && life) {
    // Picking a pack up or putting it down, loading one or taking one out, getting in or out: run
    // here at once as well as on the server, so the pack is on your back (or you're in the seat)
    // without waiting a round trip for it. Until the server has run it too, whatever it sends is
    // taken with what's still to come run again on top.
    const quick = (c: Command): boolean => c.t === 'drop' || (c.t === 'exit' && !sim.player.host) || (c.t === 'interact' && !!life.focus?.ok && QUICK.has(life.focus.action));
    life.remote = (c) => {
      const seq = prediction.seq + 1;
      online.link.command(seq, c);
      if (!quick(c) || ahead.length >= 8) return;
      if (life.state === base) life.state = structuredClone(base);
      runCommand(life, sim, c);
      ahead.push({ seq, c });
    };
    prediction.beforeReplay = () => {
      if (!you) return;
      // What the server has run too is in what it sent.
      while (ahead.length && ahead[0].seq <= you.ack) ahead.shift();
      if (ahead.length && base) life.state = structuredClone(base);
      const s = life.state;
      s.clock = you.clock;
      s.labor = you.labor;
      s.weather = you.weather;
      s.vehicles = ahead.length ? structuredClone(you.vehicles) : you.vehicles;
      life.resting = you.resting;
      life.placing = you.placing;
      for (const a of ahead) runCommand(life, sim, a.c);
    };
  }
  const onTick = (t: WorldTick) => {
    if (life && t.life) {
      lifeLoaded = true;
      base = t.life.state;
      life.state = t.life.state;
      life.placing = t.life.placing;
      life.resting = t.life.resting;
      if (t.life.rev !== lastRev) {
        lastRev = t.life.rev;
        life.revision++;
        // What you've built is solid here as it is on the server.
        for (const h of life.state.houses) addHouseColliders(life, sim, h);
        for (const sc of life.state.scarecrows) {
          if (solidScarecrows.has(sc.id)) continue;
          solidScarecrows.add(sc.id);
          addScarecrowCollider(sim, sc);
        }
        // The grass is laid again only round something new built: a pack picked up changes the
        // island too, and laying it all again then is a stutter.
        const ground = life.state.scarecrows.map((sc) => sc.id).join(',') + '|' + life.state.houses.map((h) => `${h.plot}:${h.stage}`).join(',');
        if (ground !== groundKey) {
          groundKey = ground;
          lifeView?.onGroundChanged?.();
        }
      }
    }
    you = t.you;
    net?.applyWorld(t.tick, { id: t.you.id, ack: t.you.ack, player: stateFromServer(t.you.p) }, t.arrows ?? [], t.meteors ?? [], t.events ?? [], t.actors ?? []);
    if (life) for (const e of t.lifeEvents ?? []) life.fromServer(e);
  };
  link.onTick = onTick;
  // Whatever came while the page was still loading: the newest island, then the newest tick.
  if (link.latestLife && link.latest && !link.latest.life) onTick({ ...link.latest, life: link.latestLife });
  else if (link.latest) onTick(link.latest);
  online.lifeLoaded = () => lifeLoaded;
  stopIf(link.status);

  // Into the game: the title screen fades once the first frames are drawn (the first one compiles
  // the shaders) and your island has arrived, so it opens on your island as it is.
  if (splash) {
    const title = splash;
    title.say('Lighting the Lanterns…');
    const started = performance.now();
    const ready = () => framesDrawn >= 3 && (lifeLoaded || performance.now() - started > 4000);
    const wait = () => (ready() ? void title.fadeOut() : requestAnimationFrame(wait));
    requestAnimationFrame(wait);
  }
}
