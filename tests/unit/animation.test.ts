import { describe, expect, test } from 'vitest';
import { comboShape } from '../../src/content/tuning';
import * as a from '../../src/library/bench/hero';

// The hero's animations, measured rather than eyeballed (src/library/bench/hero.ts): each of the
// films in src/render/detail/scenarios.ts played through the real close-up hero - poses, easing
// between states, feet held where they're planted - and where everything went reported. No drawing
// and no page: in Node the hero wears its box body (the made one needs a browser to load), the body
// these checks are written for. The content library plays the same films (#/hero/<film>) and offers
// these measurements on the body it wears there (window.__library.measure). What only the game
// can show, the hero and what it rides drawn together at any frame rate:
// tests/integration/animation.spec.ts.

describe('the hero films', () => {
  test('every film plays through with every joint somewhere real', () => {
    const joints = ['head', 'handL', 'handR', 'footL', 'footR', 'kneeL', 'elbowR', 'capeTail'];
    const bad: string[] = [];
    for (const s of a.list()) {
      for (const row of a.track(s.id, joints)) {
        for (const n of joints) if (!row.joints[n].every(Number.isFinite)) bad.push(`${s.id} frame ${row.frame}: ${n}`);
      }
    }
    expect(bad).toEqual([]);
  });

  // The point of the gait: a foot on the ground stays where it is on the ground. A heel or the ball of
  // a foot that touches down is followed until it lifts, and must not have moved over the floor.
  const PLANTED = [
    'walk',
    'jog',
    'run',
    'sprint',
    'sneak',
    'carry',
    'strafeL',
    'strafeR',
    'backpedal',
    'backL',
    'aheadL',
    'strafeWalk',
    'eight',
    'startStop',
    'turnOnSpot',
  ];

  test('planted feet stay put: walking, running, strafing, backing off, starting, stopping and turning', () => {
    const points = ['footL@0,-0.08,-0.085', 'footL@0,-0.08,0.17', 'footR@0,-0.08,-0.085', 'footR@0,-0.08,0.17'];
    const worst: Record<string, number> = {};
    for (const id of PLANTED) {
      const rows = a.track(id, points);
      let w = 0;
      for (const n of points) {
        let start = -1;
        for (let f = 30; f <= rows.length; f++) {
          const r = rows[f];
          const down = r && r.standing && r.joints[n][1] < 0.004;
          if (down && start < 0) start = f;
          if ((!down || f === rows.length) && start >= 0) {
            // Over the floor: turned by the way the hero faces, and carried as far as it has gone.
            const at = (k: number) => {
              const [x, , z] = rows[k].joints[n];
              const c = Math.cos(rows[k].facing);
              const s = Math.sin(rows[k].facing);
              return [x * c + z * s + rows[k].travelled[0], -x * s + z * c + rows[k].travelled[1]];
            };
            const p0 = at(start);
            for (let k = start + 1; k < f; k++) {
              const p = at(k);
              w = Math.max(w, Math.hypot(p[0] - p0[0], p[1] - p0[1]));
            }
            start = -1;
          }
        }
      }
      worst[id] = w;
    }
    for (const id of PLANTED) {
      // Moving steadily, a centimetre or so; changing direction, stopping and starting, turning, a few.
      const allowed = ['strafeWalk', 'startStop', 'eight', 'turnOnSpot'].includes(id) ? 0.06 : 0.015;
      expect(worst[id], `${id}: a planted foot slid ${worst[id].toFixed(3)} m`).toBeLessThan(allowed);
    }
  });

  test('nothing goes through the floor, and weapons only bite into it when they strike', () => {
    const onFoot = a
      .list()
      .filter((s) => s.group !== 'Travel')
      .map((s) => s.id);
    const low = Object.fromEntries(onFoot.map((id) => [id, a.lowest(id)]));
    for (const id of onFoot) {
      expect(low[id].body.low, `${id}: the body went ${low[id].body.low} m into the floor on frame ${low[id].body.frame}`).toBeGreaterThan(-0.03);
      expect(low[id].weapon.low, `${id}: the weapon went ${low[id].weapon.low} m into the floor`).toBeGreaterThan(-0.2);
    }
    // Held, not swung, a weapon stays clear of the ground.
    for (const id of ['idle', 'run', 'sprint', 'sneak', 'walk', 'strafeL', 'backpedal', 'block', 'carry']) {
      expect(low[id].weapon.low, `${id} drags its weapon`).toBeGreaterThan(0);
    }
  });

  test('knees and elbows only fold the way they can', () => {
    const list = a.list().map((s) => s.id);
    const hinges = Object.fromEntries(list.map((id) => [id, a.hinges(id)]));
    for (const id of list) {
      // Knees fold the shin back (+), elbows the forearm forward (-); never the other way.
      expect(hinges[id].knee[0], `${id}: a knee bent backwards`).toBeGreaterThan(-0.02);
      expect(hinges[id].elbow[1], `${id}: an elbow bent backwards`).toBeLessThan(0.02);
    }
    // And they do fold: running, the knees come right up behind; swinging, the elbows work.
    expect(hinges.run.knee[1]).toBeGreaterThan(1.8);
    expect(hinges.sword.elbow[0]).toBeLessThan(-1.2);
  });

  test('a weapon trail is drawn exactly where the blade went', () => {
    for (const id of ['sword', 'whirlwind', 'club', 'staff', 'airSlash']) {
      const g = a.trailGap(id);
      expect(g.shown, `${id} shows a trail`).toBeGreaterThan(3);
      expect(g.worst, `${id}: the trail's edge is ${g.worst} m off the blade`).toBeLessThan(0.01);
    }
  });

  test('jumping, the sword goes straight up overhead and chops down in front, and still does if you land halfway', () => {
    const step = comboShape(0, 0)[0];
    const pts = ['handR', 'handR@0,-1.1,0', 'head', 'shoulderR'];
    const seen = Object.fromEntries(['airSlash', 'airSlashLand'].map((id) => [id, a.track(id, pts)]));
    for (const [id, rows] of Object.entries(seen)) {
      const at = (f: number) => rows.find((r) => r.attack === f)!;
      // The jump attack, from its first frame to its last.
      expect(
        rows.filter((r) => r.attack >= 0).every((r) => r.airSwing),
        `${id} plays the jump attack throughout`,
      ).toBe(true);
      // Raised: the arm up past the shoulder, the blade standing straight up over the head.
      const up = at(step.startup);
      const hy = up.joints.handR[1];
      const [tx, ty, tz] = up.joints['handR@0,-1.1,0'];
      expect(hy - up.joints.shoulderR[1], `${id}: the hand is raised`).toBeGreaterThan(0.3);
      expect(ty - hy, `${id}: the blade points up`).toBeGreaterThan(1.0);
      expect(Math.hypot(tx - up.joints.head[0], tz - up.joints.head[2]), `${id}: the blade is over the head`).toBeLessThan(0.35);
      // Struck: chopped down in front, not swept across.
      const down = at(step.startup + step.active);
      const [dx, dy, dz] = down.joints['handR@0,-1.1,0'];
      const hand = down.joints.handR;
      expect(dz - hand[2], `${id}: the blade ends in front`).toBeGreaterThan(0.5);
      expect(hand[1] - dy, `${id}: the blade ends pointing down`).toBeGreaterThan(0.4);
      expect(Math.abs(dx - hand[0]), `${id}: the blade came straight down, not across`).toBeLessThan(0.3);
    }
    // In the second film the feet touch down while the blade is still coming down.
    const land = seen.airSlashLand;
    const landed = land.findIndex((r, i) => i > 0 && r.standing && !land[i - 1].standing);
    expect(land[landed]?.attack, 'lands mid-swing').toBeGreaterThan(0);
    expect(land[landed].attack).toBeLessThan(step.startup + step.active + step.recovery);
  });

  test('the bowstring comes back to the cheek with the drawing hand, and snaps straight on the shot', () => {
    const drawn = a.nockGap('bow', 39);
    const loosed = a.nockGap('bow', 41);
    expect(drawn.gap).toBeLessThan(0.02); // the nock is in the hand
    expect(drawn.drawn).toBeGreaterThan(0.55); // a long way back from the grip
    expect(loosed.draw).toBe(0);
    expect(loosed.drawn).toBeCloseTo(loosed.rest, 3); // straight again
  });

  test('gliding, both hands hold the control bar wherever the wing tilts it', () => {
    expect(a.glideGap()).toBeLessThan(0.1);
  });

  test('strafing, the legs run the way you go while the shoulders keep facing ahead', () => {
    const turn = (id: string, l: string, r: string) => {
      const rows = a.track(id, [l, r]).slice(60);
      const yaws = rows.map((row) => {
        const [lx, , lz] = row.joints[l];
        const [rx, , rz] = row.joints[r];
        // Facing is perpendicular to the line from the right joint to the left.
        return Math.atan2(-(lz - rz), lx - rx);
      });
      return yaws.reduce((s, y) => s + y, 0) / yaws.length;
    };
    expect(Math.abs(turn('strafeL', 'shoulderL', 'shoulderR'))).toBeLessThan(0.25); // looking ahead
    expect(turn('strafeL', 'legL', 'legR')).toBeGreaterThan(0.5); // hips turned toward the left
    expect(turn('strafeR', 'legL', 'legR')).toBeLessThan(-0.5); // and the right
    expect(Math.abs(turn('backpedal', 'legL', 'legR'))).toBeLessThan(0.25); // backing straight off, square on
  });

  test('dodges roll, and double jumps flip, whichever way they go', () => {
    // A quarter of the way round, the body lies flat, and its own up points the way it's tumbling.
    // (Not the head against the hips: curled into a ball, the head is ahead of the hips whichever
    // way the ball rolls.)
    const tumbles = (id: string, field: 'action' | 'flip') => {
      const out: number[] = [];
      let on = false;
      let found = false;
      for (const row of a.track(id, ['body', 'body@0,1,0'])) {
        if (row[field] < 0) {
          on = false;
          continue;
        }
        if (!on) [on, found] = [true, false];
        const [bx, by, bz] = row.joints.body;
        const [ux, uy, uz] = row.joints['body@0,1,0'];
        if (!found && uy - by < 0.05) {
          found = true;
          out.push(Math.atan2(ux - bx, uz - bz));
        }
      }
      return out;
    };
    const rolls = tumbles('dodge8', 'action');
    const flips = tumbles('flip8', 'flip');
    const near = (x: number, y: number) => Math.abs(Math.atan2(Math.sin(x - y), Math.cos(x - y)));
    // The tuck leans the ball forward a little, so a sideways tumble reads a few degrees ahead of square.
    const EIGHT = [0, 45, 90, 135, 180, -135, -90, -45].map((d) => (d * Math.PI) / 180);
    expect(rolls).toHaveLength(8);
    rolls.forEach((yaw, i) => expect(near(yaw, EIGHT[i]), `dodge ${i}`).toBeLessThan(0.35));
    const FOUR = [0, 90, 180, -90].map((d) => (d * Math.PI) / 180);
    expect(flips).toHaveLength(4);
    flips.forEach((yaw, i) => expect(near(yaw, FOUR[i]), `flip ${i}`).toBeLessThan(0.35));
  });

  test('turning on the spot, the feet step round one at a time instead of swivelling', () => {
    const pts: Record<string, string[]> = { L: ['footL@0,-0.08,-0.085', 'footL@0,-0.08,0.17'], R: ['footR@0,-0.08,-0.085', 'footR@0,-0.08,0.17'] };
    const rows = a.track('turnOnSpot', ['footL', 'footL@0,0,1', 'footR', 'footR@0,0,1', ...pts.L, ...pts.R]);
    // The film turns the hero over the floor, so its joints are turned back into the floor's frame.
    const world = (r: a.TrackRow, n: string) => {
      const [x, y, z] = r.joints[n];
      const c = Math.cos(r.facing);
      const s = Math.sin(r.facing);
      return [x * c + z * s + r.travelled[0], y, -x * s + z * c + r.travelled[1]];
    };
    const yaw = (r: a.TrackRow, s: string) => {
      const p = world(r, `foot${s}`);
      const q = world(r, `foot${s}@0,0,1`);
      return Math.atan2(q[0] - p[0], q[2] - p[2]);
    };
    const low = (r: a.TrackRow, s: string) => Math.min(...pts[s].map((n) => world(r, n)[1]));
    let swivel = 0;
    let both = 0;
    const steps: Record<string, number> = { L: 0, R: 0 };
    for (const s of ['L', 'R']) {
      let start = -1;
      let up = false;
      for (let f = 0; f <= rows.length; f++) {
        const r = rows[f];
        const down = !!r && low(r, s) < 0.004;
        if (r && low(r, s) > 0.04 && !up) [steps[s], up] = [steps[s] + 1, true];
        if (down) up = false;
        if (down && start < 0) start = f;
        if ((!down || f === rows.length) && start >= 0) {
          for (let k = start + 1; k < f; k++) {
            const d = yaw(rows[k], s) - yaw(rows[start], s);
            swivel = Math.max(swivel, Math.abs(Math.atan2(Math.sin(d), Math.cos(d))));
          }
          start = -1;
        }
      }
    }
    for (const r of rows) if (low(r, 'L') > 0.04 && low(r, 'R') > 0.04) both++;
    // A foot on the ground keeps pointing where it was put down (a few degrees as it rolls)...
    expect(swivel).toBeLessThan(0.15);
    // ...and the turn is taken in steps, never both feet off the ground at once.
    expect(both).toBe(0);
    expect(steps.L).toBeGreaterThanOrEqual(3);
    expect(steps.R).toBeGreaterThanOrEqual(3);
  });

  test('drawing and putting the weapon away: it changes hands without a jump, and never sweeps the ground', () => {
    const seen = [0, 1, 2, 3].map((w) => {
      const rows = a.weaponTrack('sheathe', w);
      const step = (i: number) => Math.hypot(...[0, 1, 2].map((k) => rows[i].tip[k] - rows[i - 1].tip[k]));
      let swaps = 0;
      let swap = 0;
      let lurch = 0;
      let low = Infinity;
      for (let i = 1; i < rows.length; i++) {
        if (rows[i].inHand !== rows[i - 1].inHand) [swaps, swap] = [swaps + 1, Math.max(swap, step(i))];
        if (i > 1) lurch = Math.max(lurch, step(i) - step(i - 1));
        low = Math.min(low, rows[i].tip[1]);
      }
      return { swaps, swap, lurch, low };
    });
    seen.forEach((s, w) => {
      // Put away once and drawn once, and the weapon is where it was at each change-over...
      expect(s.swaps, `weapon ${w}`).toBe(2);
      expect(s.swap, `weapon ${w} jumps as it changes over`).toBeLessThan(0.01);
      // ...speeding up and slowing down smoothly, never lurching from one frame to the next...
      expect(s.lurch, `weapon ${w} lurches`).toBeLessThan(0.3);
      // ...and swinging up over the top, not through the floor.
      expect(s.low, `weapon ${w} goes into the ground`).toBeGreaterThan(0);
    });
  });

  test('with the weapon put away the hands are free, and it hangs clear of the ground', () => {
    for (const id of ['idleAway', 'runAway'])
      for (const w of [0, 1, 2, 3]) {
        const rows = a.weaponTrack(id, w);
        expect(
          rows.some((r) => r.inHand),
          `${id}, weapon ${w}`,
        ).toBe(false);
        expect(Math.min(...rows.map((r) => r.tip[1])), `${id}: weapon ${w} drags on the ground`).toBeGreaterThan(0.05);
      }
  });

  test('travelling the weapon is out of sight, and with a pack on the back it only shows for a strike', () => {
    const travel = a
      .list()
      .filter((s) => s.group === 'Travel')
      .map((s) => s.id);
    for (const w of [0, 1, 2, 3]) {
      // Swimming, gliding, on a horse, at a wheel, at the oars, at the helm, a passenger: never drawn.
      for (const id of travel) {
        const shown = a.weaponTrack(id, w).filter((r) => r.shown).length;
        expect(shown, `${id}: weapon ${w} is drawn on ${shown} frames`).toBe(0);
      }
      // A pack on the back: not drawn walking about with it, drawn exactly while the strike lasts.
      for (const id of ['carry', 'carrySwing']) {
        const rows = a.weaponTrack(id, w);
        const shown = rows.filter((r) => r.shown).length;
        const wrong = rows.filter((r) => r.shown !== r.attack >= 0).length;
        if (id === 'carrySwing') expect(shown, `weapon ${w} comes out for the strike`).toBeGreaterThan(20);
        else expect(shown, `${id}: weapon ${w} is drawn on ${shown} frames`).toBe(0);
        expect(wrong, `${id}: weapon ${w} drawn outside the strike, or not during it`).toBe(0);
      }
    }
  });

  test('seated, the hands hold what the vehicle gives them and the feet find its footrest', () => {
    const gaps = Object.fromEntries(['drive', 'driveRoadster', 'driveHauler', 'row', 'rowTurns', 'helm', 'ride'].map((id) => [id, a.holdGap(id)]));
    // The cart's, the roadster's and the hauler's turning wheels, the oars mid-stroke and the ship's
    // wheel: within a few centimetres.
    for (const id of ['drive', 'driveRoadster', 'driveHauler', 'row', 'helm']) expect(gaps[id].hands, `${id}: a hand is off what it holds`).toBeLessThan(0.03);
    // The oars, rowing ahead, turning (the inside oar on a shorter stroke), backing water, turning on
    // the spot (one oar ahead, one backing), starting and stopping: the hands never leave the handles.
    for (const id of ['row', 'rowTurns']) expect(gaps[id].hands, `${id}: a hand is off its oar`).toBeLessThan(0.005);
    // On a horse the feet are in the stirrups; elsewhere they rest on the footrest or hang just above it.
    expect(gaps.ride.feet).toBeLessThan(0.03);
    for (const id of ['drive', 'driveRoadster', 'row', 'helm']) expect(gaps[id].feet, `${id}: the feet hang far off the floor`).toBeLessThan(0.15);
  });

  test('rowing, the two oars keep one stroke, so the hands do too, after any turn', () => {
    const rows = a.holdTrack('rowTurns');
    // The film's last stretch rows straight ahead again after turning, backing water and spinning on
    // the spot (then stops). Rowing straight, the handles are each other's mirror image: the same
    // point of the same stroke. Each oar kept its own stroke once, and every turn left them apart for
    // good, the hands working out of step from then on.
    const straight = rows.slice(-150, -90);
    let apart = 0;
    for (const {
      holds: [l, r],
    } of straight)
      apart = Math.max(apart, Math.hypot(l[0] + r[0], l[1] - r[1], l[2] - r[2]));
    expect(straight.length).toBe(60);
    expect(apart, `the oars are ${apart.toFixed(3)} m out of step`).toBeLessThan(0.01);
    // And they are rowing, not resting.
    const reach = straight.map(({ holds }) => holds[0][2]);
    expect(Math.max(...reach) - Math.min(...reach)).toBeGreaterThan(0.05);
  });

  test('a steering wheel faces its driver, square on its column', () => {
    // Its face looks back up the column at the driver (within 45 degrees of the way to them), not up
    // and away over the bonnet as a wheel tipped the wrong way does (about -0.1).
    for (const id of ['drive', 'driveRoadster', 'driveHauler']) expect(a.wheelFacing(id), `${id}: the wheel faces away from the driver`).toBeGreaterThan(0.7);
  });

  test('a hit throws the body the way the blow shoves it', () => {
    const rows = a.track('hit4', ['head', 'hips']);
    const rel = (r: a.TrackRow) => [r.joints.head[0] - r.joints.hips[0], r.joints.head[2] - r.joints.hips[2]];
    // Three frames after each blow lands, against how the body stood just before it.
    const thrown: Array<{ yaw: number; far: number }> = [];
    for (let i = 1; i + 3 < rows.length; i++) {
      if (rows[i].stun !== 0 || rows[i - 1].stun >= 0) continue;
      const [bx, bz] = rel(rows[i - 1]);
      const [px, pz] = rel(rows[i + 3]);
      thrown.push({ yaw: Math.atan2(px - bx, pz - bz), far: Math.hypot(px - bx, pz - bz) });
    }
    // The film is hit from the front, from behind, from the right and from the left: shoved back,
    // forward, to the left and to the right.
    const SHOVED = [180, 0, 90, -90].map((d) => (d * Math.PI) / 180);
    const near = (x: number, y: number) => Math.abs(Math.atan2(Math.sin(x - y), Math.cos(x - y)));
    expect(thrown).toHaveLength(4);
    thrown.forEach((t, i) => {
      expect(near(t.yaw, SHOVED[i]), `hit ${i} threw the head the wrong way`).toBeLessThan(0.45);
      expect(t.far, `hit ${i} hardly moved the body`).toBeGreaterThan(0.12);
    });
  });

  test('easing between states never snaps the body', () => {
    for (const id of ['startStop', 'carry', 'crouch', 'eight', 'strafeWalk', 'heal', 'meteor', 'bow', 'block']) {
      const j = a.jumps(id, ['head', 'body']);
      expect(j.worst, `${id}: the body jumped ${j.worst} m on frame ${j.frame}`).toBeLessThan(0.14);
    }
  });

  test('swimming, the stroke keeps a calm pace and never leaps, however long the session has run', () => {
    const pts = ['handL', 'handR', 'footL', 'footR', 'head'];
    // How long a stroke of each arm takes: frames between the left hand passing its midpoint forward.
    const stroke = (id: string) => {
      const z = a.track(id, ['handL']).map((r) => r.joints.handL[2]);
      const mid = (Math.min(...z) + Math.max(...z)) / 2;
      const ups = z.flatMap((v, i) => (i > 0 && z[i - 1] < mid && v >= mid ? [i] : []));
      return (ups[ups.length - 1] - ups[0]) / (ups.length - 1) / 60;
    };
    // Treading water, swimming off and stopping twenty minutes into a session, and riding a horse
    // whose pace keeps changing: nothing leaps from one frame to the next. The stroke used to be the
    // session's clock times a pace, so any change of pace (or of the speed another player's updates
    // report) threw it on by the whole session's worth of the difference.
    for (const id of ['swim', 'swimSprint', 'swimStart', 'tread', 'ride']) {
      const j = a.jumps(id, pts);
      const allowed = id === 'ride' || id === 'tread' ? 0.03 : 0.09;
      expect(j.worst, `${id}: the ${j.joint} leapt ${j.worst} m on frame ${j.frame}`).toBeLessThan(allowed);
    }
    // At the rules' swimming speed a stroke of each arm takes about a second and a half, sprinting a
    // little less: a calm crawl.
    const swim = stroke('swim');
    const sprint = stroke('swimSprint');
    expect(swim).toBeGreaterThan(1.3);
    expect(swim).toBeLessThan(2);
    expect(sprint).toBeGreaterThan(1.1);
    expect(sprint).toBeLessThan(swim);
  });
});
