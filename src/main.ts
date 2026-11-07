import * as THREE from 'three';
import { defaultBuild, parseBuild, swapSlots, validBuild } from './content/build';
import { loadBuild, saveBuild } from './app/savedBuild';
import { crouchKeySlides, Input } from './input/input';
import { WorldFeed, type NetActor } from './net/worldFeed';
import { NetMonsters } from './net/netMonsters';
import { Prediction } from './net/netPlayer';
import { CAUSE_ABILITY, CAUSE_MONSTER, CAUSE_WEAPON, causeOf, NetSpells } from './net/netSpells';
import { FollowCamera } from './render/camera';
import { GRAPHICS } from './render/look';
import { Hero } from './render/character';
import { TrainingDummy } from './render/dummy';
import { ActorView } from './render/actors';
import { actorKindAt, actorKindIds, actorKindIndex, kindName } from './content/actors';
import { isAlive, behaviour, stateProgress } from './engine/creatures';
import { type Actions, angleDiff, resolveSkills } from './engine/rules';
import { dungeonDef, groundAt } from './engine/zone';
import { ridden, hourAt, hourOfDay, skillBudget, type Command } from './engine/life';
import { Aiming } from './app/aiming';
import { Hud } from './ui/hud';
import { SpellView } from './render/spells';
import { Vfx } from './render/vfx';
import { MissileView } from './render/missiles';
import { OpenStage } from './render/open/stage';
import { loadModels } from './render/open/models';
import { Engine } from './engine/engine';
import { LifeView } from './render/open/land';
import { LifeUI, type LifePress } from './ui/life/lifeUI';
import { clearLife, savedIsland } from './app/save';
import { goOnline } from './app/online';
import { readOptions } from './app/options';
import { makeTestApi } from './app/testApi';
import { startEngine, useContent } from './engine/load';
import { fixtureWorld } from './app/fixture';
import { type GrowerPort, RegionGrower } from './app/grower';
import { Regions } from './app/regions';
import { rigCamera } from './app/cameraRig';
import { makeStep } from './app/step';
import { startLoop } from './app/loop';
import { makeDrawing } from './app/drawing';
import { wireOnline } from './app/onlineWiring';
import { wireBugReports } from './app/bugWiring';
import { splash } from './ui/splash';
import { WorldPeers } from './net/worldPeers';
import { PeersView } from './render/open/peersView';
import { MinigamesUI } from './ui/minigames/minigames';
import { ChannelsUI } from './ui/channels/channelsUI';
import { PartyUI } from './ui/party/partyUI';
import { uiIcon } from './ui/theme/icons';
import { GameTables } from './render/open/gameTables';
import type { SpaceView } from './net/worldLink';
import { BugReporter } from './app/bugs/reporter';
import { installLogCapture } from './app/bugs/logs';
import { AutoWalk } from './input/autoWalk';
import { RIDE_CAMERA } from './content/traversal';
import { rideable, isBoat } from './content/vehicles';
import { ABILITY_ICONS, WEAPON_ICONS } from './ui/icons';
import type { MarkerKind } from './ui/hud';
import { NODES } from './content/skills';
import { SkillsPanel } from './ui/skills/panel';
import { type Build } from './content/tuning';
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

// The address's options (?test, ?offline, ?as=name and the rest) are listed in src/app/options.ts.
// Console output and errors are kept from here on, for bug reports.
installLogCapture();
const opt = readOptions();
// The engine's WebAssembly (the rules the server runs, src/engine/load.ts), fetched while the rest starts.
const engineLoading = startEngine();
const { test: testMode, lag: lagMs } = opt;

// The island's models load from the start (online, while you sign in and choose a character).
const modelsLoading = loadModels().then((m) => (splash?.step('models'), m));

// Emberholm is played on the game server: sign in and choose a character, and it hands over their
// island and build, and keeps them from then on. Automated tests (?test) and ?offline stay offline.
// Online, all of it happens on the title screen (src/ui/splash.ts), which shows the island being
// built and then fades into the game.
const online = !testMode && !opt.offline ? await goOnline(opt) : null;
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
// The rules, reached only through the engine (src/engine/): the world (or a copy of an instance, gone
// into below), you in it, and offline the creatures and your arrows and meteors. Online (Emberholm on
// the game server, and its instances) the server decides hits, so the rules here run without the
// creatures and only predict your own moves.
await engineLoading;
// Offline, a fixture world of the tests' in place of the shipped one (?fixture=world), given to the
// page's engine (and to its region grower below) before either reads anything.
const fixture = opt.fixture && !online ? await fixtureWorld(opt.fixture) : null;
if (fixture) useContent(fixture);
const engine = new Engine({ online: !!online, build });
// The world's regions grow in a worker as you travel (src/app/grower.ts, regions.ts): an engine of
// its own, given the same content.
// A world of one region (Emberholm alone, as shipped) has nothing to grow: no worker.
const grower =
  engine.layout && engine.layout.regions.length > 1 && typeof Worker === 'function'
    ? new RegionGrower(new Worker(new URL('./app/grower.worker.ts', import.meta.url), { type: 'module' }) as unknown as GrowerPort, fixture)
    : null;
const { world, sim, range } = engine;
/** The world's ground at the start. What's under a point is read from `engine.terrain` when it's needed, as in a copy of an instance it's that space's. */
const terrain = engine.terrain;

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
/** Ground height under a point: a copy's floor where you're in one, else the ground of the space you're in. */
const groundY = (x: number, z: number): number => engine.groundY(x, z);
if (splash) {
  splash.step('world');
  splash.say(splash.has('models') ? 'Planting the Forests…' : 'Loading Models…');
}
const models = await modelsLoading;
if (splash) {
  splash.say('Planting the Forests…');
  splash.toward('stage', 4);
  await splash.paint();
}
if (!engine.home || !engine.layout) throw new Error('the engine started with no world in it');
const openStage = new OpenStage(canvas, world, models, engine.home, engine.layout);
if (splash) {
  splash.step('stage');
  splash.say('Waking the Townsfolk…');
  splash.toward('ready', 5);
  await splash.paint();
}
const stage = openStage;
const hero = new Hero();
stage.scene.add(hero.root);
// The training dummy's body, drawn where a dummy is: the rules' own offline, the server's online.
const dummy = new TrainingDummy();
const actorView = new ActorView(actorKindIds(), 64, terrain ? groundY : null);
const dummyActor = () => sim.actorOfKind('dummy');
dummy.root.visible = false;
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
const drawnGround = (x: number, z: number, pad: number): number => {
  const ground = engine.terrain;
  return ground ? ground.height(x, z) + Math.max(lifeView?.raisedAt(x, z, pad) ?? 0, peersView?.raisedAt(x, z, pad) ?? 0) : 0;
};
// Warning circles lie on the island's hills and farms (and on a deck or roof under whoever they're
// about), floating on the sea rather than sinking under it.
if (terrain) {
  // Every region's grid is on one lattice (a whole number of cells to a chunk), the first region's.
  const grid = world.zone!.gen.terrain;
  spells.ground = {
    cell: grid.cell,
    origin: grid.minX,
    height: (x, z, near, pad) => {
      const ground = engine.terrain ?? terrain;
      return Math.max(ground.water, Number.isFinite(near) ? groundAt(ground, world.index, x, z, near, 0.5) : ground.height(x, z), drawnGround(x, z, pad));
    },
  };
}
const follow = new FollowCamera(innerWidth / innerHeight, GRAPHICS.viewDistance, 40);
// The camera is the scene's, so it moves with the scene's origin (src/render/origin.ts) as all else does.
stage.scene.add(follow.camera);
rigCamera(follow, engine, openStage);
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
  vfx.raised = (x, z, r) => drawnGround(x, z, r) - (engine.terrain ?? terrain).height(x, z);
}
const lifeView = life && models ? new LifeView(stage.scene, life, models, hero) : null;
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
      layout: engine.layout,
    })
  : null;
// The regions round you: grown ahead of you in the worker, adopted, drawn and mapped as they come,
// let go behind you.
const regions = grower ? new Regions({ engine, stage: openStage, pictures: lifeUI?.pictures ?? null, grower, frame: () => sim.frame }) : null;
// Online: everyone else in your channel of Emberholm, the plots they hold, and whether this server
// offers the developer panel.
const peers = online && life && world.zone ? new WorldPeers(world.zone, engine, life, online.welcome.character.id, online.link) : null;
// ...and drawn: a body and a name each, and what of their island everyone sees (src/render/open/peersView.ts).
const peersView = online && peers && models ? new PeersView(stage.scene, models, peers, online.welcome.character.id) : null;
if (peers && openStage) peers.onGroundChanged = () => openStage.foliage.invalidate();
if (peersView && openStage) peersView.onGroundChanged = () => openStage.foliage.invalidate();
if (peersView && openStage) peersView.houseSink = (owner, houses) => openStage.village.setHouses(owner, houses);
if (peersView) peersView.mineView = lifeView;
if (peers && life) engine.othersVehicles = () => peers.vehicles(sim.player);
if (online && life) {
  const me = online.welcome.character.name;
  engine.plotOwners = () => {
    const held: Record<string, string> = {};
    for (const [plot, holder] of Object.entries(online.link.claims)) if (holder && holder !== me) held[plot] = holder;
    return held;
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
// Online: channels (src/ui/channels): your region's channels, a way to another or to your party's,
// and a notice while yours closes. It docks where the Party window does: one closes the other.
const channels =
  online && lifeUI
    ? new ChannelsUI({
        link: online.link,
        regionName: (id) => (world.zone?.recipe.id === id ? world.zone.recipe.name : id),
        freeMouse: () => document.pointerLockElement && document.exitPointerLock(),
        onOpen: () => party?.close(),
      })
    : null;
if (party && channels) party.onOpen = () => channels.close();
if (channels && lifeUI) lifeUI.addMenuButton('channels', uiIcon('portal', 34), 'Channels', '');
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
// Offline, the address can start you in a copy of an instance (?test=yard, ?offline=goblinCamp),
// as if you had come through its door.
if (!online && opt.space) visit?.enterDungeonHere(opt.space, true);
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
// A key the island's windows would take goes first to a dungeon's portal, then a mini-game, then the
// party window, then the channels'.
if (lifeUI) lifeUI.intercept = (k) => portalPress(k) || !!minigames?.intercept(k) || !!party?.intercept(k) || !!channels?.intercept(k);
// ---------- end Goblin's Dread ----------
if (peersView && gameTables) peersView.stoolFor = (id) => gameTables.seatOf(id);
if (online && peers && life && minigames) {
  engine.othersAround = () => {
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
const skyHour = (): number => (online ? hourAt(life.zone.recipe.sky, online.link.serverNow() / 1000) : hourOfDay(life));
if (online && lifeUI) lifeUI.skyHour = skyHour;
// The rain and the wind run on the world's clock too (the server decides the rain; the wind you sail
// on is worked out here between its updates from the same clock).
if (online && life) engine.worldClock = () => online.link.serverNow() / 1000;
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
// Online the game server runs your island and keeps it (crates/server/src/sim/mod.rs): your commands go
// to it, and what it says your island holds replaces this copy as it arrives. ?fresh starts it
// over. Automated tests run the island here instead, starting fresh every time unless they ask for
// the one kept in this browser (?test&load, which is how bug reports are replayed).
if (life && online) {
  // Starting over: the old island must be gone before this page shows one.
  if (opt.fresh) await online.link.reset();
  engine.remote = (c) => online.link.command((prediction?.seq ?? 0) + 1, c);
  // ?lag=ms plays a local server as one far away would feel.
  online.link.lag = lagMs;
}
if (life && testMode && opt.load) {
  const saved = savedIsland();
  if (saved) engine.loadIsland(saved);
}

/** Moves you somewhere (the dev panel and tests), off whatever you were riding. */
function teleport(x: number, z: number, facing = engine.player.facing): void {
  if (!terrain) return;
  // Somewhere else entirely: whatever was walking you there has nothing left to follow.
  walker?.stop();
  // Online only the server can move you.
  if (online) {
    online.link.command((prediction?.seq ?? 0) + 1, { t: 'teleport', x, z, facing });
    return;
  }
  // Inside a dungeon its floors are all there is, over nothing.
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
/** Whether you're in a developer zone, which is for trying weapons and skills. */
const inDeveloperZone = (): boolean => !!(visit?.inside && dungeonDef(visit.inside)?.developer);
/**
 * Points you may have in the tree: earned on the island, and the whole tree in a developer zone (the
 * server allows the same).
 */
const skillPoints = (): number => {
  if (inDeveloperZone()) return NODES.length;
  return skillBudget(life.state);
};
// Your points hold your build to what you may spend where you are, as the server does on joining:
// a build they can't cover falls back to Sword Training. Online the welcome already says what the
// server chose, except when ?fresh has just started the island, and its points, over.
if ((!online || opt.fresh) && !validBuild(build, skillPoints())) {
  build = defaultBuild();
  engine.setBuild(build);
}
const panel = new SkillsPanel(build, {
  budget: skillPoints,
  budgetNote: () => (inDeveloperZone() ? 'A developer zone: the whole tree to try builds with' : 'Earned from quests and milestones'),
  xp: () => life.state.skillXp ?? {},
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

// What the target plate calls each kind: its name in its file (shared/actors.json, shared/creatures/).
const NAMES: Record<string, string> = Object.fromEntries(actorKindIds().flatMap((id) => (kindName(id) ? [[id, kindName(id)!]] : [])));

// The server's monsters: drawn between its updates, at the moment other players are drawn
// (shownActors), and as it has them now (presentActors) for what has to be on time - warnings, and
// guessing whether your swing connects. NetMonsters gives online hits their sparks and flashes.
const netMonsters = net ? new NetMonsters(groundY) : null;
let shownActors: NetActor[] = [];
let presentActors: NetActor[] = [];
const shownById = new Map<number, NetActor>();
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

// Which icon goes beside a floating number, from the cause the server packed into the event: the
// weapon's or the ability's own, or a monster's.
function causeIcon(cause: number): string {
  const { sort, index } = causeOf(cause);
  if (sort === CAUSE_WEAPON) return WEAPON_ICONS[index] ?? '';
  if (sort === CAUSE_ABILITY) return ABILITY_ICONS[index] ?? '';
  if (sort === CAUSE_MONSTER) return '\u{1f7e2}'; // a monster's slam
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
      for (const e of at.show) drawing.showEvent(e);
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
function resize(): void {
  stage.resize(innerWidth, innerHeight);
  follow.resize(innerWidth / innerHeight);
}
addEventListener('resize', resize);
resize();

// ---------- What the modules reach the game through ----------

/** What the test API (src/app/testApi.ts) reaches the game through: read when used, so it sees each as it is then. */
const refs = {
  get acc() {
    return loop.acc;
  },
  set acc(v) {
    loop.acc = v;
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
    return drawing.draw;
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
    return drawing.followSim;
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
    return loop.last;
  },
  set last(v) {
    loop.last = v;
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
  get channels() {
    return channels;
  },
  get paused() {
    return loop.paused;
  },
  set paused(v) {
    loop.paused = v;
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
    return drawing.pinnedView;
  },
  set pinnedView(v) {
    drawing.pinnedView = v;
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
    return step.stepOnce;
  },
  get studio() {
    return studio;
  },
  get teleport() {
    return teleport;
  },
  get terrain() {
    return engine.terrain;
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
  get api() {
    return api;
  },
  set bugs(v) {
    bugs = v;
  },
  get canvas() {
    return canvas;
  },
  get opt() {
    return opt;
  },
  get testMode() {
    return testMode;
  },
  get framesDrawn() {
    return loop.framesDrawn;
  },
  set frozen(v) {
    frozen = v;
  },
  get onlineSpace() {
    return onlineSpace;
  },
  get DUMMY_KIND() {
    return DUMMY_KIND;
  },
  get NAMES() {
    return NAMES;
  },
  get actorView() {
    return actorView;
  },
  get aiming() {
    return aiming;
  },
  get castOf() {
    return castOf;
  },
  get causeIcon() {
    return causeIcon;
  },
  get drawnGround() {
    return drawnGround;
  },
  get dummy() {
    return dummy;
  },
  get missileView() {
    return missileView;
  },
  get perfs() {
    return perfs;
  },
  get portraits() {
    return portraits;
  },
  get presentActors() {
    return presentActors;
  },
  set presentActors(v) {
    presentActors = v;
  },
  get serverRules() {
    return serverRules;
  },
  set shownActors(v) {
    shownActors = v;
  },
  get shownById() {
    return shownById;
  },
  get drawing() {
    return drawing;
  },
  get lastCameraTouch() {
    return lastCameraTouch;
  },
  set lastCameraTouch(v) {
    lastCameraTouch = v;
  },
  get rideCamera() {
    return rideCamera;
  },
  get syncNet() {
    return step.syncNet;
  },
  get regions() {
    return regions;
  },
};
export type GameRefs = typeof refs;

// ---------- Performance numbers (src/app/perf.ts) ----------

const perfs = new Perf(
  stage.renderer,
  () => vfx.particleCount,
  () => online?.link.stats ?? null,
);

// ---------- Drawing a frame (src/app/drawing.ts) ----------

const drawing = makeDrawing(refs);

// ---------- One step of the rules, and what it shows (src/app/step.ts) ----------

const step = makeStep(refs);

// ---------- Main loop ----------

const loop = startLoop(refs);

const api = makeTestApi(refs);

(window as unknown as { __game: typeof api }).__game = api;
// ---------- Bug reports ----------
// \ (or clicking both sticks) records one: see src/app/bugs/reporter.ts. The dev server saves it
// to bugs/, and /fix-bugs in Claude Code works through them. Off in automated tests unless asked for.

wireBugReports(refs);

// ---------- Dungeons, online ----------
// You're in a dungeon's copy, or back in the open world (crates/server/src/directory/mod.rs): the server moved you
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
