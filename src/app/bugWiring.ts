// The bug reporter wired to the game (src/app/bugs/reporter.ts records a report: \ or clicking both
// sticks): what a report keeps of the game's state, sampled as it plays, and the hooks it calls.
// It reaches the game through `g`, the references src/main.ts hands it.
import { isAlive } from '../sim/actor';
import { stateName } from '../sim/ai/brain';
import { saveData } from './save';
import { BugReporter } from './bugs/reporter';
import { ridden } from '../sim/life/vehicles';
import { COMBAT } from '../content/tuning';
import type { GameRefs } from '../main';

export function wireBugReports(g: GameRefs): void {
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;

  /** Everything a bug report wants to know about the game at one moment. */
  function bugSnapshot(): Record<string, unknown> {
    const p = g.sim.player;
    const mark = g.lockOn.mark();
    const eye = g.follow.camera.position;
    return {
      mode: g.openWorld ? 'open world (Emberholm)' : 'training yard',
      frame: g.sim.frame,
      paused: g.paused,
      device: g.input.lastDevice,
      player: p,
      camera: { yaw: r3(g.follow.yaw), pitch: r3(g.follow.pitch), distance: r2(g.follow.distance), eye: [r2(eye.x), r2(eye.y), r2(eye.z)] },
      panels: { life: g.api.lifePanel(), skills: g.panel.isOpen ? g.panel.view : null, aimingSlot: g.aimingSlot },
      target: mark ? { name: mark.name, hp: mark.hp, x: r2(mark.x), z: r2(mark.z), locked: g.lockOn.locked } : null,
      riding: g.life && p.mode === 'ride' ? (ridden(g.life, g.sim) ?? null) : null,
      walk: g.walker ? { mode: g.walker.mode, marker: g.walker.marker, left: r2(g.walker.left) } : null,
      nearby: g.sim.actors
        .all()
        .map((a) => ({
          id: a.id,
          kind: a.kind,
          x: r2(a.x),
          y: r2(a.y),
          z: r2(a.z),
          hp: a.hp,
          alive: isAlive(a),
          state: stateName(a),
          dist: r2(Math.hypot(a.x - p.pos.x, a.z - p.pos.z)),
        }))
        .filter((a) => a.dist < 40)
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 24),
      life: g.life ? { ...g.life.state, focus: g.life.focus, placing: g.life.placing, resting: g.life.resting } : null,
      build: g.build,
      net: g.api.net(),
      perf: g.perf(),
    };
  }

  /** The player in a few numbers, ten times a second, for a report's timeline. */
  function bugSample(): Record<string, unknown> {
    const p = g.sim.player;
    const s: Record<string, unknown> = {
      f: g.sim.frame,
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
    if (g.life) {
      const v = p.mode === 'ride' ? ridden(g.life, g.sim) : undefined;
      if (v) s.ride = { id: v.id, def: v.def, x: r2(v.x), y: r2(v.y), z: r2(v.z), speed: r2(v.speed), heading: r3(v.heading) };
      if (g.life.focus) s.focus = `${g.life.focus.action}: ${g.life.focus.label}${g.life.focus.ok ? '' : ' (not now)'}`;
      if (g.life.placing) s.placing = true;
    }
    const lp = g.api.lifePanel();
    if (lp) s.panel = lp;
    else if (g.panel.isOpen) s.panel = g.panel.view === 'tree' ? 'skill tree' : 'skill book';
    return s;
  }

  if (g.opt.bugs) {
    g.bugs = new BugReporter({
      canvas: g.canvas,
      snapshot: bugSnapshot,
      save: () => (g.life ? saveData(g.life, g.sim) : null),
      sample: bugSample,
      device: () => g.input.lastDevice,
      test: g.testMode,
      speech: g.opt.bugSpeech,
      lang: g.opt.bugLang || navigator.language || 'en-US',
    });
    // Mouse readings thrown away as impossible, so a report can show whether one caused a camera jump.
    g.input.mouse.onDrop = (dx, dy, why) => g.bugs?.note('mouse', { type: why, dx, dy, raw: g.input.rawMouse });
    if (g.lifeUI) {
      g.lifeUI.onBugReport = () => g.bugs?.toggle();
      g.lifeUI.bugKey = () => g.bugs?.key ?? '\\';
    }
  }
}
