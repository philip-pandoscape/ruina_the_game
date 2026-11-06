// Playing on the game server, wired to the game: the badge (who you are, whether the server is
// there, Characters and Sign Out), the world freezing under a screen while the server is away
// (updating, or the connection dropped) and carrying on when it's back, moving between a channel
// and a dungeon's copy, the commands that run ahead of the server, and each tick it sends. Play
// stops for good if another window takes this character or the sign-in ends. It reaches the game
// through `g`, the references src/main.ts hands it.
import { stateFromServer } from '../net/netPlayer';
import { type Command } from '../sim/life/life';
import { runCommand } from '../sim/life/interact';
import type { LifeState } from '../sim/life/state';
import { leaveFor, plainUrl } from '../app/resume';
import { signOut } from '../net/account';
import { NetOverlay, OnlineBadge, showStopped } from '../ui/signIn';
import { splash } from '../ui/splash';
import type { SpaceView, WorldTick, YouState } from '../net/worldLink';
import { addHouseColliders } from '../sim/life/housing';
import { addScarecrowCollider } from '../sim/life/farming';
import type { GameRefs } from '../main';

export function wireOnline(g: GameRefs): void {
  const { QUICK, life, lifeUI, lifeView, net, online, onlineSpace, peers, prediction, sim } = g;
  if (online) {
    const { link } = online;
    const exitToSelect = () => leaveFor(plainUrl());
    const where = (s: SpaceView) => `${online.welcome.character.name} · ${s.kind === 'dungeon' ? s.name : `Emberholm ${s.channel}`}`;
    const badge = new OnlineBadge(where(link.space), {
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
      if (g.frozen === on) return;
      g.frozen = on;
      g.acc = 0;
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
        g.paused = true;
        showStopped(s);
        // Still loading: the title screen mustn't hide why play stopped.
        void splash?.fadeOut();
      }
    };
    link.onStatus = stopIf;
    // A new connection counts inputs from scratch: start again from the server's next word. It may
    // put you somewhere else, too: a restarted server has no dungeon copies, and puts you outside the
    // door of the one you were in.
    link.onReconnect = () => {
      prediction?.resync();
      ahead.length = 0;
      peers?.everyoneLeft();
      net?.resetWorld();
      badge.rename(where(link.space));
      onlineSpace(link.space);
    };
    link.onError = (text) => life?.fromServer({ t: 'toast', text, kind: 'bad' });
    link.onNotice = (text) => life?.fromServer({ t: 'toast', text, kind: 'info' });
    // Into a dungeon's copy, or back out of it (crates/server/src/play/spaces.rs): another game, with its own ticks
    // and its own people. As after a reconnection, start again from what the server says next.
    link.onSpace = (s) => {
      prediction?.resync();
      ahead.length = 0;
      peers?.everyoneLeft();
      net?.resetWorld();
      badge.rename(where(s));
      onlineSpace(s);
    };

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
      const quick = (c: Command): boolean =>
        c.t === 'drop' || (c.t === 'exit' && !sim.player.host) || (c.t === 'interact' && !!life.focus?.ok && QUICK.has(life.focus.action));
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
      net?.applyWorld(
        t.tick,
        { id: t.you.id, ack: t.you.ack, player: stateFromServer(t.you.p) },
        t.arrows ?? [],
        t.meteors ?? [],
        t.events ?? [],
        t.actors ?? [],
      );
      if (life) for (const e of t.lifeEvents ?? []) life.fromServer(e);
    };
    link.onTick = onTick;
    // Back in a dungeon's copy you were in (the connection came back while it was still there).
    onlineSpace(link.space);
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
      const ready = () => g.framesDrawn >= 3 && (lifeLoaded || performance.now() - started > 4000);
      const wait = () => (ready() ? void title.fadeOut() : requestAnimationFrame(wait));
      requestAnimationFrame(wait);
    }
  }
}
