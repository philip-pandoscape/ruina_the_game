// Drawing a frame: the world as the rules have it at the moment shown (between two steps, by alpha),
// with the effects of what happened, spells' circles, monsters' warnings, the ability bar, the
// camera and everyone else. main.ts builds it once; the loop draws each frame with it.
import * as THREE from 'three';
import { pointsLeft } from '../content/build';
import { INTERP_TICKS, type NetActor } from '../net/worldFeed';
import { CAUSE_MONSTER } from '../net/netSpells';
import { actorKindAt, findKind } from '../content/actors';
import { isAlive, behaviour, stateProgress } from '../engine/creatures';
import { type GameEvent, type PlayerState } from '../engine/rules';
import { CIRCLE } from '../render/spells';
import { sitIn } from '../render/open/life';
import { seatedState } from '../render/open/gameTables';
import { rideable, isBoat } from '../content/vehicles';
import { ABILITY_ICONS, WEAPON_ICONS, WEAPON_NAMES } from '../ui/icons';
import { type ResolvedSkills } from '../content/skills';
import {
  ABILITIES,
  abilityMpFor,
  abilityRadius,
  MOVEMENT_SKILLS,
  castFramesFor,
  comboFor,
  COMBAT,
  DUMMY,
  movementCooldownFor,
  movementStaminaFor,
  MP,
  NO_ABILITY,
  STAMINA,
  STEP,
} from '../content/tuning';
import { groundAt } from '../engine/zone';
import type { GameRefs } from '../main';

export function makeDrawing(g: GameRefs) {
  const {
    DUMMY_KIND,
    NAMES,
    actorView,
    aiming,
    castOf,
    causeIcon,
    drawnGround,
    dummy,
    dummyActor,
    follow,
    gameTables,
    groundY,
    hero,
    hud,
    input,
    life,
    lifeUI,
    lifeView,
    lockOn,
    minigames,
    missileView,
    net,
    netMonsters,
    netSpells,
    online,
    openStage,
    party,
    peers,
    peersView,
    perfs,
    portraits,
    prediction,
    serverRules,
    shownById,
    skillPoints,
    skyHour,
    spells,
    stage,
    vfx,
    terrain,
    world,
  } = g;

  // What the player would land on right now (terrain, a deck, a roof), for the shadow blob.
  function groundUnder(x: number, z: number, y: number): number {
    return terrain ? groundAt(terrain, world.index, x, z, y, 0.05) : 0;
  }

  // Soft round shadow right under the player, so you can always see where you'll land.
  const blobMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false });
  const blob = new THREE.Mesh(new THREE.CircleGeometry(0.42, 24).rotateX(-Math.PI / 2), blobMat);
  blob.renderOrder = 1;
  stage.scene.add(blob);

  const simPos = new THREE.Vector3();
  const dummyTop = new THREE.Vector3();
  const markPos = new THREE.Vector3();
  function showEvent(e: GameEvent): void {
    vfx.onEvent(e);
    if (e.type === 'hit') {
      const big = e.index === 2;
      follow.shake(comboFor(g.sim.player.weapon, g.sim.stats)[e.index]?.shake ?? 0.3);
      input.rumble(big ? 0.9 : 0.45, big ? 1.0 : 0.6, big ? 160 : 90);
      // Online the server sends an attributed event for this instead, so it isn't drawn twice.
      if (!serverRules) hud.marker('hit', e.x, e.y, e.z, e.damage, WEAPON_ICONS[g.sim.player.weapon] ?? '');
    } else if (e.type === 'land' && e.impact > 0.6) {
      follow.shake(0.15);
    } else if (e.type === 'actorDie' && e.kind === 'dummy') {
      follow.shake(0.5);
    } else if (e.type === 'hurt') {
      // A monster got you. Online the server's own attributed event draws the number instead.
      hud.marker('hurt', e.x, e.y, e.z, e.damage, causeIcon(CAUSE_MONSTER));
      follow.shake(0.55);
      input.rumble(0.9, 0.8, 180);
    } else if (e.type === 'slam') {
      const d = Math.hypot(e.x - g.sim.player.pos.x, e.z - g.sim.player.pos.z);
      if (d < 10) follow.shake(0.3 * (1 - d / 10) * Math.min(2, e.radius));
    } else if (e.type === 'explosion') {
      const d = Math.hypot(e.x - g.sim.player.pos.x, e.z - g.sim.player.pos.z);
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
      for (const a of g.presentActors) {
        if (a.deadFrame >= 0) continue;
        const k = actorKindAt(a.kind);
        if (k && monsterWarning(k.id, a.state, a.progress, a.x, a.z, a.targetX, a.targetZ)) warned.add(a.id);
      }
      // ...and kept until the monster drawn on screen has done what it warned of (a slam stays
      // marked until the slime you see lands on it).
      for (const a of g.shownActors) {
        if (a.deadFrame >= 0 || warned.has(a.id)) continue;
        const k = actorKindAt(a.kind);
        if (k) monsterWarning(k.id, a.state, a.progress, a.x, a.z, a.targetX, a.targetZ);
      }
      return;
    }
    for (const a of g.sim.actors.all()) {
      if (isAlive(a) && !a.gone) monsterWarning(a.kind, a.state, stateProgress(a), a.x, a.z, a.targetX, a.targetZ);
    }
  }

  // Arrows, meteors and cast warnings, drawn every frame.
  function drawSpells(alpha: number, dt: number): void {
    spells.begin(dt, follow.yaw);
    if (g.range) {
      for (const a of g.range.arrows) {
        const back = a.speed * STEP * (1 - alpha); // blend between sim steps
        spells.arrow(a.x - a.dirX * back, a.y, a.z - a.dirZ * back, a.dirX, a.dirZ);
      }
      for (const m of g.range.meteors) spells.meteor(m.x, m.z, (m.frame + alpha) / m.fallFrames, m.radius, false);
    }
    if (net && netSpells) {
      const renderTick = net.renderTick(performance.now());
      const ahead = prediction && net.you ? (prediction.seq - net.you.ack) / (60 / net.ticksPerSecond) : 0;
      const myId = net.you?.id ?? null;
      netSpells.draw(spells, renderTick, net.lastTick + ahead, myId, g.sim.player.team);
      for (const e of netSpells.due(renderTick, g.sim.frame)) showEvent(e);
      for (const r of peers?.shownPlayers() ?? []) castCircle(r, r.pos.x, r.pos.z, r.team !== g.sim.player.team, null);
    }
    castCircle(g.sim.player, hero.root.position.x, hero.root.position.z, false, g.sim.stats);
    monsterWarnings();
    if (aiming.slot !== 0) {
      const y = g.sim.player.pos.y;
      spells.circle(g.sim.player.pos.x, g.sim.player.pos.z, aiming.reticle.range, 0, CIRCLE.range, 0.35, y);
      spells.circle(aiming.reticle.x, aiming.reticle.z, aiming.reticle.radius, 1, CIRCLE.aim, 0.95, y);
    }
    spells.end();
  }

  // The ability bar and cast bar.
  function drawAbilityBar(): void {
    const p = g.sim.player;
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
        castFrames: p.castAbility !== NO_ABILITY ? castFramesFor(slotAbility, g.sim.stats) : 1,
        stun: p.stun,
        downFrame: p.downFrame,
      },
      input.lastDevice,
      pointsLeft(g.build.skills, skillPoints()),
      {
        weapon: [WEAPON_ICONS[p.weapon] ?? '', WEAPON_NAMES[p.weapon] ?? ''],
        ability: (a) => (a === NO_ABILITY || !ABILITIES[a] ? null : [ABILITY_ICONS[a], ABILITIES[a].name]),
        cooldownFrames: (a) => ABILITIES[a]?.cooldownFrames ?? 1,
        mpCost: (a) => abilityMpFor(a, g.sim.stats),
        move: (m) => (MOVEMENT_SKILLS[m] ? [MOVEMENT_SKILLS[m].icon, MOVEMENT_SKILLS[m].name] : null),
        moveCooldownFrames: (m) => movementCooldownFor(m, g.sim.stats),
        staminaCost: (m) => movementStaminaFor(m, g.sim.stats),
      },
    );
  }

  function followSim(dt: number): void {
    const p = g.sim.player.pos;
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
    g.shownActors = net.actorTimeline.at(tick);
    g.presentActors = net.actorTimeline.at(tick + INTERP_TICKS);
    shownById.clear();
    for (const a of g.shownActors) shownById.set(a.id, a);
    if (!netMonsters) return;
    // Anyone's blow flashes what it hit at the moment that blow is drawn.
    const tickMs = 1000 / net.ticksPerSecond;
    netMonsters.hurts(net.actorTimeline, (t, at) => at + Math.max(0, t - net.renderTick(at)) * tickMs);
    for (const e of netMonsters.transitions(g.shownActors, g.sim.frame)) showEvent(e);
  }

  /** A camera the tests park anywhere (window.__game.viewFrom), for views the follow camera can't reach. */
  let pinnedView: { from: THREE.Vector3; to: THREE.Vector3 } | null = null;

  /** Everyone else brought to the moment drawn, then drawn there. */
  function framePeers(dt: number): void {
    peers?.frame(dt);
    peersView?.frame(dt, g.sim.frame, follow.camera.position);
  }

  function draw(alpha: number, cameraDt: number, animDt: number): void {
    // Weapon out in a fight, put away a little after one.
    hero.armed = aiming.inAFight();
    prediction?.ease(animDt);
    // Riding: the vehicle goes where it is this frame before you're posed in its seat, so you tilt
    // with it on a hill and your hands find its wheel or oars where they are now. Driving, yours is
    // put under you (and anyone riding along with you sits in it after); riding along with someone,
    // their vehicle is placed first, with everyone else.
    const along = g.sim.player.mode === 'ride' && !!g.sim.player.host;
    if (along) framePeers(animDt);
    // Mini-game tables near you; at one, you sit on its stool.
    if (gameTables && online) gameTables.update(online.link.latest?.tables ?? []);
    const stool = online ? (gameTables?.seatOf(online.welcome.character.id) ?? null) : null;
    sitIn(
      hero,
      stool ?? lifeView?.placeRide(g.sim.player, alpha, prediction?.offset ?? null, animDt) ?? (along ? (peersView?.seatFor(g.sim.player) ?? null) : null),
    );
    hero.update(stool ? seatedState(g.sim.player) : g.sim.player, alpha, g.sim.frame);
    if (prediction && !hero.seat) hero.root.position.add(prediction.offset);
    const d = dummyActor();
    if (d) dummy.update(d);
    if (net) {
      const now = performance.now();
      refreshActors(now);
      actorView.fromNetwork(g.shownActors, (id) => netMonsters?.flash(id, now) ?? 0);
      // The dummy nearest you, where the server has it (the crowd draws what has a species; it has none).
      let near: NetActor | null = null;
      for (const a of g.shownActors)
        if (
          a.kind === DUMMY_KIND &&
          (!near || Math.hypot(a.x - g.sim.player.pos.x, a.z - g.sim.player.pos.z) < Math.hypot(near.x - g.sim.player.pos.x, near.z - g.sim.player.pos.z))
        )
          near = a;
      dummy.root.visible = !!near;
      if (near) {
        dummy.root.position.set(near.x, near.y + groundY(near.x, near.z), near.z);
        dummy.fromNetwork(netMonsters?.flash(near.id, now) ?? 0, near.deadFrame);
      }
    }
    // Townsfolk with their own models are drawn by the life view instead of the crowd.
    else actorView.update(lifeView?.drawsTownsfolk ? g.sim.actors.all().filter((a) => a.faction !== 2) : g.sim.actors.all());
    if (!net) missileView.update(g.sim.actors.missiles);
    if (lifeView && lifeUI) lifeView.talkingTo = lifeUI.talkingTo;
    drawSpells(alpha, animDt);
    if (!along) framePeers(animDt);
    if (life && lifeView) {
      lifeView.update(g.sim, animDt, follow.camera.position);
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
    const vitals = { hp: g.sim.player.hp, maxHp: COMBAT.maxHp, mp: g.sim.player.mp, maxMp: MP.max, stamina: g.sim.player.stamina, maxStamina: STAMINA.max };
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
    blob.visible = g.sim.player.mode !== 'swim';
    blob.scale.setScalar(lift);
    blobMat.opacity = 0.22 * lift;

    const timing = perfs.gpuBegin();
    portraits.flush();
    if (openStage) openStage.render(follow.camera);
    else stage.renderer.render(stage.scene, follow.camera);
    if (timing) perfs.gpuEnd();
    g.bugs?.afterRender();
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
  return {
    /** The shadow under you. */
    blob,
    draw,
    followSim,
    get pinnedView() {
      return pinnedView;
    },
    set pinnedView(v) {
      pinnedView = v;
    },
    showEvent,
  };
}
