import { expect, test, type Page } from '@playwright/test';
import { comboShape } from '../../src/tuning';

// Its tests share nothing, so they spread across the workers (playwright.config.ts).
test.describe.configure({ mode: 'parallel' });

// The hero's animations, measured rather than eyeballed. The gallery (animations.html) plays each
// of the films in src/render/detail/scenarios.ts through the real close-up hero - poses, easing
// between states, feet held where they're planted - and reports where everything went. No GPU
// needed: it's all positions and angles. A few play the game itself (?world&test), at a set frame
// rate, to check what the gallery can't: the hero and what it rides, drawn together.

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/animations.html?anim=idle');
  await page.waitForFunction(() => (window as any).__anims?.ready === true);
  return errors;
}

const ids = (page: Page, group?: string) =>
  page.evaluate(
    (g) => ((window as any).__anims.list() as Array<{ id: string; group: string }>).filter((s) => !g || s.group === g).map((s) => s.id),
    group,
  );

test('every film plays through with every joint somewhere real', async ({ page }) => {
  const errors = await open(page);
  const bad = await page.evaluate(() => {
    const a = (window as any).__anims;
    const joints = ['head', 'handL', 'handR', 'footL', 'footR', 'kneeL', 'elbowR', 'capeTail'];
    const out: string[] = [];
    for (const s of a.list()) {
      for (const row of a.track(s.id, joints)) {
        for (const n of joints) if (!row.joints[n].every(Number.isFinite)) out.push(`${s.id} frame ${row.frame}: ${n}`);
      }
    }
    return out;
  });
  expect(bad).toEqual([]);
  expect(errors).toEqual([]);
});

// The point of the gait: a foot on the ground stays where it is on the ground. A heel or the ball of
// a foot that touches down is followed until it lifts, and must not have moved over the floor.
const PLANTED = ['walk', 'jog', 'run', 'sprint', 'sneak', 'carry', 'strafeL', 'strafeR', 'backpedal', 'backL', 'aheadL', 'strafeWalk', 'eight', 'startStop', 'turnOnSpot'];

test('planted feet stay put: walking, running, strafing, backing off, starting, stopping and turning', async ({ page }) => {
  await open(page);
  const worst = await page.evaluate((list) => {
    const a = (window as any).__anims;
    const points = ['footL@0,-0.08,-0.085', 'footL@0,-0.08,0.17', 'footR@0,-0.08,-0.085', 'footR@0,-0.08,0.17'];
    const out: Record<string, number> = {};
    for (const id of list) {
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
      out[id] = w;
    }
    return out;
  }, PLANTED);
  for (const id of PLANTED) {
    // Moving steadily, a centimetre or so; changing direction, stopping and starting, turning, a few.
    const allowed = ['strafeWalk', 'startStop', 'eight', 'turnOnSpot'].includes(id) ? 0.06 : 0.015;
    expect(worst[id], `${id}: a planted foot slid ${worst[id].toFixed(3)} m`).toBeLessThan(allowed);
  }
});

test('nothing goes through the floor, and weapons only bite into it when they strike', async ({ page }) => {
  await open(page);
  const list = (await page.evaluate(() => (window as any).__anims.list())) as Array<{ id: string; group: string }>;
  const onFoot = list.filter((s) => s.group !== 'Travel').map((s) => s.id);
  const low = await page.evaluate((l) => Object.fromEntries(l.map((id: string) => [id, (window as any).__anims.lowest(id)])), onFoot);
  for (const id of onFoot) {
    expect(low[id].body.low, `${id}: the body went ${low[id].body.low} m into the floor on frame ${low[id].body.frame}`).toBeGreaterThan(-0.03);
    expect(low[id].weapon.low, `${id}: the weapon went ${low[id].weapon.low} m into the floor`).toBeGreaterThan(-0.2);
  }
  // Held, not swung, a weapon stays clear of the ground.
  for (const id of ['idle', 'run', 'sprint', 'sneak', 'walk', 'strafeL', 'backpedal', 'block', 'carry']) {
    expect(low[id].weapon.low, `${id} drags its weapon`).toBeGreaterThan(0);
  }
});

test('knees and elbows only fold the way they can', async ({ page }) => {
  await open(page);
  const list = await ids(page);
  const hinges = await page.evaluate((l) => Object.fromEntries(l.map((id: string) => [id, (window as any).__anims.hinges(id)])), list);
  for (const id of list) {
    // Knees fold the shin back (+), elbows the forearm forward (-); never the other way.
    expect(hinges[id].knee[0], `${id}: a knee bent backwards`).toBeGreaterThan(-0.02);
    expect(hinges[id].elbow[1], `${id}: an elbow bent backwards`).toBeLessThan(0.02);
  }
  // And they do fold: running, the knees come right up behind; swinging, the elbows work.
  expect(hinges.run.knee[1]).toBeGreaterThan(1.8);
  expect(hinges.sword.elbow[0]).toBeLessThan(-1.2);
});

test('a weapon trail is drawn exactly where the blade went', async ({ page }) => {
  await open(page);
  const gaps = await page.evaluate(() => {
    const a = (window as any).__anims;
    return Object.fromEntries(['sword', 'whirlwind', 'club', 'staff', 'airSlash'].map((id) => [id, a.trailGap(id)]));
  });
  for (const [id, g] of Object.entries(gaps) as Array<[string, { worst: number; shown: number }]>) {
    expect(g.shown, `${id} shows a trail`).toBeGreaterThan(3);
    expect(g.worst, `${id}: the trail's edge is ${g.worst} m off the blade`).toBeLessThan(0.01);
  }
});

test('jumping, the sword goes straight up overhead and chops down in front, and still does if you land halfway', async ({ page }) => {
  await open(page);
  const step = comboShape(0, 0)[0];
  const seen = await page.evaluate(() => {
    const a = (window as any).__anims;
    const pts = ['handR', 'handR@0,-1.1,0', 'head', 'shoulderR'];
    return Object.fromEntries(['airSlash', 'airSlashLand'].map((id) => [id, a.track(id, pts)]));
  });
  type Row = { attack: number; airSwing: boolean; standing: boolean; lift: number; joints: Record<string, number[]> };
  for (const [id, rows] of Object.entries(seen) as Array<[string, Row[]]>) {
    const at = (f: number) => rows.find((r) => r.attack === f)!;
    // The jump attack, from its first frame to its last.
    expect(rows.filter((r) => r.attack >= 0).every((r) => r.airSwing), `${id} plays the jump attack throughout`).toBe(true);
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
  const land = seen.airSlashLand as Row[];
  const landed = land.findIndex((r, i) => i > 0 && r.standing && !land[i - 1].standing);
  expect(land[landed]?.attack, 'lands mid-swing').toBeGreaterThan(0);
  expect(land[landed].attack).toBeLessThan(step.startup + step.active + step.recovery);
});

test('the bowstring comes back to the cheek with the drawing hand, and snaps straight on the shot', async ({ page }) => {
  await open(page);
  const at = await page.evaluate(() => {
    const a = (window as any).__anims;
    return { drawn: a.nockGap('bow', 39), loosed: a.nockGap('bow', 41) };
  });
  expect(at.drawn.gap).toBeLessThan(0.02); // the nock is in the hand
  expect(at.drawn.drawn).toBeGreaterThan(0.55); // a long way back from the grip
  expect(at.loosed.draw).toBe(0);
  expect(at.loosed.drawn).toBeCloseTo(at.loosed.rest, 3); // straight again
});

test('gliding, both hands hold the control bar wherever the wing tilts it', async ({ page }) => {
  await open(page);
  const gap = await page.evaluate(() => (window as any).__anims.glideGap());
  expect(gap).toBeLessThan(0.1);
});

test('strafing, the legs run the way you go while the shoulders keep facing ahead', async ({ page }) => {
  await open(page);
  const seen = await page.evaluate(() => {
    const a = (window as any).__anims;
    const turn = (id: string, l: string, r: string) => {
      const rows = a.track(id, [l, r]).slice(60);
      const yaws = rows.map((row: any) => {
        const [lx, , lz] = row.joints[l];
        const [rx, , rz] = row.joints[r];
        // Facing is perpendicular to the line from the right joint to the left.
        return Math.atan2(-(lz - rz), lx - rx);
      });
      return yaws.reduce((s: number, y: number) => s + y, 0) / yaws.length;
    };
    return {
      leftShoulders: turn('strafeL', 'shoulderL', 'shoulderR'),
      leftHips: turn('strafeL', 'legL', 'legR'),
      rightHips: turn('strafeR', 'legL', 'legR'),
      backHips: turn('backpedal', 'legL', 'legR'),
    };
  });
  expect(Math.abs(seen.leftShoulders)).toBeLessThan(0.25); // looking ahead
  expect(seen.leftHips).toBeGreaterThan(0.5); // hips turned toward the left
  expect(seen.rightHips).toBeLessThan(-0.5); // and the right
  expect(Math.abs(seen.backHips)).toBeLessThan(0.25); // backing straight off, square on
});

test('dodges roll, and double jumps flip, whichever way they go', async ({ page }) => {
  await open(page);
  const tips = await page.evaluate(() => {
    const a = (window as any).__anims;
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
    return { rolls: tumbles('dodge8', 'action'), flips: tumbles('flip8', 'flip') };
  });
  const near = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  // The tuck leans the ball forward a little, so a sideways tumble reads a few degrees ahead of square.
  const EIGHT = [0, 45, 90, 135, 180, -135, -90, -45].map((d) => (d * Math.PI) / 180);
  expect(tips.rolls).toHaveLength(8);
  tips.rolls.forEach((yaw: number, i: number) => expect(near(yaw, EIGHT[i]), `dodge ${i}`).toBeLessThan(0.35));
  const FOUR = [0, 90, 180, -90].map((d) => (d * Math.PI) / 180);
  expect(tips.flips).toHaveLength(4);
  tips.flips.forEach((yaw: number, i: number) => expect(near(yaw, FOUR[i]), `flip ${i}`).toBeLessThan(0.35));
});

test('turning on the spot, the feet step round one at a time instead of swivelling', async ({ page }) => {
  await open(page);
  const seen = await page.evaluate(() => {
    const a = (window as any).__anims;
    const pts: Record<string, string[]> = { L: ['footL@0,-0.08,-0.085', 'footL@0,-0.08,0.17'], R: ['footR@0,-0.08,-0.085', 'footR@0,-0.08,0.17'] };
    const rows = a.track('turnOnSpot', ['footL', 'footL@0,0,1', 'footR', 'footR@0,0,1', ...pts.L, ...pts.R]);
    // The film turns the hero over the floor, so its joints are turned back into the floor's frame.
    const world = (r: any, n: string) => {
      const [x, y, z] = r.joints[n];
      const c = Math.cos(r.facing);
      const s = Math.sin(r.facing);
      return [x * c + z * s + r.travelled[0], y, -x * s + z * c + r.travelled[1]];
    };
    const yaw = (r: any, s: string) => {
      const p = world(r, `foot${s}`);
      const q = world(r, `foot${s}@0,0,1`);
      return Math.atan2(q[0] - p[0], q[2] - p[2]);
    };
    const low = (r: any, s: string) => Math.min(...pts[s].map((n) => world(r, n)[1]));
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
    return { swivel, both, steps };
  });
  // A foot on the ground keeps pointing where it was put down (a few degrees as it rolls)...
  expect(seen.swivel).toBeLessThan(0.15);
  // ...and the turn is taken in steps, never both feet off the ground at once.
  expect(seen.both).toBe(0);
  expect(seen.steps.L).toBeGreaterThanOrEqual(3);
  expect(seen.steps.R).toBeGreaterThanOrEqual(3);
});

test('drawing and putting the weapon away: it changes hands without a jump, and never sweeps the ground', async ({ page }) => {
  await open(page);
  const seen = await page.evaluate(() => {
    const a = (window as any).__anims;
    return [0, 1, 2, 3].map((w) => {
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

test('with the weapon put away the hands are free, and it hangs clear of the ground', async ({ page }) => {
  await open(page);
  const seen = await page.evaluate(() => {
    const a = (window as any).__anims;
    return ['idleAway', 'runAway'].flatMap((id) =>
      [0, 1, 2, 3].map((w) => {
        const rows = a.weaponTrack(id, w);
        return { id, w, held: rows.some((r: any) => r.inHand), low: Math.min(...rows.map((r: any) => r.tip[1])) };
      }),
    );
  });
  for (const s of seen) {
    expect(s.held, `${s.id}, weapon ${s.w}`).toBe(false);
    expect(s.low, `${s.id}: weapon ${s.w} drags on the ground`).toBeGreaterThan(0.05);
  }
});

test('travelling the weapon is out of sight, and with a pack on the back it only shows for a strike', async ({ page }) => {
  await open(page);
  const seen = await page.evaluate(() => {
    const a = (window as any).__anims;
    const travel = (a.list() as Array<{ id: string; group: string }>).filter((s) => s.group === 'Travel').map((s) => s.id);
    return [0, 1, 2, 3].flatMap((w) => [
      // Swimming, gliding, on a horse, at a wheel, at the oars, at the helm, a passenger: never drawn.
      ...travel.map((id: string) => ({ id, w, shown: a.weaponTrack(id, w).filter((r: any) => r.shown).length, wrong: 0 })),
      // A pack on the back: not drawn walking about with it, drawn exactly while the strike lasts.
      ...['carry', 'carrySwing'].map((id) => {
        const rows = a.weaponTrack(id, w);
        return { id, w, shown: rows.filter((r: any) => r.shown).length, wrong: rows.filter((r: any) => r.shown !== r.attack >= 0).length };
      }),
    ]);
  });
  for (const s of seen) {
    if (s.id === 'carrySwing') expect(s.shown, `weapon ${s.w} comes out for the strike`).toBeGreaterThan(20);
    else expect(s.shown, `${s.id}: weapon ${s.w} is drawn on ${s.shown} frames`).toBe(0);
    expect(s.wrong, `${s.id}: weapon ${s.w} drawn outside the strike, or not during it`).toBe(0);
  }
});

test('seated, the hands hold what the vehicle gives them and the feet find its footrest', async ({ page }) => {
  await open(page);
  const gaps = await page.evaluate(() => {
    const a = (window as any).__anims;
    return Object.fromEntries(['drive', 'driveRoadster', 'driveHauler', 'row', 'rowTurns', 'helm', 'ride'].map((id) => [id, a.holdGap(id)]));
  });
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

test('rowing, the two oars keep one stroke, so the hands do too, after any turn', async ({ page }) => {
  await open(page);
  const rows = await page.evaluate(() => (window as any).__anims.holdTrack('rowTurns'));
  // The film's last stretch rows straight ahead again after turning, backing water and spinning on
  // the spot (then stops). Rowing straight, the handles are each other's mirror image: the same
  // point of the same stroke. Each oar kept its own stroke once, and every turn left them apart for
  // good, the hands working out of step from then on.
  const straight = rows.slice(-150, -90) as Array<{ holds: number[][] }>;
  let apart = 0;
  for (const { holds: [l, r] } of straight) apart = Math.max(apart, Math.hypot(l[0] + r[0], l[1] - r[1], l[2] - r[2]));
  expect(straight.length).toBe(60);
  expect(apart, `the oars are ${apart.toFixed(3)} m out of step`).toBeLessThan(0.01);
  // And they are rowing, not resting.
  const reach = straight.map(({ holds }) => holds[0][2]);
  expect(Math.max(...reach) - Math.min(...reach)).toBeGreaterThan(0.05);
});

test('a steering wheel faces its driver, square on its column', async ({ page }) => {
  await open(page);
  const facing = await page.evaluate(() => {
    const a = (window as any).__anims;
    return Object.fromEntries(['drive', 'driveRoadster', 'driveHauler'].map((id) => [id, a.wheelFacing(id)]));
  });
  // Its face looks back up the column at the driver (within 45 degrees of the way to them), not up
  // and away over the bonnet as a wheel tipped the wrong way does (about -0.1).
  for (const [id, cos] of Object.entries(facing)) expect(cos, `${id}: the wheel faces away from the driver`).toBeGreaterThan(0.7);
});

test('a hit throws the body the way the blow shoves it', async ({ page }) => {
  await open(page);
  const thrown = await page.evaluate(() => {
    const a = (window as any).__anims;
    const rows = a.track('hit4', ['head', 'hips']);
    const rel = (r: any) => [r.joints.head[0] - r.joints.hips[0], r.joints.head[2] - r.joints.hips[2]];
    // Three frames after each blow lands, against how the body stood just before it.
    const out: Array<{ yaw: number; far: number }> = [];
    for (let i = 1; i + 3 < rows.length; i++) {
      if (rows[i].stun !== 0 || rows[i - 1].stun >= 0) continue;
      const [bx, bz] = rel(rows[i - 1]);
      const [px, pz] = rel(rows[i + 3]);
      out.push({ yaw: Math.atan2(px - bx, pz - bz), far: Math.hypot(px - bx, pz - bz) });
    }
    return out;
  });
  // The film is hit from the front, from behind, from the right and from the left: shoved back,
  // forward, to the left and to the right.
  const SHOVED = [180, 0, 90, -90].map((d) => (d * Math.PI) / 180);
  const near = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  expect(thrown).toHaveLength(4);
  thrown.forEach((t, i) => {
    expect(near(t.yaw, SHOVED[i]), `hit ${i} threw the head the wrong way`).toBeLessThan(0.45);
    expect(t.far, `hit ${i} hardly moved the body`).toBeGreaterThan(0.12);
  });
});

test('easing between states never snaps the body', async ({ page }) => {
  await open(page);
  const jumps = await page.evaluate(() => {
    const a = (window as any).__anims;
    return Object.fromEntries(['startStop', 'carry', 'crouch', 'eight', 'strafeWalk', 'heal', 'meteor', 'bow', 'block'].map((id) => [id, a.jumps(id, ['head', 'body'])]));
  });
  for (const [id, j] of Object.entries(jumps) as Array<[string, { worst: number; frame: number }]>) {
    expect(j.worst, `${id}: the body jumped ${j.worst} m on frame ${j.frame}`).toBeLessThan(0.14);
  }
});

test('swimming, the stroke keeps a calm pace and never leaps, however long the session has run', async ({ page }) => {
  await open(page);
  const seen = await page.evaluate(() => {
    const a = (window as any).__anims;
    const pts = ['handL', 'handR', 'footL', 'footR', 'head'];
    const jumps = Object.fromEntries(['swim', 'swimSprint', 'swimStart', 'tread', 'ride'].map((id) => [id, a.jumps(id, pts)]));
    // How long a stroke of each arm takes: frames between the left hand passing its midpoint forward.
    const stroke = (id: string) => {
      const z = a.track(id, ['handL']).map((r: any) => r.joints.handL[2]);
      const mid = (Math.min(...z) + Math.max(...z)) / 2;
      const ups = z.flatMap((v: number, i: number) => (i > 0 && z[i - 1] < mid && v >= mid ? [i] : []));
      return (ups[ups.length - 1] - ups[0]) / (ups.length - 1) / 60;
    };
    return { jumps, swim: stroke('swim'), sprint: stroke('swimSprint') };
  });
  // Treading water, swimming off and stopping twenty minutes into a session, and riding a horse
  // whose pace keeps changing: nothing leaps from one frame to the next. The stroke used to be the
  // session's clock times a pace, so any change of pace (or of the speed another player's updates
  // report) threw it on by the whole session's worth of the difference.
  for (const [id, j] of Object.entries(seen.jumps) as Array<[string, { worst: number; frame: number; joint: string }]>) {
    const allowed = id === 'ride' || id === 'tread' ? 0.03 : 0.09;
    expect(j.worst, `${id}: the ${j.joint} leapt ${j.worst} m on frame ${j.frame}`).toBeLessThan(allowed);
  }
  // At the rules' swimming speed a stroke of each arm takes about a second and a half, sprinting a
  // little less: a calm crawl.
  expect(seen.swim).toBeGreaterThan(1.3);
  expect(seen.swim).toBeLessThan(2);
  expect(seen.sprint).toBeGreaterThan(1.1);
  expect(seen.sprint).toBeLessThan(seen.swim);
});

/**
 * Hands the page's frame loop a clock that moves exactly 1000/fps ms a frame, as fast as it can
 * draw, so the game plays at any frame rate: window.__fps, window.__afterFrame (called after each).
 */
function fixedFrameRate(): void {
  const w = window as any;
  let queue: FrameRequestCallback[] = [];
  let t = performance.now();
  w.__fps = 60;
  w.__clockFrom = (from: number) => (t = from);
  window.requestAnimationFrame = (cb) => queue.push(cb);
  window.cancelAnimationFrame = () => {};
  const tick = () => {
    const due = queue;
    queue = [];
    t += 1000 / w.__fps;
    for (const cb of due) cb(t);
    w.__afterFrame?.();
    setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
}

for (const fps of [30, 144]) {
  test(`rowing in the game at ${fps} fps, the hands stay on the oars: ahead, turning, backing, spinning, starting, stopping`, { tag: '@gpu' }, async ({ page }) => {
    // The boat is placed and its oars swing before the rower is posed in its seat, tilting and
    // riding the swell with it (src/main.ts draw(), LifeView.placeRide): the hands reach for where
    // the handles are this frame, not a frame ago.
    await page.setViewportSize({ width: 480, height: 270 });
    await page.addInitScript(fixedFrameRate);
    await page.goto('/?world&test');
    await page.waitForFunction(() => (window as any).__game?.ready === true, null, { timeout: 60_000 });
    const boarded = await page.evaluate(() => {
      const g = (window as any).__game;
      g.reset();
      g.lifeCommand({ t: 'grant', item: 'deed.rowboat', n: 1 });
      g.advance(1);
      g.teleport(-10, -334, Math.PI);
      g.lifeCommand({ t: 'summon', item: 'deed.rowboat' });
      g.advance(2);
      const b = g.life().vehicles[0];
      for (const side of [1, -1]) {
        g.teleport(b.x + Math.cos(b.heading) * 1.3 * side, b.z - Math.sin(b.heading) * 1.3 * side, b.heading);
        g.advance(2);
        g.lifeCommand({ t: 'interact' });
        // Half a second a frame at a time, so the body has eased into the seat.
        for (let i = 0; i < 30; i++) g.advance(1);
        if (g.state().player.mode === 'ride') return true;
      }
      return false;
    });
    expect(boarded).toBe(true);
    const legs: Array<[number, Record<string, number>]> = [
      [60, {}],
      [150, { stickY: 1 }],
      [120, { stickY: 1, stickX: -1 }],
      [120, { stickY: 1, stickX: 1 }],
      [90, {}],
      [120, { stickY: -1 }],
      [120, { stickX: 1 }],
      [60, {}],
    ];
    const frames = legs.reduce((n, [f]) => n + f, 0);
    await page.evaluate(
      ([legs, fps]) => {
        const w = window as any;
        const g = w.__game;
        w.__fps = fps;
        w.__gaps = [];
        // Each hand from its handle, as drawn.
        w.__afterFrame = () => {
          const h = g.holds();
          if (h) w.__gaps.push(Math.max(...h.hands.map((p: number[], i: number) => Math.hypot(p[0] - h.holds[i][0], p[1] - h.holds[i][1], p[2] - h.holds[i][2]))));
        };
        g.scriptInput(legs);
        w.__clockFrom(performance.now());
        g.setPaused(false);
      },
      [legs, fps] as const,
    );
    const start = await page.evaluate(() => (window as any).__game.state().frame);
    await page.waitForFunction(([s, n]) => (window as any).__game.state().frame >= s + n, [start, frames] as const, { timeout: 100_000, polling: 250 });
    const gaps = await page.evaluate(() => {
      const w = window as any;
      w.__game.setPaused(true);
      return w.__gaps as number[];
    });
    expect(gaps.length).toBeGreaterThan(frames * (fps / 60) * 0.9);
    const worst = Math.max(...gaps);
    expect(worst, `a hand ${worst.toFixed(3)} m off its oar, on frame ${gaps.indexOf(worst)} of ${gaps.length}`).toBeLessThan(0.02);
  });
}
