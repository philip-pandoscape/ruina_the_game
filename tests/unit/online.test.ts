import { expect, test } from 'vitest';
import { defaultBuild } from '../../src/content/build';
import { Engine } from '../../src/engine/engine';
import type { Command } from '../../src/engine/island';
import { type Actions, NO_ACTIONS, type PlayerState } from '../../src/engine/rules';
import { EngineSession } from '../../src/engine/session';
import { Prediction, quantize, stateFromServer } from '../../src/net/netPlayer';
import type { WorldFeed } from '../../src/net/worldFeed';

// The Engine online (src/engine/engine.ts, src/net/netPlayer.ts, src/app/onlineWiring.ts): the
// engine's session predicting you a round trip ahead of a server, taking its word on you and your
// island as it comes, running quick commands ahead of it, and offering what the page says is about
// you (someone's vehicle to ride along in, someone to challenge, a plot someone holds).

test("online: the server's word on you, your island as it sends it and commands run ahead come out as the server has them", () => {
  const build = defaultBuild();
  // An offline island stands in for the server, the engine's own (the page's island is built once
  // and every Engine on it shares its colliders): it runs the same inputs, a round trip behind.
  const server = new EngineSession({ openWorld: true, online: false, build });
  const client = new Engine({ openWorld: true, online: true, build });
  const life = client.life!;
  const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  const p0 = { ...server.player().pos };
  const f0 = server.player().facing;
  const ahead = (d: number, side = 0) => ({ x: p0.x + Math.sin(f0) * d + Math.cos(f0) * side, z: p0.z + Math.cos(f0) * d - Math.sin(f0) * side });

  // What the page tells the rules: the world's clock, a roadster with a free seat by the way, a
  // player to challenge, a plot someone holds, and another vehicle's body to bump into.
  let clock = 1_800_000_000;
  client.worldClock = () => clock;
  const car = ahead(5, 1.6);
  const roadster = {
    id: 3,
    def: 'roadster',
    ...car,
    y: client.groundY(car.x, car.z),
    heading: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    speed: 0,
    steer: 0,
    throttle: 0,
    sail: 0,
    grounded: true,
    pitch: 0,
    roll: 0,
    hp: 100,
    cargo: [0, 0],
    ridden: false,
    swimming: false,
  };
  client.othersVehicles = () => [{ host: 7, name: 'Brann', vehicle: roadster, taken: [] }];
  const brann = ahead(1.5, -1);
  client.othersAround = () => [{ id: 7, name: 'Brann', ...brann, y: client.groundY(brann.x, brann.z), busy: null }];
  client.plotOwners = () => ({ 'rise-2': 'Brann' });
  const post = ahead(9, 0.4);
  client.setOthersVehicles([{ ...post, r: 0.7, y: client.groundY(post.x, post.z), height: 1.5 }]);
  client.addSolidHouse({ id: 1, plot: 'rise-1', blueprint: 'cottage', stage: 3, delivered: {}, storage: [], taxPaidUntil: 0 });
  const field = ahead(-6, 3);
  client.addSolidScarecrow({ id: 4, ...field, rot: 0.3, cells: new Array(16).fill(null) });

  // The wiring of src/app/onlineWiring.ts: quick commands run ahead until the server has run them.
  const sent: Command[] = [];
  const running: Array<{ seq: number; c: Command }> = [];
  const net = { renderTick: () => 0, sendInput: () => {} } as unknown as WorldFeed;
  const prediction = new Prediction(client, net);
  client.remote = (c) => {
    sent.push(c);
    if (c.t !== 'drop' && c.t !== 'exit') return;
    client.runAhead(c);
    running.push({ seq: prediction.seq + 1, c });
  };
  type You = {
    ack: number;
    clock: number;
    labor: number;
    weather: (typeof life)['weather'];
    vehicles: (typeof life.land)['vehicles'];
    resting: boolean;
    placing: null;
  };
  let you: You | null = null;
  prediction.beforeReplay = () => {
    if (!you) return;
    while (running.length && running[0].seq <= you.ack) running.shift();
    client.replayIsland(
      you,
      running.map((r) => r.c),
    );
  };
  const history = new Map<number, { player: PlayerState; life: NonNullable<ReturnType<EngineSession['life']>> }>();
  const word = () => ({ player: stateFromServer(server.player() as unknown as Record<string, unknown>), life: server.life()! });
  const tick = (ack: number) => {
    const h = history.get(ack)!;
    client.takeIsland({ state: copy(h.life.state), land: copy(h.life.land), market: copy(h.life.market), placing: null, resting: false });
    const l = copy(h.life);
    you = { ack, clock: l.state.clock, labor: l.state.labor, weather: l.weather, vehicles: l.land.vehicles, resting: false, placing: null };
    prediction.reconcile(ack, copy(h.player));
  };
  history.set(0, word());
  tick(0); // the first word places you

  const press = (i: number): Actions => ({
    ...NO_ACTIONS,
    moveZ: i < 70 || (i > 110 && i < 140) ? 1 : 0,
    moveX: i > 80 && i < 100 ? 0.6 : 0,
    jumpPressed: i === 20 || i === 120,
    jumpHeld: (i >= 20 && i < 30) || (i >= 120 && i < 126),
    sprintHeld: i > 40 && i < 60,
  });
  const prompts = new Set<string>();
  for (let i = 1; i <= 160; i++) {
    const a = press(i);
    prediction.step(a);
    prompts.add(life.focus?.label ?? 'none');
    server.step(quantize(a).actions);
    history.set(i, word());
    if (i === 30) client.command({ t: 'drop' });
    if (i === 45) client.command({ t: 'exit' });
    if (i === 100) {
      // Over to the plot beside one someone else holds, on both sides.
      server.call('place', { x: 132, z: -186, facing: Math.PI });
      client.place(132, -186, Math.PI);
    }
    if (i % 3 === 0 && i > 8) tick(i - 8);
    clock += 1 / 60;
  }
  expect(sent.map((c) => c.t)).toEqual(['drop', 'exit']);
  // Riding along with Brann and challenging him were both on offer on the way, and the plot he holds wasn't yours to claim.
  expect([...prompts]).toEqual(expect.arrayContaining(['Ride with Brann', 'Challenge Brann', "Brann's Plot"]));
});
