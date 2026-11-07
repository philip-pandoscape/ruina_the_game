// The game's test API, window.__game: what automated tests (tests/support/game.ts types it for
// them) read and drive: the rules' state, stepping frame by frame, commands, windows, the camera,
// online play. It reaches the game through `g`, the references src/main.ts hands it.
import * as THREE from 'three';
import { pointsLeft, swapSlots, validBuild } from '../content/build';
import { actorKindAt } from '../content/actors';
import { assetsReady } from '../render/assets';
import { fromScene, sceneOrigin } from '../render/origin';
import { isPine } from '../render/open/foliage';
import { type WeaponAt } from '../render/character';
import { isAlive, type Actor, stateName } from '../engine/creatures';
import { NO_ACTIONS, type Actions } from '../engine/rules';
import { IslandView } from '../engine/island';
import { arrivalOf, dungeonDef } from '../engine/zone';
import { LifeUI } from '../ui/life/lifeUI';
import { clearLife, saveLife } from './save';
import { BOOK } from '../content/skills';
import { STEP, type Build } from '../content/tuning';
import type { GameRefs } from '../main';

/** The test API on the game `g` refers to. */
export function makeTestApi(g: GameRefs) {
  return {
    ready: true,
    /** The textures and models that load after the page have all arrived (src/render/assets.ts). */
    get assetsReady(): boolean {
      return assetsReady();
    },
    // Steps the game with the same scripted actions every frame (auto-walk, when on, moves you), and
    // draws the last; `drawn` false leaves that to the caller (a long walk sampled as it goes needn't
    // draw every sample, which a browser drawing in software, as CI's does, takes a second over).
    advance(frames: number, actions: Partial<Actions> = {}, drawn = true): void {
      for (let i = 0; i < frames; i++) {
        const own = { ...NO_ACTIONS, ...actions };
        g.stepOnce(g.walker ? g.walker.steer(own, g.follow.yaw) : own);
        g.followSim(STEP);
      }
      if (drawn) g.draw(1, 0, 0);
    },
    // Steps the game reading the real keyboard, mouse and controller, and draws the last (`drawn`
    // false leaves that to the caller, as advance's does).
    advanceLive(frames: number, drawn = true): void {
      for (let i = 0; i < frames; i++) {
        const cam = g.input.pollCamera(STEP);
        g.follow.rotate(cam.dYaw, cam.dPitch);
        g.follow.zoom(cam.dZoom);
        const own = g.input.pollActions(g.follow.yaw);
        g.stepOnce(g.walker ? g.walker.steer(own, g.follow.yaw) : own);
        g.followSim(STEP);
      }
      if (drawn) g.draw(1, 0, 0);
    },
    /**
     * The world's regions round you (src/app/regions.ts): those the page holds (places in the world's
     * map) and their ids, the one on its way from the worker, every arrival and leaving so far, and how
     * many the rules grew on the spot because they were asked about ground the page hadn't handed over.
     */
    regionsNow(): {
      held: number[];
      ids: string[];
      pending: number | null;
      log: Array<{ t: string; place: number; id: string; frame: number; growMs?: number; allMs?: number; takeMs?: number }>;
      rules: number[];
      unheld: number;
      drawn: number[];
      building: number[];
    } {
      const r = g.regions;
      const rules = g.engine.layout ? g.engine.regionsHeld() : { held: [], unheld: 0 };
      const stage = g.openStage;
      return {
        held: r?.held ?? [],
        ids: (r?.held ?? []).map((p) => g.engine.layout?.regions[p]?.id ?? ''),
        pending: r?.pending ?? null,
        log: JSON.parse(JSON.stringify(r?.log ?? [])),
        rules: rules.held,
        unheld: rules.unheld,
        drawn: stage ? [...stage.regions.keys()] : [],
        building: stage ? [...stage.regions.entries()].filter(([, v]) => !v.built).map(([p]) => p) : [],
      };
    },
    /** Where you are and what you're doing, cheaply (sampled every frame by the tests that time frames). */
    where(): { x: number; y: number; z: number; mode: string } {
      const p = g.sim.player;
      return { x: p.pos.x, y: p.pos.y, z: p.pos.z, mode: p.mode };
    },
    /** The scene's origin (src/render/origin.ts) and the largest distance from it of anything drawn, the camera and the sun's shadow camera included: what the graphics card is handed. */
    sceneSpan(): { origin: [number, number]; camera: number; shadow: number; farthest: number; meshes: number } {
      const o = sceneOrigin();
      const v = new THREE.Vector3();
      const cam = g.follow.camera.getWorldPosition(v).length();
      const stage = g.openStage;
      const shadow = stage ? stage.sun.shadow.camera.getWorldPosition(v).length() : 0;
      let farthest = 0;
      let meshes = 0;
      g.stage.scene.traverse((m) => {
        if (!(m as THREE.Mesh).isMesh || !m.visible) return;
        meshes++;
        m.getWorldPosition(v);
        // Only what's drawn near you: far-off things are far off however they're handed over.
        if (Math.hypot(v.x, v.z) < 4000) farthest = Math.max(farthest, Math.hypot(v.x, v.z));
      });
      return { origin: [o[0], o[1]], camera: cam, shadow, farthest, meshes };
    },
    /** Holds the scene's origin at a point ([0, 0]: the world's own, as if there were no floating origin), or lets it move with the camera again (null); drawn at the next frame. */
    pinOrigin(at: [number, number] | null): void {
      g.openStage?.pinOrigin(at);
      g.draw(1, 0, 0);
    },
    /** Resolves once every region near (x, z) is held, grown in the worker as if you'd come from afar (a teleport's arrival). */
    regionsReady(x: number, z: number): Promise<void> {
      return g.regions ? g.regions.readyAt(x, z) : Promise.resolve();
    },
    /** Auto-run and travel by road: what is walking you, where to, and how far is left. */
    walk() {
      if (!g.walker) return null;
      const r = g.walker.route;
      return { mode: g.walker.mode, marker: g.walker.marker, left: g.walker.left, length: r?.length ?? 0, short: r?.short ?? 0, refusal: g.walker.refusal() };
    },
    /** Marks (x, z) and sets off along the roads to it, as a click on the map does. False when you can't from here. */
    travelTo(x: number, z: number, label = 'Marked Spot'): boolean {
      if (!g.walker) return false;
      g.walker.mark(x, z, label);
      return g.walker.travel();
    },
    render(): void {
      g.draw(1, 0, 0);
    },
    reset(opts: { x?: number; z?: number; facing?: number; camYaw?: number } = {}): void {
      // From where the copy you're in is entered, or the world's spawn.
      const inside = g.engine.inside ? dungeonDef(g.engine.inside) : undefined;
      const start = inside ? arrivalOf(inside) : g.world.spawn;
      const facing = opts.facing ?? start.facing;
      g.engine.reset({ x: opts.x ?? start.x, z: opts.z ?? start.z, facing }, g.build);
      g.vfx.reset();
      g.hud.clear();
      g.follow.reset(opts.camYaw ?? facing);
      g.followSim(STEP);
      g.draw(1, 0, 0);
    },
    state() {
      return JSON.parse(JSON.stringify({ frame: g.sim.frame, hitstop: g.sim.hitstop, player: g.sim.player, dummy: g.dummyActor() }));
    },
    events() {
      return g.sim.log.map((e) => ({ ...e }));
    },
    perf: g.perf,
    setPaused(p: boolean): void {
      g.paused = p;
      g.acc = 0;
      g.last = performance.now();
    },
    setCamera(c: { yaw?: number; pitch?: number; distance?: number }): void {
      if (c.yaw !== undefined) g.follow.yaw = c.yaw;
      if (c.pitch !== undefined) g.follow.pitch = c.pitch;
      if (c.distance !== undefined) {
        g.follow.distance = c.distance;
        g.follow.zoom(0);
      }
      g.followSim(STEP);
    },
    camera() {
      return { yaw: g.follow.yaw, pitch: g.follow.pitch, distance: g.follow.distance };
    },
    /** Parks the camera at `from` looking at `to` (null hands it back to the follow camera). */
    viewFrom(from: [number, number, number] | null, to: [number, number, number] = [0, 0, 0]): void {
      g.pinnedView = from ? { from: new THREE.Vector3(...from), to: new THREE.Vector3(...to) } : null;
      // The follow camera only moves when it steps, so step it back from wherever the view was.
      if (!g.pinnedView) g.followSim(STEP);
      g.draw(1, 0, 0);
    },
    // Where the eye actually is, which the targeting view lifts. follow.pitch is what you chose and
    // doesn't change while aiming, so it can't be used to see this.
    cameraHeight(): number {
      return g.follow.camera.position.y;
    },
    /**
     * Where the hero's weapon is drawn: 'hand' when held, 'away' when put away (at the hip, across the
     * back), 'hidden' when it isn't drawn at all (travelling, a pack on the back).
     */
    heroWeapon(): WeaponAt {
      return g.hero.weaponState;
    },
    /**
     * At the controls of a vehicle: where each hand is and where what it holds is (the oars' handles,
     * a wheel's rim), left then right, in the world as last drawn; null with nothing to hold.
     */
    holds() {
      const h = g.hero.seatHolds?.hands;
      if (!h) return null;
      const at = (o: THREE.Object3D) => fromScene(o.getWorldPosition(new THREE.Vector3())).toArray();
      return { hands: [at(g.hero.detail.joint('handL')), at(g.hero.detail.joint('handR'))], holds: h.map(at) };
    },
    // Targeting, the ground-aim circle, and the floating numbers currently on screen.
    combat() {
      return {
        target: (() => {
          const m = g.lockOn.mark();
          return m ? { key: m.key, name: m.name, hp: m.hp, x: m.x, z: m.z } : null;
        })(),
        locked: g.lockOn.locked,
        aiming: g.aimingSlot,
        reticle: g.aimingSlot !== 0 ? { x: g.reticle.x, z: g.reticle.z, range: g.reticle.range, radius: g.reticle.radius } : null,
        markers: g.hud.markerLog(),
      };
    },
    // Pretends Tab (1) or Shift-Tab (-1) was pressed.
    cycleTarget(step = 1): void {
      g.cycleTarget(step);
    },
    clearMarkers(): void {
      g.hud.clearMarkerLog();
    },
    // Testing: take a hit as if another fighter had landed it.
    takeHit(damage: number, dirX: number, dirZ: number, knock: number): void {
      g.engine.takeHit(damage, dirX, dirZ, knock);
    },
    // Testing: your stamina and MP as they would be part way through a fight (offline only).
    setVitals(v: { stamina?: number; mp?: number }): void {
      g.engine.setVitals(v);
      g.draw(1, 0, 0);
    },
    // The skill panel: whether it's open and whether it's waiting for a hotbar slot.
    panel() {
      return { ...g.panel.state(), abilities: [...g.build.abilities] };
    },
    /** Puts the skill book's cursor on a skill (by id) or a slot, or the tree's on a node. */
    panelFocus(where: { book?: string; slot?: number; move?: number; node?: string }): void {
      g.panel.setFocus(where);
    },
    openPanel(view: 'book' | 'tree' = 'book'): void {
      g.panel.open(view);
    },
    /** Plans the way to a tree node and learns it, as clicking it and Learn would. */
    learnNode(id: string): boolean {
      return g.panel.learnNode(id);
    },
    selectBook(id: string): void {
      g.panel.selectBook(id);
    },
    /** Skill points, levels and experience, as the book shows them. */
    skills() {
      return {
        budget: g.skillPoints(),
        left: pointsLeft(g.build.skills, g.skillPoints()),
        levels: Object.fromEntries(BOOK.map((b, i) => [b.id, g.sim.levels[i] ?? 1])),
        xp: { ...(g.life ? (g.life.state.skillXp ?? {}) : g.yardXp) },
      };
    },
    // What a drag between two hotbar slots ends up doing.
    swapSlots(a: number, b: number): void {
      g.applyBuild(swapSlots(g.build, a, b));
    },
    device() {
      return g.input.lastDevice;
    },
    // Online play: your fighter, how often the server corrected the prediction, and the players nearby.
    net() {
      if (!g.net) return null;
      const p = g.sim.player;
      return {
        connected: g.online?.link.open ?? false,
        joined: !!g.net.you,
        id: g.net.you?.id ?? null,
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
        seq: g.prediction?.seq ?? 0,
        ack: g.prediction?.lastAck ?? 0,
        pending: g.prediction?.pendingCount ?? 0,
        corrections: g.prediction?.corrections ?? 0,
        maxCorrection: g.prediction?.maxCorrection ?? 0,
        lastCorrection: g.prediction?.lastCorrection ?? 0,
        snapshots: g.net.snapshots,
        // The other players here (bots included).
        remotes: (g.peers?.present() ?? []).map((p) => ({ id: p.id, x: p.x, z: p.z, hp: p.hp, team: p.team, weapon: p.weapon })),
        scriptLeft: g.scripted.length,
        renderTick: g.net.renderTick(performance.now()),
        lastTick: g.net.lastTick,
        /** Online: how the game you are in is running and how its fights go (admins, once a second). */
        world: g.online?.link.stats ?? null,
      };
    },
    /** Counts the prediction's corrections afresh from here (after a teleport, which is one). */
    clearCorrections(): void {
      g.prediction?.clearCorrections();
    },
    // Feeds a list of [frames, actions] in place of the controller (live play, for tests).
    scriptInput(segments: Array<[number, Partial<Actions>]>): void {
      for (const [frames, a] of segments) for (let i = 0; i < frames; i++) g.scripted.push({ ...NO_ACTIONS, ...a });
    },
    autoAttack(on: boolean): void {
      g.autoAttack = on;
    },
    // Skills and loadout: the build you've chosen, and what your fighter is actually using.
    build() {
      const p = g.sim.player;
      return { chosen: { ...g.build }, using: { skills: [...p.skills], weapon: p.weapon, abilities: [...p.abilities], movement: [...p.movement] } };
    },
    setBuild(b: Build): boolean {
      // Only what your points allow: on the island, what its quests and milestones have earned.
      if (!validBuild(b, g.skillPoints())) return false;
      g.panel.setBuild(b);
      g.applyBuild(b);
      return true;
    },
    // Testing: send a build without checking it first, to see the server turn it down.
    sendRawBuild(b: Build): void {
      g.online?.link.saveBuild(b);
    },
    // Puts an actor of a kind somewhere specific, so a test does not have to wait for one to
    // wander over. `i` indexes the actors of that kind, in spawn order.
    placeActor(kind: string, i: number, x: number, z: number): void {
      g.engine.placeActor(kind, i, x, z);
    },
    // What the server says is in the world around you; empty when playing offline.
    netActors() {
      return g.net?.actors ?? [];
    },
    /** The server's monsters as drawn this frame (between its updates), with their kind's id and how white each one is. */
    shownActors() {
      const now = performance.now();
      return g.shownActors.map((a) => ({ ...a, kindId: actorKindAt(a.kind)?.id ?? '', flash: g.netMonsters?.flash(a.id, now) ?? 0 }));
    },
    /** Online hit effects so far: swings guessed to land, the server's confirmations (and how many matched a guess or came late), flashes, and slams and deaths shown. */
    netFx() {
      return g.netMonsters ? { ...g.netMonsters.counts } : null;
    },
    actors(kind?: string) {
      return g.sim.actors
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
          target: a.target,
          band: a.band,
          token: a.token,
          opening: a.opening,
          afraid: a.afraid,
          slotX: +a.slotX.toFixed(3),
          slotZ: +a.slotZ.toFixed(3),
          charges: a.charges,
          cds: [...a.cds],
          facing: +a.facing.toFixed(4),
        }));
    },
    // Testing: a war-band of `count` of a kind round (x, z), fighting together. Returns their ids.
    spawnBand(kind: string, count: number, x: number, z: number): number[] {
      return g.engine.spawnBand(kind, count, x, z);
    },
    // What creatures have thrown, still in the air.
    missiles() {
      return g.sim.actors.missiles.map((m) => ({ id: m.id, owner: m.owner, x: +m.x.toFixed(3), y: +m.y.toFixed(3), z: +m.z.toFixed(3), age: m.age }));
    },
    // Testing: a blow from you to one actor, by id, as if a weapon had landed it.
    hurtActor(id: number, amount: number): void {
      g.engine.hurtActor(id, amount);
    },
    // Testing: sets fields on an actor by id (a cooldown, a fuse), to set up a moment directly.
    setActor(id: number, fields: Partial<Actor>): void {
      g.engine.setActor(id, fields);
    },
    // Testing: puts a new actor of a kind in the world, as if a fight had made it (it won't respawn).
    spawnActor(kind: string, x: number, z: number): number {
      return g.engine.spawnActor(kind, x, z);
    },
    // Testing: monsters that never get angry, for tests about something else that hit them.
    calmMonsters(on = true): void {
      g.engine.calm(on);
    },
    skillPanel(open?: boolean): boolean {
      if (open === true && !g.panel.isOpen) g.panel.open('book');
      if (open === false && g.panel.isOpen) g.panel.close();
      return g.panel.isOpen;
    },
    /** Testing: the height of the highest ground circle drawn over (x, z), or null where there is none. */
    circleHeight(x: number, z: number): number | null {
      return g.spells.heightAt(x, z);
    },
    /** Testing: the height of your farm's soil or furrows drawn over (x, z), or null where there is none. */
    farmGround(x: number, z: number): number | null {
      return g.lifeView?.farmGroundAt(x, z) ?? null;
    },
    /** Testing: where the shadow under you is drawn. */
    shadowHeight(): number {
      return g.drawing.blob.position.y;
    },
    /** A portrait the UI shows (an image URL): 'player' (your face), 'body' (all of you) or an NPC's id; and how many of yours the studio has taken. */
    portrait(who: string) {
      return { url: g.portraitOf(who), taken: g.studio.taken };
    },
    spells() {
      return {
        arrowsDrawn: g.spells.arrowsDrawn,
        meteorsDrawn: g.spells.meteorsDrawn,
        circlesDrawn: g.spells.circlesDrawn,
        training: g.range ? { arrows: g.range.arrows.length, meteors: g.range.meteors.length } : null,
        online: g.netSpells?.counts ?? null,
      };
    },
    // ---- Open world ----
    /** Where your vehicles are drawn this frame. */
    drawnVehicles() {
      return g.lifeView?.drawnVehicles() ?? [];
    },
    /** The building you are in (src/render/village), and which storey: null outdoors. */
    indoors() {
      const i = g.openStage?.village.indoors;
      return i ? { id: i.building.id, x: i.building.x, z: i.building.z, storey: i.storey } : null;
    },
    /** What the village draws: its meshes, how many triangles each, and whether it is drawn now. */
    villageStats() {
      return g.openStage?.village.stats() ?? null;
    },
    /** The life systems' state, as plain data. */
    life() {
      if (!g.life) return null;
      return JSON.parse(JSON.stringify({ ...g.life.state, focus: g.life.focus, placing: g.life.placing, resting: g.life.resting }));
    },
    /** Where the quest you're on leads you (the ring on the maps, the marker on the compass). */
    questGoal() {
      return g.lifeUI?.goal() ?? null;
    },
    /** The hour of the day the sky shows, 0..24 (online the world's, from the server's clock). */
    dayHour(): number | null {
      return g.life ? g.skyHour() : null;
    },
    /** Queues a life command (it runs on the next sim step). */
    lifeCommand(c: Parameters<IslandView['command']>[0]): void {
      g.islandCommand(c);
    },
    /**
     * Online, an admin's bots: `n` more of `brain` (skirmisher, wanderer) round you on side `team`,
     * or with `n` 0 every bot here sent away (the server's; crates/server/src/sim/bots.rs).
     */
    sendBots(n: number, brain?: string, team?: number): boolean {
      return g.online?.link.command((g.prediction?.seq ?? 0) + 1, { t: 'bots', n, brain, team }) ?? false;
    },
    /** Jumps the player to (x, z) on the ground (`drawn` false leaves drawing it to the caller, as advance's does). */
    teleport(x: number, z: number, facing?: number, drawn = true): void {
      g.teleport(x, z, facing);
      g.followSim(STEP);
      if (drawn) g.draw(1, 0, 0);
    },
    /** Where things are on this island. */
    zone() {
      if (!g.world.zone) return null;
      const r = g.world.zone.recipe;
      return JSON.parse(
        JSON.stringify({
          places: r.places,
          npcs: r.npcs,
          outposts: r.outposts,
          workbenches: r.workbenches,
          housePlots: r.housePlots,
          updrafts: r.updrafts,
          nodes: r.nodes,
          spawn: r.spawn,
          ramps: g.world.zone.gen.ramps.map((pts) => [pts[0], pts[pts.length - 1]]),
        }),
      );
    },
    /** Dungeons: which one you're inside a copy of, whether each is solid in your world, its exit, and what F does now. */
    dungeon() {
      return {
        ...(g.visit?.state() ?? { inside: null, solid: {}, exit: null }),
        drawn: g.openStage?.dungeon ?? null,
        focus: g.life?.focus ? { action: g.life.focus.action, label: g.life.focus.label, ok: g.life.focus.ok } : null,
      };
    },
    /** Offline: straight into a copy of a dungeon (at its arrival point), or back out to its door (null). */
    visitDungeon(id: string | null): boolean {
      if (!g.visit || g.online) return false;
      return id ? g.visit.enterDungeonHere(id, true) : g.visit.leaveDungeonHere(true);
    },
    /** The waterfalls as the generator cut them. */
    falls() {
      return JSON.parse(JSON.stringify(g.world.zone?.gen.falls ?? []));
    },
    /** A carved mountain path as points from bottom to top (every few metres). */
    rampPath(i = 0): Array<[number, number]> {
      const r = g.world.zone?.gen.ramps[i] ?? [];
      return r.filter((_, k) => k % 3 === 0 || k === r.length - 1).map(([x, z]) => [x, z]);
    },
    /** The ground things are drawn on at (x, z): the island's, or the floor of the dungeon or zone you're in. */
    ground(x: number, z: number): number {
      return g.groundY(x, z);
    },
    /** Where the training dummy is drawn (the rules' offline, the server's online), or null while none is. */
    drawnDummy() {
      return g.dummyDrawn;
    },
    /** What the ground is made of under a point (SURFACE in src/engine/world/terrain.ts). */
    surface(x: number, z: number): number {
      return g.terrain ? g.terrain.surfaceAt(x, z) : 0;
    },
    /**
     * Scene objects whose name starts with `prefix`, with where they are (tests and debugging):
     * the origin, and the centre of what is drawn, which differ for models anchored at an edge.
     */
    /** Trees within r of (x, z), nearest first: where they stand and how big (the look test frames them). */
    treesNear(x: number, z: number, r = 40) {
      return g.world.obstacles
        .filter((o) => o.kind === 'tree' && Math.hypot(o.x - x, o.z - z) < r)
        .sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))
        .map((o) => ({
          x: +o.x.toFixed(2),
          z: +o.z.toFixed(2),
          scale: +o.scale.toFixed(2),
          pine: g.terrain ? isPine(o.x, o.z, g.terrain.height(o.x, o.z)) : false,
        }));
    },
    sceneObjects(prefix: string) {
      type Seen = { name: string; x: number; y: number; z: number; visible: boolean; centre: { x: number; y: number; z: number } };
      const out: Seen[] = [];
      const v = new THREE.Vector3();
      const c = new THREE.Vector3();
      const box = new THREE.Box3();
      const r = (n: number) => +n.toFixed(2);
      g.stage.scene.traverse((o) => {
        if (!o.name.startsWith(prefix)) return;
        fromScene(o.getWorldPosition(v));
        fromScene(box.setFromObject(o).getCenter(c));
        let shown = o.visible;
        for (let p = o.parent; p && shown; p = p.parent) shown = p.visible;
        out.push({ name: o.name, x: r(v.x), y: r(v.y), z: r(v.z), visible: shown, centre: { x: r(c.x), y: r(c.y), z: r(c.z) } });
      });
      return out;
    },
    /** Writes the island to this browser now (tests and bug-report replays). Online the server keeps it. */
    saveNow(): void {
      if (!g.online && g.life) saveLife(g.life, g.sim);
    },
    clearSave(): void {
      if (g.online) void g.online.link.reset();
      else clearLife();
    },
    /** Online: everyone else in your channel, as drawn, with how much of each one's name plate shows (0 hidden, 1 whole). */
    peers() {
      return (g.peers?.list() ?? []).map((p) => ({ ...p, plate: g.peersView?.plate(p.id) ?? 0 }));
    },
    /** Online play: who you are and the connection (null offline). */
    online() {
      return g.online
        ? {
            account: g.online.account.username,
            character: g.online.welcome.character,
            channel: g.online.welcome.channel,
            dev: g.online.welcome.dev,
            claims: g.online.link.claims,
            status: g.online.link.status,
            frozen: g.frozen,
            ticks: g.online.link.ticks,
            lifeLoaded: g.online.lifeLoaded?.() ?? false,
            lastSaved: g.online.link.lastSaved,
            ack: g.prediction?.lastAck ?? 0,
            seq: g.prediction?.seq ?? 0,
            corrections: g.prediction?.corrections ?? 0,
            maxCorrection: g.prediction?.maxCorrection ?? 0,
          }
        : null;
    },
    /** Which life panel is open, if any. */
    lifePanel(): string | null {
      return g.lifeUI?.openPanel ?? null;
    },
    closeLifePanel(): void {
      g.lifeUI?.closeAll();
    },
    pressLife(k: Parameters<LifeUI['press']>[0]): void {
      g.lifeUI?.press(k);
    },
    setLag(ms: number): void {
      if (g.online) g.online.link.lag = ms;
    },
    /** The bug reporter: what it is doing and the last report it saved (null when it is off). */
    bugs() {
      return g.bugs?.status() ?? null;
    },
    /** Same as pressing \ (toggle) or Backspace twice (discard). */
    bugReport(action: 'toggle' | 'discard' = 'toggle'): void {
      if (action === 'discard') g.bugs?.discard();
      else g.bugs?.toggle();
    },
    // ---- Mini-games (online) ----
    /** The mini-game windows, your challenges and your table's game as the server last sent them (null offline). */
    minigames() {
      return g.minigames ? JSON.parse(JSON.stringify(g.minigames.state())) : null;
    },
    /** Your party as the server sent it, the invitation waiting for you, and which of its windows show. */
    party() {
      return g.party ? JSON.parse(JSON.stringify(g.party.state())) : null;
    },
    /** Invites someone to your party by name (as the Party window does). */
    partyInvite(name: string): boolean {
      return g.online?.link.partyInvite({ name }) ?? false;
    },
    /** Answers the invitation waiting for you. */
    partyAnswer(accept: boolean): boolean {
      const inv = g.online?.link.invite;
      return !!inv && (g.online?.link.partyAnswer(inv.from, accept) ?? false);
    },
    partyLeave(): boolean {
      return g.online?.link.partyLeave() ?? false;
    },
    /** Your region's channels as the server last sent them, the last move between channels, and what the Channels window and notice show (null offline). */
    channels() {
      return g.channels ? JSON.parse(JSON.stringify(g.channels.state())) : null;
    },
    /** Asks to go to channel `to`, or to your party's (as the Channels window does). */
    changeChannel(to: number | 'party'): boolean {
      return g.online?.link.changeChannel(to) ?? false;
    },
    /** Where you play now: your channel, or a dungeon's copy (crates/server/src/directory/mod.rs). */
    space() {
      return g.online ? { ...g.online.link.space } : null;
    },
    /** Online: through a dungeon's portal (you must be at it), or back out of its copy (at its way out), as F does there. */
    throughPortal(enter: boolean, id = 'goblinsDread'): boolean {
      return g.online?.link.dungeon(id, enter) ?? false;
    },
    /** Online: into a developer zone (the yard, the battlefield), as the Admin menu takes an admin there. */
    /** Into a developer zone (admins only), on side `team` where sides are taken; asked again there, onto that side. */
    enterZone(id: string, team?: number): boolean {
      return g.online?.link.zone(id, team) ?? false;
    },
    /** The players here who are bots, by id and name (they come with a developer zone, or the developer panel). */
    bots(): Array<{ id: number; name: string; team: number; hp: number }> {
      return (g.peers?.list() ?? []).filter((p) => p.bot && p.online).map((p) => ({ id: p.id, name: p.name, team: p.team, hp: p.hp }));
    },
    /** The mini-game tables drawn near you: where, who sits at them, and how many beacons are lit. */
    gameTables() {
      return g.gameTables?.list() ?? [];
    },
    /** Challenges another player (by character), as the challenge window does; development servers deal `seed`'s game. */
    challenge(to: number, stake = 0, game = 'beacons', seed?: number): boolean {
      return g.online?.link.challenge(to, game, stake, seed) ?? false;
    },
    /** Tests: each turn of a game this browser challenges someone to lasts `seconds` (development servers). */
    setChallengeTurn(seconds: number | null): void {
      if (g.online) g.online.link.challengeTurn = seconds;
    },
    /** Answers the challenge waiting for you, as its window does. */
    answerChallenge(accept: boolean): boolean {
      const c = g.online?.link.challenges.waiting;
      return !!c && !!g.online && g.online.link.answer(c.from, accept);
    },
    /** A move at your table, in the game's own terms (Beacons: src/ui/minigames/beacons.ts). */
    tableMove(m: Record<string, unknown>): boolean {
      const t = g.online?.link.table;
      return !!t && !!g.online && g.online.link.move(t.id, m);
    },
  };
}

export type GameApi = ReturnType<typeof makeTestApi>;
