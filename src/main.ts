import * as THREE from 'three';
import { defaultBuild, parseBuild, pointsLeft, swapSlots, validBuild } from './content/build';
import { loadBuild, saveBuild } from './app/savedBuild';
import { crouchKeySlides, Input } from './input/input';
import { INTERP_TICKS, WorldFeed, type NetActor } from './net/worldFeed';
import { NetMonsters } from './net/netMonsters';
import { Prediction } from './net/netPlayer';
import { NetSpells } from './net/netSpells';
import { FollowCamera } from './render/camera';
import { GRAPHICS } from './render/look';
import { Hero } from './render/character';
import { TrainingDummy } from './render/dummy';
import { ActorView } from './render/actors';
import { actorKindAt, actorKindIds, actorKindIndex, findKind, kindName } from './content/actors';
import { isAlive, behaviour, stateProgress } from './engine/creatures';
import { NO_ACTIONS, type Actions, type GameEvent, type PlayerState, angleDiff, heightAboveGround } from './engine/rules';
import { dungeonDef, groundAt, inRect, type BoxCollider, type Deck } from './engine/zone';
import { type Life, type FocusAction, ridden, hourAt, hourOfDay, skillBudget, trainedBy, type Command } from './engine/island';
import { Aiming } from './app/aiming';
import { Hud } from './ui/hud';
import { Stage, TRAINING_STAGE } from './render/scene';
import { CIRCLE, SpellView } from './render/spells';
import { Vfx } from './render/vfx';
import { MissileView } from './render/missiles';
import { OpenStage } from './render/open/stage';
import { loadModels } from './render/open/models';
import { Engine } from './engine/engine';
import { LifeView, sitIn } from './render/open/life';
import { LifeUI, type LifePress } from './ui/life/lifeUI';
import { clearLife, savedIsland } from './app/save';
import { goOnline } from './app/online';
import { readOptions } from './app/options';
import { makeTestApi } from './app/testApi';
import { wireOnline } from './app/onlineWiring';
import { wireBugReports } from './app/bugWiring';
import { splash } from './ui/splash';
import { WorldPeers } from './net/worldPeers';
import { PeersView } from './render/open/peersView';
import { MinigamesUI } from './ui/minigames/minigames';
import { PartyUI } from './ui/party/partyUI';
import { uiIcon } from './ui/theme/icons';
import { GameTables, seatedState } from './render/open/gameTables';
import type { SpaceView } from './net/worldLink';
import { BugReporter } from './app/bugs/reporter';
import { installLogCapture } from './app/bugs/logs';
import { AutoWalk } from './input/autoWalk';
import { RIDE_CAMERA } from './content/traversal';
import { rideable, isBoat } from './content/vehicles';
import { ABILITY_ICONS, WEAPON_ICONS, WEAPON_NAMES } from './ui/icons';
import type { MarkerKind } from './ui/hud';
import { BOOK, levelOf, levelsFrom, NODES, resolveSkills, sameLevels, SKILL_POINTS, type ResolvedSkills } from './content/skills';
import { SkillsPanel } from './ui/skills/panel';
import {
  ABILITIES,
  abilityMpFor,
  abilityRadius,
  MOVEMENT_SKILLS,
  castFramesFor,
  comboFor,
  COMBAT,
  DUMMY,
  meleeTargets,
  movementCooldownFor,
  movementStaminaFor,
  MP,
  NO_ABILITY,
  STAMINA,
  STEP,
  type Build,
} from './content/tuning';
import './ui/theme/theme.css';
import './ui/theme/hud.css';
import './ui/theme/windows.css';
import './ui/theme/skills.css';
import { initUiScale } from './ui/theme/scale';
import { Portraits } from './render/portrait';
import { Studio } from './render/studio';
import { DungeonVisit } from './app/dungeonVisit';
import { Perf } from './app/perf';
import { migrateStorage } from './app/storage';

// What this browser kept under the game's old name moves to its new one, before anything reads it.
migrateStorage(localStorage);

// The UI is laid out on a virtual screen and scaled to the window; start that before anything
// builds UI.
initUiScale(document.getElementById('ui') as HTMLElement);

// The address's options (?test, ?yard, ?as=name and the rest) are listed in src/app/options.ts.
// Console output and errors are kept from here on, for bug reports.
installLogCapture();
const opt = readOptions();
const { test: testMode, openWorld, lag: lagMs } = opt;

// The island's models load from the start (online, while you sign in and choose a character).
const modelsLoading = openWorld ? loadModels().then((m) => (splash?.step('models'), m)) : null;

// Emberholm is played on the game server: sign in and choose a character, and it hands over their
// island and build, and keeps them from then on. Automated tests and the training yard stay
// offline. Online, all of it happens on the title screen (src/ui/splash.ts), which shows the island
// being built and then fades into the game.
const online = openWorld && !testMode ? await goOnline(opt) : null;
if (splash) {
  splash.say('Raising the Island…');
  splash.toward('world', 3);
  await splash.paint();
}

const canvas = document.getElementById('game') as HTMLCanvasElement;
// Your skills and loadout, kept between visits: with your character on the game server in the open
// world, in this browser elsewhere. The welcome's is the build the server applied, already held to
// the points your island has earned (which this page doesn't know until the island arrives), so
// it's only checked for shape here.
let build: Build = online ? (parseBuild(online.welcome.build, Infinity) ?? defaultBuild()) : loadBuild();
// The rules, reached only through the engine (src/engine/): the island or the yard (with a war-band
// of goblins, if asked for), you in it, and offline the yard's arrows and meteors. Online (Emberholm
// on the game server, and its developer zones) the server decides hits, so the rules here run
// without the training dummy and hit pause, and only predict your own moves.
const engine = new Engine({ openWorld, online: !!online, goblins: opt.goblins, build });
const { world, terrain, sim, range } = engine;

// Online, what the server says of the world (you, monsters, arrows, meteors, effects), timed to be
// drawn; inputs go out over the world link.
const net = online ? new WorldFeed((seq, view, raw, stick) => online.link.sendInput(seq, view, [...raw, ...stick])) : null;
const netSpells = net ? new NetSpells(net, resolveSkills(build.skills)) : null;
// Online play: your hero is predicted here and corrected by the server; other players are drawn
// from the server's updates (WorldPeers, with their vehicles and gliders).
const prediction = net ? new Prediction(engine, net) : null;
/**
 * Online, while the server is away (being updated, or the connection dropped): no rules steps,
 * nothing pressed counts, and the last frame stays up under the screen that says so.
 */
let frozen = false;
const serverRules = engine.online;
/** Ground height under a point: a copy's floor where you're in one, the island's terrain, or 0 on the flat training grounds. */
const groundY = (x: number, z: number): number => engine.groundY(x, z);
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
  openStage ?? new Stage(canvas, world, TRAINING_STAGE);
const hero = new Hero();
stage.scene.add(hero.root);
const dummy = new TrainingDummy(world.dummy.x, world.dummy.z);
dummy.root.position.y = groundY(world.dummy.x, world.dummy.z);
const actorView = new ActorView(actorKindIds(), 64, terrain ? groundY : null);
const dummyActor = () => sim.actorOfKind('dummy');
// Online the server owns what lives in the world: its dummy is drawn where it has one (the
// island's, a yard's), and the rules' own only offline.
dummy.root.visible = !serverRules;
const DUMMY_KIND = actorKindIndex('dummy');
stage.scene.add(dummy.root);
stage.scene.add(actorView.group);
// What creatures throw, in flight. Offline only for now: online the server flies them.
const missileView = new MissileView();
stage.scene.add(missileView.group);
const vfx = new Vfx(stage.scene);
const spells = new SpellView(stage.scene, vfx);
/**
 * The terrain's height at (x, z) and above it whatever is drawn over it within `pad` metres (farm soil
 * and furrows: yours and everyone else's here), for what lies on the ground to lie on top of.
 */
const drawnGround = (x: number, z: number, pad: number): number =>
  terrain ? terrain.height(x, z) + Math.max(lifeView?.raisedAt(x, z, pad) ?? 0, peersView?.raisedAt(x, z, pad) ?? 0) : 0;
// Warning circles lie on the island's hills and farms (and on a deck or roof under whoever they're
// about), floating on the sea rather than sinking under it.
if (terrain) {
  spells.ground = {
    cell: terrain.cell,
    origin: terrain.min,
    height: (x, z, near, pad) =>
      Math.max(terrain.water, Number.isFinite(near) ? groundAt(terrain, world.index, x, z, near, 0.5) : terrain.height(x, z), drawnGround(x, z, pad)),
  };
}
const follow = new FollowCamera(innerWidth / innerHeight, openWorld ? GRAPHICS.viewDistance : 320, openWorld ? 40 : 14);
// Over hills and water the camera must not dip into the ground or under the sea, and it pulls in
// rather than looking through a wall.
if (terrain)
  follow.groundAt = (x, z) => {
    // Indoors, not below the floor of the storey you are on.
    const inside = openStage?.village.indoors;
    let floor = -Infinity;
    if (inside) {
      const b = inside.building;
      const c = Math.cos(b.rot);
      const s = Math.sin(b.rot);
      const lx = (x - b.x) * c - (z - b.z) * s;
      const lz = (x - b.x) * s + (z - b.z) * c;
      if (Math.abs(lx) < b.plan.w / 2 && Math.abs(lz) < b.plan.d / 2) floor = inside.floor + 0.45;
    }
    return Math.max(terrain.water + 0.35, terrain.height(x, z) + 0.45, floor);
  };
// Goblin's Dread: under the hood of rock over the ledge behind the Windspire's falls the ground
// behind you is the cliff above the hood, so the eye stays under the hood instead (camera.ts).
if (terrain && world.index) {
  const idx = world.index;
  follow.terrainAt = (x, z) => terrain.height(x, z);
  follow.ceiling = (x, y, z) => {
    const found: { d: Deck | null } = { d: null };
    idx.eachDeck(x, z, 0.5, (d) => {
      if (d.top > y + 1 && d.top < y + 12 && inRect(d, x, z) && (!found.d || d.top < found.d.top)) found.d = d;
    });
    const hood = found.d;
    if (!hood) return null;
    const eye = hood.top - 2.1;
    // Only a hood with room for the eye under it, above the ground and the sea (not a pier over a swimmer).
    if (eye < Math.max(terrain.water, terrain.height(x, z)) + 1.2) return null;
    return { eye, under: (px, pz) => inRect(hood, px, pz, 0.6) };
  };
}
if (world.index) {
  const idx = world.index;
  follow.blocker = (fx, fy, fz, cx, cy, cz) => {
    let best = 1;
    const mx = (fx + cx) / 2;
    const mz = (fz + cz) / 2;
    const reach = Math.hypot(cx - fx, cz - fz) / 2 + 1;
    const village = openStage?.village ?? null;
    const indoors = village?.indoors ?? null;
    /** Where along the segment it first meets a box (padded), unless it passes over the box's top. */
    const meet = (b: BoxCollider, top: number, pad: number) => {
      // The segment in the box's own frame, clipped against its padded footprint.
      const ax = fx - b.x;
      const az = fz - b.z;
      const bx = cx - b.x;
      const bz = cz - b.z;
      const la = [ax * b.cos - az * b.sin, ax * b.sin + az * b.cos];
      const lb = [bx * b.cos - bz * b.sin, bx * b.sin + bz * b.cos];
      const half = [b.hw + pad, b.hd + pad];
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
      if (fy + (cy - fy) * t0 > top) return;
      best = Math.min(best, t0);
    };
    idx.eachBox(mx, mz, reach, (b) => {
      if (b.top < -1e8) return;
      // The building you are in holds the camera with its whole walls, below (indoors.shell).
      if (indoors && village?.inIndoors(b.x, b.z)) return;
      meet(b, b.top, 0.25);
    });
    // Every building's walls, doorways and all: the camera never slips into one through its door, and
    // indoors the room keeps it in up to where the house is cut open.
    village?.eachShell(mx, mz, reach, (w, top) => meet(w, top, 0.2));
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
const life = engine.life;
/** Gives the island a command, noted in a bug report's event log: the windows' commands come through here. */
function islandCommand(c: Command): void {
  const { t, ...rest } = c;
  bugs?.note('command', { type: t, ...rest });
  engine.command(c);
}
input.worldMode = !!life;
if (terrain) {
  vfx.ground = groundY;
  vfx.raised = (x, z, r) => drawnGround(x, z, r) - terrain.height(x, z);
}
const lifeView = life ? new LifeView(stage.scene, life, models, hero) : null;
if (lifeView && openStage) lifeView.onGroundChanged = () => openStage.foliage.invalidate();
// Your houses are drawn by the village, from its kit, as far as each is built.
if (lifeView && openStage) lifeView.houseSink = (houses) => openStage.village.setHouses('mine', houses);
// Auto-run (H) and travel by road from the map: it only makes the controls, so it works online too.
const walker = life ? new AutoWalk({ sim, world, life }) : null;
const lifeUI = life
  ? new LifeUI({
      life,
      command: islandCommand,
      sim,
      world,
      camera: () => follow.camera,
      yaw: () => follow.yaw,
      device: () => input.lastDevice,
      walk: walker ?? undefined,
    })
  : null;
// Online: everyone else in your channel of Emberholm, the plots they hold, and whether this server
// offers the developer panel.
const peers = online && life && world.zone ? new WorldPeers(world.zone, engine, life, online.welcome.character.id, online.link) : null;
// ...and drawn: a body and a name each, and what of their island everyone sees (src/render/open/peersView.ts).
const peersView = online && peers ? new PeersView(stage.scene, models, peers, online.welcome.character.id) : null;
if (peers && openStage) peers.onGroundChanged = () => openStage.foliage.invalidate();
if (peersView && openStage) peersView.onGroundChanged = () => openStage.foliage.invalidate();
if (peersView && openStage) peersView.houseSink = (owner, houses) => openStage.village.setHouses(owner, houses);
if (peersView) peersView.mineView = lifeView;
if (peers && life) life.othersVehicles = () => peers.vehicles(sim.player);
if (online && life) {
  const me = online.welcome.character.name;
  life.plotOwner = (plot) => {
    const holder = online.link.claims[plot];
    return holder && holder !== me ? holder : null;
  };
}
// Online: mini-games with the other players here (src/ui/minigames), at tables everyone in the
// channel sees (src/render/open/gameTables.ts). F on another player challenges them; at a table you
// stay in your seat until the game is over.
const gameTables = online ? new GameTables(stage.scene) : null;
const minigames =
  online && life && lifeUI
    ? new MinigamesUI({
        link: online.link,
        life,
        openPanel: () => lifeUI.openPanel,
        freeMouse: () => document.pointerLockElement && document.exitPointerLock(),
      })
    : null;
// Online: parties (src/ui/party): invite someone by name or from the players near you (O), and go
// into a dungeon's copy together.
const party =
  online && lifeUI && peers
    ? new PartyUI({
        link: online.link,
        me: online.welcome.character.id,
        openPanel: () => lifeUI.openPanel,
        freeMouse: () => document.pointerLockElement && document.exitPointerLock(),
        nearby: () => {
          const p = sim.player.pos;
          return peers
            .list()
            .filter((o) => o.online && !o.bot)
            .map((o) => ({ id: o.id, name: o.name, dist: Math.hypot(o.x - p.x, o.z - p.z) }))
            .sort((a, b) => a.dist - b.dist);
        },
      })
    : null;
if (party && lifeUI) lifeUI.addMenuButton('party', uiIcon('party', 34), 'Party', 'O');
// The Admin menu, for admins only (the server says who): Developer Tools, the developer zones and pages.
if (online?.welcome.dev && lifeUI) lifeUI.addMenuButton('admin', uiIcon('mallet', 34), 'Admin', '');
// ---------- Goblin's Dread: into a copy of a dungeon and out again (src/app/dungeonVisit.ts) ----------
const visit = life
  ? new DungeonVisit({
      engine,
      stage: openStage,
      place: (x, y, z, facing) => {
        // Online the server moves you; this puts you there at once, as it says you've gone, rather
        // than a moment later with its next tick.
        if (!terrain) return;
        walker?.stop();
        engine.place(x, z, facing, y);
        follow.reset(facing);
      },
      indoors: (inside) => {
        if (lifeView) lifeView.indoors = inside;
      },
    })
  : null;
// Offline, fallen out of the bottom of a copy, the rules put you back where it's entered: the
// camera and auto-run follow.
engine.onPlaced = (facing) => {
  walker?.stop();
  follow.reset(facing);
};
/**
 * F at a dungeon's portal (its prompt: interact.ts enterDungeon / leaveDungeon). Offline the browser
 * takes you through itself; online the server takes you, with your party, into your copy.
 */
function onPortal(enter: boolean, dungeon: string): void {
  if (!visit) return;
  if (online) {
    online.link.dungeon(dungeon, enter);
    return;
  }
  if (enter) visit.enterDungeonHere(dungeon, true);
  else visit.leaveDungeonHere(true);
}
/** F at a dungeon's portal or its way out: through it (online, the server takes you). */
function portalPress(k: LifePress): boolean {
  const f = life?.focus;
  if (k !== 'interact' || (f?.action !== 'enterDungeon' && f?.action !== 'leaveDungeon')) return false;
  if (f.ok && f.dungeon) onPortal(f.action === 'enterDungeon', f.dungeon);
  return true;
}
// A key the island's windows would take goes first to a dungeon's portal, then a mini-game, then the party window.
if (lifeUI) lifeUI.intercept = (k) => portalPress(k) || !!minigames?.intercept(k) || !!party?.intercept(k);
// ---------- end Goblin's Dread ----------
if (peersView && gameTables) peersView.stoolFor = (id) => gameTables.seatOf(id);
if (online && peers && life && minigames) {
  life.othersAround = () => {
    if (minigames.seated) return [];
    const playing = new Set((online.link.latest?.tables ?? []).flatMap((t) => t.seats.map((s) => s.id)));
    const busy = (id: number, mode: string) =>
      playing.has(id) ? 'At a Table' : mode === 'ride' ? 'Riding' : mode === 'glide' ? 'In the Air' : mode === 'swim' ? 'Swimming' : null;
    return peers
      .list()
      .filter((p) => p.online && !p.bot)
      .map((p) => ({ id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, busy: busy(p.id, p.mode) }));
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
    return studio.shot(who === 'player' ? 'face' : 'body', {
      weapon: sim.player.weapon,
      team: sim.player.team,
      who: String(online?.welcome.character.id ?? ''),
    });
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
// Online the game server runs your island and keeps it (crates/server/src/play/mod.rs): your commands go
// to it, and what it says your island holds replaces this copy as it arrives. ?fresh starts it
// over. Automated tests run the island here instead, starting fresh every time unless they ask for
// the one kept in this browser (?world&test&load, which is how bug reports are replayed).
if (life && online) {
  // Starting over: the old island must be gone before this page shows one.
  if (opt.fresh) await online.link.reset();
  life.remote = (c) => online.link.command((prediction?.seq ?? 0) + 1, c);
  // ?lag=ms plays a local server as one far away would feel.
  online.link.lag = lagMs;
}
if (life && testMode && opt.load) {
  const saved = savedIsland();
  if (saved) engine.loadIsland(saved);
}
// The island's skill points hold your build to what you've earned, as the server does on joining:
// a build they can't cover falls back to Sword Training. Online the welcome already says what the
// server chose, except when ?fresh has just started the island, and its points, over.
if (life && (!online || opt.fresh) && !validBuild(build, skillBudget(life.state))) {
  build = defaultBuild();
  engine.setBuild(build);
}

/** Moves you somewhere (the dev panel and tests), off whatever you were riding. */
function teleport(x: number, z: number, facing = engine.player.facing): void {
  if (!terrain) return;
  // Somewhere else entirely: whatever was walking you there has nothing left to follow.
  walker?.stop();
  // Online only the server can move you.
  if (online) {
    online.link.command((prediction?.seq ?? 0) + 1, { t: 'teleport', x, z, facing } as unknown as Parameters<Life['command']>[0]);
    return;
  }
  // Inside a dungeon the floor is its own, far over the island's ground.
  engine.place(x, z, facing);
  follow.reset(follow.yaw);
}
if (lifeUI) {
  lifeUI.onTeleport = (x, z, facing) => teleport(x, z, facing);
  // Admins go into the developer zones from the Admin window (the server checks it's an admin).
  if (online?.welcome.dev) lifeUI.onEnterZone = (id) => online.link.zone(id);
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
  const want =
    p.mode === 'glide'
      ? RIDE_CAMERA.glideDistance
      : v && isBoat(rideable(v.def))
        ? RIDE_CAMERA.boatDistance * Math.max(1, rideable(v.def).length / 9)
        : RIDE_CAMERA.rideDistance;
  follow.distance += (want - follow.distance) * (1 - Math.exp(-2.5 * dt));
  const moving = Math.hypot(p.vel.x, p.vel.z) > 1.5;
  if (moving && now - lastCameraTouch > RIDE_CAMERA.autoDelay * 1000) {
    follow.yaw += angleDiff(follow.yaw, p.facing) * (1 - Math.exp(-RIDE_CAMERA.autoFollow * dt));
  }
}
input.onDeviceChange = (d) => hud.setDevice(d);
// The training yard keeps the experience of its skills in this browser; the open world keeps it
// with your island (src/sim/life/progress.ts).
const YARD_XP = 'ruina.skillxp';
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
if (!life) engine.setLevels(levelsFrom(yardXp));
/**
 * Points you may have in the tree: earned on the island, a training budget elsewhere, and the whole
 * tree in a developer zone, which is for trying weapons and skills (the server allows the same).
 */
const skillPoints = (): number => {
  const zone = visit?.inside ? dungeonDef(visit.inside) : undefined;
  if (zone?.developer) return NODES.length;
  return life ? skillBudget(life.state) : SKILL_POINTS;
};
const panel = new SkillsPanel(build, {
  budget: skillPoints,
  budgetNote: () => (life ? 'Earned from quests and milestones' : 'Training yard: points to try builds with'),
  xp: () => (life ? (life.state.skillXp ?? {}) : yardXp),
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
  // Creatures with files of their own name themselves (shared/creatures/).
  ...Object.fromEntries(actorKindIds().flatMap((id) => (kindName(id) ? [[id, kindName(id)!]] : []))),
};

// The server's monsters: drawn between its updates, at the moment other players are drawn
// (shownActors), and as it has them now (presentActors) for what has to be on time - warnings, and
// guessing whether your swing connects. NetMonsters gives online hits their sparks and flashes.
const netMonsters = net ? new NetMonsters(groundY) : null;
let shownActors: NetActor[] = [];
let presentActors: NetActor[] = [];
const shownById = new Map<number, NetActor>();
let lastSnapshot = 0;
let lastHp: number = COMBAT.maxHp;
/** The side your hero's colours show: only a developer zone's side changes it (on the island everyone is on one). */
let shownTeam = 0;
const scripted: Actions[] = []; // test hook: replaces the controller for a few frames

// A new build from the skill panel: save it, and use it (online, the server switches you over).
function applyBuild(b: Build): void {
  build = b;
  if (online) online.link.saveBuild(b);
  else saveBuild(b);
  if (netSpells) netSpells.stats = resolveSkills(b.skills);
  else engine.setBuild(b);
}
// Flinch and sparks for any hit on another player you can see. The number itself only comes from
// the server's attributed events, so other people's hits don't put damage numbers on your screen.
const showHurt = (x: number, y: number, z: number, damage: number, dirX: number, dirZ: number): void =>
  vfx.onEvent({ type: 'hit', frame: 0, index: damage >= 25 ? 2 : 0, damage, x, y, z, dirX, dirZ });
if (peers) peers.onHurt = showHurt;

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

// ---------- Aiming: the mark, the ground-aimed circle, aim assist, the combat stance (src/app/aiming.ts) ----------
const aiming = new Aiming({
  engine,
  follow,
  input,
  softLock: opt.softLock,
  names: NAMES,
  netActors: () => shownActors,
  peers: () => peers?.present() ?? [],
});
const lockOn = aiming.lockOn;

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
    // Sides are the battlefield's (and a developer zone's); on Emberholm everyone is on one.
    if (shownTeam !== net.you.player.team) {
      shownTeam = net.you.player.team;
      hero.setTeam(shownTeam);
    }
  }
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
  // At a mini-game's table you stay in your seat, as the server keeps you there: nothing you press
  // moves you, and nothing walks you off.
  if (minigames?.seated) {
    actions = NO_ACTIONS;
    walker?.stop();
  }
  let events: GameEvent[];
  if (prediction) {
    if (!net?.you) return; // wait until the server has placed us
    events = prediction.step(actions);
  } else {
    // Offline the rules decide, the yard's arrows, meteors and heals among them.
    events = engine.step(actions);
  }
  if (netSpells) {
    // Online: your own arrows, meteors and heals show straight away.
    const local = events.flatMap((e) => netSpells.local(e));
    events = events.concat(
      local,
      netSpells.step(STEP, sim.frame, (x, z, r) => aiming.enemyAt(x, z, r)),
    );
  }
  if (prediction && netMonsters) {
    // Online: your swing connecting with a monster sparks and shakes the moment it strikes.
    const p = sim.player;
    const attacking = p.mode === 'attack';
    const swing = attacking ? (comboFor(p.weapon, sim.stats)[p.attackIndex] ?? null) : null;
    const hits = netMonsters.swing(
      {
        attacking,
        attackIndex: p.attackIndex,
        attackFrame: p.attackFrame,
        step: swing,
        x: p.pos.x,
        y: p.pos.y,
        z: p.pos.z,
        facing: p.facing,
        above: swing ? heightAboveGround(sim) : 0,
        max: meleeTargets(p.weapon, sim.stats),
      },
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
    if (!sameLevels(lv, sim.levels)) engine.setLevels(lv);
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
    const myId = net.you?.id ?? null;
    netSpells.draw(spells, renderTick, net.lastTick + ahead, myId, sim.player.team);
    for (const e of netSpells.due(renderTick, sim.frame)) showEvent(e);
    for (const r of peers?.shownPlayers() ?? []) castCircle(r, r.pos.x, r.pos.z, r.team !== sim.player.team, null);
  }
  castCircle(sim.player, hero.root.position.x, hero.root.position.z, false, sim.stats);
  monsterWarnings();
  if (aiming.slot !== 0) {
    const y = sim.player.pos.y;
    spells.circle(sim.player.pos.x, sim.player.pos.z, aiming.reticle.range, 0, CIRCLE.range, 0.35, y);
    spells.circle(aiming.reticle.x, aiming.reticle.z, aiming.reticle.radius, 1, CIRCLE.aim, 0.95, y);
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
  if (openStage) {
    openStage.village.locate(p.x, p.y, p.z);
    follow.indoors = openStage.village.indoors !== null;
  }
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

/** A camera the tests park anywhere (window.__game.viewFrom), for views the follow camera can't reach. */
let pinnedView: { from: THREE.Vector3; to: THREE.Vector3 } | null = null;

/** Everyone else brought to the moment drawn, then drawn there. */
function framePeers(dt: number): void {
  peers?.frame(dt);
  peersView?.frame(dt, sim.frame, follow.camera.position);
}

function draw(alpha: number, cameraDt: number, animDt: number): void {
  // Weapon out in a fight, put away a little after one.
  hero.armed = aiming.inAFight();
  prediction?.ease(animDt);
  // Riding: the vehicle goes where it is this frame before you're posed in its seat, so you tilt
  // with it on a hill and your hands find its wheel or oars where they are now. Driving, yours is
  // put under you (and anyone riding along with you sits in it after); riding along with someone,
  // their vehicle is placed first, with everyone else.
  const along = sim.player.mode === 'ride' && !!sim.player.host;
  if (along) framePeers(animDt);
  // Mini-game tables near you; at one, you sit on its stool.
  if (gameTables && online) gameTables.update(online.link.latest?.tables ?? []);
  const stool = online ? (gameTables?.seatOf(online.welcome.character.id) ?? null) : null;
  sitIn(hero, stool ?? lifeView?.placeRide(sim.player, alpha, prediction?.offset ?? null, animDt) ?? (along ? (peersView?.seatFor(sim.player) ?? null) : null));
  hero.update(stool ? seatedState(sim.player) : sim.player, alpha, sim.frame);
  if (prediction && !hero.seat) hero.root.position.add(prediction.offset);
  const d = dummyActor();
  if (d) dummy.update(d);
  if (net) {
    const now = performance.now();
    refreshActors(now);
    actorView.fromNetwork(shownActors, (id) => netMonsters?.flash(id, now) ?? 0);
    // The dummy nearest you, where the server has it (the crowd draws what has a species; it has none).
    let near: NetActor | null = null;
    for (const a of shownActors)
      if (
        a.kind === DUMMY_KIND &&
        (!near || Math.hypot(a.x - sim.player.pos.x, a.z - sim.player.pos.z) < Math.hypot(near.x - sim.player.pos.x, near.z - sim.player.pos.z))
      )
        near = a;
    dummy.root.visible = !!near;
    if (near) {
      dummy.root.position.set(near.x, near.y + groundY(near.x, near.z), near.z);
      dummy.fromNetwork(netMonsters?.flash(near.id, now) ?? 0, near.deadFrame);
    }
  }
  // Townsfolk with their own models are drawn by the life view instead of the crowd.
  else actorView.update(lifeView?.drawsTownsfolk ? sim.actors.all().filter((a) => a.faction !== 2) : sim.actors.all());
  if (!net) missileView.update(sim.actors.missiles);
  if (lifeView && lifeUI) lifeView.talkingTo = lifeUI.talkingTo;
  drawSpells(alpha, animDt);
  if (!along) framePeers(animDt);
  if (life && lifeView) {
    lifeView.update(sim, animDt, follow.camera.position);
    lifeUI?.update(animDt);
    minigames?.update();
    party?.update();
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
  drawAbilityBar();
  // Health, MP and stamina: in the open world beside your portrait, elsewhere over the hotbar.
  const vitals = { hp: sim.player.hp, maxHp: COMBAT.maxHp, mp: sim.player.mp, maxMp: MP.max, stamina: sim.player.stamina, maxStamina: STAMINA.max };
  hud.setVitals(!lifeUI && (!net || (prediction && net.you)) ? vitals : null, null);
  lifeUI?.setVitals(vitals);
  const pos = hero.root.position;
  if (openStage) {
    // Which building you are in (it is drawn cut open, and holds the camera), its doors and lamps.
    openStage.village.locate(pos.x, pos.y, pos.z);
    openStage.village.update(animDt, peers ? [pos, ...peers.list()] : [pos], pos, follow.camera.position);
    follow.indoors = openStage.village.indoors !== null;
  }
  if (cameraDt > 0) follow.update(pos, cameraDt);
  if (pinnedView) {
    follow.camera.position.copy(pinnedView.from);
    follow.camera.lookAt(pinnedView.to);
    follow.camera.updateMatrixWorld();
  }
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

  const timing = perfs.gpuBegin();
  portraits.flush();
  if (openStage) openStage.render(follow.camera);
  else stage.renderer.render(stage.scene, follow.camera);
  if (timing) perfs.gpuEnd();
  bugs?.afterRender();
  const dAct = dummyActor();
  const markNow = lockOn.mark();
  dummyTop.set(dAct?.x ?? 0, 2.05 + groundY(dAct?.x ?? 0, dAct?.z ?? 0), dAct?.z ?? 0);
  hud.setTarget(
    markNow
      ? {
          pos: markPos.set(markNow.x, markNow.y + 2.15 + groundY(markNow.x, markNow.z), markNow.z),
          hp: markNow.hp,
          name: markNow.name,
          locked: lockOn.locked,
          cast: castOf(markNow.key),
        }
      : null,
  );
  // The dummy has its own health bar in the training yard; hide it when the target plate is
  // already showing the same thing, or they stack on top of each other.
  const plateOnDummy = !!markNow && markNow.name === NAMES.dummy;
  hud.layout(follow.camera, innerWidth, innerHeight, dummyTop, (dAct?.hp ?? 0) / DUMMY.hp, !serverRules && !plateOnDummy);
}

// ---------- Performance numbers (src/app/perf.ts) ----------

const perfs = new Perf(
  stage.renderer,
  () => vfx.particleCount,
  () => online?.link.stats ?? null,
);

// ---------- Main loop ----------

let paused = testMode;
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
  perfs.frame(dt * 1000);
  const cpuStart = performance.now();

  if (frozen) {
    dropInput();
  } else if (!paused) {
    // A window open on a controller has the pad: its stick and buttons drive the window, so you
    // stand still. With a keyboard and mouse you can walk with a window open (walking away from
    // whoever you're talking to closes it). The skill panel and the map take every device.
    const padToMenu = panel.isOpen || ((!!lifeUI?.takesPad || !!party?.takesPad) && input.lastDevice === 'gamepad');
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
      // A party invitation or the Party window takes the D-pad and A / B first (src/ui/party), then
      // an open life panel (dialog, shop, bag...).
      if (party?.menu(m)) continue;
      if (lifeUI?.menu(m)) continue;
      if (m === 'toggle') panel.open('book');
      else if (m === 'tree') panel.open('tree');
    }
    panel.tick();
    // Just closed (B, say): whatever closed it is still held, and mustn't count as a press in the
    // game once the menu is gone - B would slide. Reading the controls now uses those presses up,
    // even on a frame that runs no rules step to read them. A docked window that still has the
    // controller hasn't closed.
    if (menuOpen && !panel.isOpen && !lifeUI?.modal && !(lifeUI?.takesPad && input.lastDevice === 'gamepad')) input.pollActions(follow.yaw);
    const cam = input.pollCamera(dt);
    syncNet();
    const placing = !menuOpen && aiming.update(cam, dt);
    if (!menuOpen && !placing) {
      follow.rotate(cam.dYaw, cam.dPitch);
      follow.zoom(cam.dZoom);
      if (cam.dYaw !== 0 || cam.dPitch !== 0) lastCameraTouch = now;
    }
    if (life) rideCamera(dt, now);
    // Travelling by road on foot, the camera comes round behind you as it does on a mount, unless
    // you have been turning it yourself.
    if (
      walker?.mode === 'travel' &&
      sim.player.mode !== 'ride' &&
      now - lastCameraTouch > RIDE_CAMERA.autoDelay * 1000 &&
      Math.hypot(sim.player.vel.x, sim.player.vel.z) > 1.5
    ) {
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
      stepOnce(aiming.aim(a));
      acc -= STEP;
      steps++;
    }
    if (steps === 5) acc = 0; // don't spiral if the tab was in the background
    draw(acc / STEP, dt, dt);
    framesDrawn++;
  } else {
    draw(1, 0, 0);
    framesDrawn++;
  }
  perfs.cpuSpent(performance.now() - cpuStart);

  if (now - lastStats > 250) {
    lastStats = now;
    hud.setStats(perfs.line());
  }
}
requestAnimationFrame(frame);

// ---------- Hooks for automated tests ----------

/** What the test API (src/app/testApi.ts) reaches the game through: read when used, so it sees each as it is then. */
const refs = {
  get acc() {
    return acc;
  },
  set acc(v) {
    acc = v;
  },
  get aimingSlot() {
    return aiming.slot;
  },
  get applyBuild() {
    return applyBuild;
  },
  get autoAttack() {
    return aiming.autoAttack;
  },
  set autoAttack(v) {
    aiming.autoAttack = v;
  },
  get blob() {
    return blob;
  },
  get bugs() {
    return bugs;
  },
  get build() {
    return build;
  },
  get cycleTarget() {
    return (step: number) => aiming.cycleTarget(step);
  },
  get draw() {
    return draw;
  },
  get dummyActor() {
    return dummyActor;
  },
  /** Where the training dummy is drawn, or null while none is. */
  get dummyDrawn() {
    return dummy.root.visible ? { x: dummy.root.position.x, y: dummy.root.position.y, z: dummy.root.position.z } : null;
  },
  get groundY() {
    return groundY;
  },
  get follow() {
    return follow;
  },
  get followSim() {
    return followSim;
  },
  get frozen() {
    return frozen;
  },
  get gameTables() {
    return gameTables;
  },
  get hero() {
    return hero;
  },
  get hud() {
    return hud;
  },
  get input() {
    return input;
  },
  get last() {
    return last;
  },
  set last(v) {
    last = v;
  },
  get life() {
    return life;
  },
  get lifeUI() {
    return lifeUI;
  },
  get lifeView() {
    return lifeView;
  },
  get lockOn() {
    return lockOn;
  },
  get minigames() {
    return minigames;
  },
  get net() {
    return net;
  },
  get netMonsters() {
    return netMonsters;
  },
  get netSpells() {
    return netSpells;
  },
  get online() {
    return online;
  },
  get openStage() {
    return openStage;
  },
  get panel() {
    return panel;
  },
  get party() {
    return party;
  },
  get paused() {
    return paused;
  },
  set paused(v) {
    paused = v;
  },
  get peers() {
    return peers;
  },
  get peersView() {
    return peersView;
  },
  get perf() {
    return () => perfs.numbers();
  },
  get pinnedView() {
    return pinnedView;
  },
  set pinnedView(v) {
    pinnedView = v;
  },
  get portraitOf() {
    return portraitOf;
  },
  get prediction() {
    return prediction;
  },
  get range() {
    return range;
  },
  get reticle() {
    return aiming.reticle;
  },
  get scripted() {
    return scripted;
  },
  get shownActors() {
    return shownActors;
  },
  get engine() {
    return engine;
  },
  get islandCommand() {
    return islandCommand;
  },
  get sim() {
    return sim;
  },
  get skillPoints() {
    return skillPoints;
  },
  get skyHour() {
    return skyHour;
  },
  get spells() {
    return spells;
  },
  get stage() {
    return stage;
  },
  get stepOnce() {
    return stepOnce;
  },
  get studio() {
    return studio;
  },
  get teleport() {
    return teleport;
  },
  get terrain() {
    return terrain;
  },
  get vfx() {
    return vfx;
  },
  get visit() {
    return visit;
  },
  get walker() {
    return walker;
  },
  get world() {
    return world;
  },
  get yardXp() {
    return yardXp;
  },
  get api() {
    return api;
  },
  set bugs(v) {
    bugs = v;
  },
  get canvas() {
    return canvas;
  },
  get openWorld() {
    return openWorld;
  },
  get opt() {
    return opt;
  },
  get testMode() {
    return testMode;
  },
  get QUICK() {
    return QUICK;
  },
  get framesDrawn() {
    return framesDrawn;
  },
  set frozen(v) {
    frozen = v;
  },
  get onlineSpace() {
    return onlineSpace;
  },
};
export type GameRefs = typeof refs;
const api = makeTestApi(refs);

(window as unknown as { __game: typeof api }).__game = api;
// ---------- Bug reports ----------
// \ (or clicking both sticks) records one: see src/app/bugs/reporter.ts. The dev server saves it
// to bugs/, and /fix-bugs in Claude Code works through them. Off in automated tests unless asked for.

wireBugReports(refs);

// ---------- Dungeons, online ----------
// You're in a dungeon's copy, or back in the open world (crates/server/src/play/spaces.rs): the server moved you
// there, and this follows (src/app/dungeonVisit.ts): the dungeon solid around you and drawn only
// while you're in it, and getting up after a knockdown where it's entered.
function onlineSpace(s: SpaceView): void {
  if (s.kind === 'dungeon') {
    if (visit?.inside !== s.dungeon) visit?.enterDungeonHere(s.dungeon, true);
  } else visit?.leaveDungeonHere(true);
}

// ---------- The game server ----------
// Set up last, once everything it touches exists. The badge shows who you are and whether the
// server is there, with Characters (back to the character select screen) and Sign Out. While the
// server is away - being updated, or the connection dropped - the world freezes under a screen
// that says so, and carries on when it's back; play stops for good if another window takes this
// character or the sign-in ends.

wireOnline(refs);
