// One step of the rules (1/60 s) with what you pressed, and what it shows: the effects of what
// happened and what your life said, the server's word on you taken in (syncNet) before the step
// online. The loop calls it each step; tests step it a frame at a time.
import { NO_ACTIONS, type Actions, type GameEvent, heightAboveGround } from '../engine/rules';
import { MOVEMENT_SKILLS, comboFor, COMBAT, meleeTargets, STEP } from '../content/tuning';
import { dungeonDef } from '../engine/zone';
import type { GameRefs } from '../main';

export function makeStep(g: GameRefs) {
  const {
    aiming,
    drawing,
    engine,
    follow,
    groundY,
    hero,
    hud,
    input,
    life,
    lifeUI,
    minigames,
    net,
    netMonsters,
    netSpells,
    prediction,
    shownById,
    vfx,
    walker,
  } = g;
  let lastSnapshot = 0;
  let lastHp: number = COMBAT.maxHp;
  /** The side your hero's colours show: only a developer zone's side changes it (in the world everyone is on one). */
  let shownTeam = 0;

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
    netSpells?.receive();
  }

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
      // Offline the rules decide, your arrows, meteors and heals among them.
      events = engine.step(actions);
      // Where the space you're in doesn't stop the game for a landed blow (the world never does; a
      // copy whose practice rules have it does), the swing pauses on it in the drawing, as online.
      if (!(engine.inside && dungeonDef(engine.inside)?.practice?.hitPause)) {
        const p = g.sim.player;
        const landed = events.find((e) => e.type === 'hit' && e.weapon === p.weapon && p.mode === 'attack');
        const swing = landed?.type === 'hit' ? comboFor(p.weapon, g.sim.stats)[landed.index] : undefined;
        if (landed?.type === 'hit' && swing) hero.hitPause(swing.hitstop, landed.index);
      }
    }
    if (netSpells) {
      // Online: your own arrows, meteors and heals show straight away.
      const local = events.flatMap((e) => netSpells.local(e));
      events = events.concat(
        local,
        netSpells.step(STEP, g.sim.frame, (x, z, r) => aiming.enemyAt(x, z, r)),
      );
    }
    if (prediction && netMonsters) {
      // Online: your swing connecting with a monster sparks and shakes the moment it strikes.
      const p = g.sim.player;
      const attacking = p.mode === 'attack';
      const swing = attacking ? (comboFor(p.weapon, g.sim.stats)[p.attackIndex] ?? null) : null;
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
          above: swing ? heightAboveGround(g.sim) : 0,
          max: meleeTargets(p.weapon, g.sim.stats),
        },
        g.presentActors,
        shownById,
        g.sim.frame,
        performance.now(),
      );
      // The swing pauses on the hit as it does offline, in the drawing only.
      if (hits.length && swing) hero.hitPause(swing.hitstop, p.attackIndex);
      events = events.concat(hits);
    }
    for (const e of events) drawing.showEvent(e);
    const le = life.drainEvents();
    g.bugs?.step(g.sim.frame, actions, events, le);
    lifeUI?.onEvents(le);
    for (const e of le) {
      if (e.t === 'harvest') vfx.lifeEffect('harvest', e.x, e.y, e.z);
      else if (e.t === 'gather') vfx.lifeEffect(e.kind, e.x, e.y, e.z);
      else if (e.t === 'build') vfx.lifeEffect('build', e.x, groundY(e.x, e.z), e.z);
      else if (e.t === 'thunder') vfx.lifeEffect('thunder', e.x, e.y, e.z);
      else if (e.t === 'sold') vfx.lifeEffect('coins', g.sim.player.pos.x, g.sim.player.pos.y, g.sim.player.pos.z);
    }
    const p = g.sim.player;
    // Dust while sliding. Which action that is comes from its pose, not from a mode of its own.
    if (p.mode === 'action' && MOVEMENT_SKILLS[p.actionId]?.action.pose === 'slide' && g.sim.frame % 2 === 0) {
      vfx.slideDust(p.pos.x, p.pos.z, p.actionDirX, p.actionDirZ);
    }
    vfx.step(STEP);
    hud.step(STEP);
  }
  return {
    stepOnce,
    syncNet,
  };
}
