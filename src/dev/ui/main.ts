import '../../ui/theme/theme.css';
import '../../ui/theme/hud.css';
import '../../ui/theme/windows.css';
import '../../ui/theme/skills.css';
import * as THREE from 'three';
import { defaultBuild } from '../../content/build';
import { COMBAT, MP, STAMINA } from '../../content/tuning';
import { Engine } from '../../engine/engine';
import { skillBudget } from '../../engine/island';
import { startEngine } from '../../engine/load';
import { NO_ACTIONS } from '../../engine/rules';
import { LifeUI } from '../../ui/life/lifeUI';
import { MinigamesUI } from '../../ui/minigames/minigames';
import { PartyUI } from '../../ui/party/partyUI';
import { SkillsPanel } from '../../ui/skills/panel';
import { initUiScale } from '../../ui/theme/scale';
import { esc } from '../../util/html';
import { UI_ENTRIES, uiEntry } from './entries';
import { MadeUpParty, MadeUpTables } from './fakes';
import { type Gallery, MADE_UP, OTHERS } from './states';

// The UI gallery (/dev/ui.html#/<window>/<state>; the content library frames it as
// #/ui/<window>/<state>): a window of the game's interface in a made-up state (entries.ts), on a
// real offline island: the zone's world and rules, the island's life and the windows over it,
// stepped as the game steps them, with a made-up world connection for the windows that play with
// others (fakes.ts). Each entry is made up on a fresh island (states.ts), so another address loads
// the page again. A page of its own, as the game's theme sets its colours on the whole document and
// tooltips and menus need one to themselves. With no entry named it lists them. window.__ui is its
// test API (tests/integration/uiGallery.spec.ts).

interface UiApi {
  /** The entry's state is made up and its windows drawn. */
  ready: boolean;
  /** The entry shown (`<window>/<state>`), or null for the list of them. */
  entry: string | null;
  /** Why the entry couldn't be made up, if it couldn't. */
  error: string | null;
  /** What the windows asked of the made-up world connection, in order. */
  asked(): Array<Record<string, unknown>>;
}

declare global {
  interface Window {
    __ui?: UiApi;
  }
}

const tables = new MadeUpTables();
const partyLink = new MadeUpParty();
const api: UiApi = { ready: false, entry: null, error: null, asked: () => [...tables.asked, ...partyLink.asked] };
window.__ui = api;
addEventListener('hashchange', () => location.reload());

const key = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
const entry = uiEntry(key);
if (!entry) list();
else {
  api.entry = key;
  await show(key);
}

/** Every entry, as links: the page with no entry named. */
function list(): void {
  const titles = [...new Set(UI_ENTRIES.map((e) => e.title))];
  const page = document.createElement('div');
  page.className = 'gal-list';
  page.innerHTML =
    '<h1>The UI Gallery</h1><p>Every window of the interface in a made-up state, on an offline island. The content library shows them too.</p>' +
    titles
      .map(
        (t) =>
          `<h2>${esc(t)}</h2><ul>${UI_ENTRIES.filter((e) => e.title === t)
            .map((e) => `<li><a href="#/${e.window}/${e.state}">${esc(e.label)}</a> <span>${esc(e.about)}</span></li>`)
            .join('')}</ul>`,
      )
      .join('');
  document.body.append(page);
}

/** Makes up the entry `key` names on a fresh island, and keeps the island running under it. */
async function show(key: string): Promise<void> {
  initUiScale(document.getElementById('ui') as HTMLElement);
  await startEngine();
  const build = defaultBuild();
  const engine = new Engine({ online: false, build });
  const life = engine.life;
  if (!life) throw new Error('the island has no life');
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 2000);
  const ui = new LifeUI({
    life,
    command: (c) => engine.command(c),
    sim: engine.sim,
    world: engine.world,
    camera: () => camera,
    yaw: () => engine.player.facing,
    device: () => 'keyboard',
  });
  const skills = new SkillsPanel(build, {
    budget: () => skillBudget(life.state),
    budgetNote: () => 'Earned from quests and milestones',
    xp: () => life.state.skillXp ?? {},
    levels: () => engine.sim.levels,
    portrait: () => null,
    device: () => 'keyboard',
  });
  skills.onChange = (b) => engine.setBuild(b);
  const me = { id: 1, name: ui.playerName };
  const free = () => {};
  const minigames = new MinigamesUI({ link: tables, life, openPanel: () => ui.openPanel, freeMouse: free });
  const party = new PartyUI({
    link: partyLink,
    me: me.id,
    openPanel: () => ui.openPanel,
    freeMouse: free,
    nearby: () => OTHERS.map((o, i) => ({ ...o, dist: 4 + i * 6 })),
  });
  const step = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      engine.step(NO_ACTIONS);
      ui.onEvents(life.drainEvents());
    }
  };
  /** A frame as the game draws one: a step, the camera behind you, and every window kept up to date. */
  const frame = (dt: number): void => {
    step();
    const p = engine.player;
    camera.position.set(p.pos.x - Math.sin(p.facing) * 7, p.pos.y + 3.5, p.pos.z - Math.cos(p.facing) * 7);
    camera.lookAt(p.pos.x, p.pos.y + 1.5, p.pos.z);
    camera.updateMatrixWorld();
    ui.setVitals({ hp: p.hp, maxHp: COMBAT.maxHp, mp: p.mp, maxMp: MP.max, stamina: p.stamina, maxStamina: STAMINA.max });
    ui.update(dt);
    tables.hold();
    partyLink.hold();
    minigames.update();
    party.update();
    skills.tick();
  };
  /**
   * Five seconds of frames: what a moment brings (the banner naming where you are, toasts) comes and
   * goes, and the fades it set going are over, so the page looks as it would a moment later.
   */
  const settle = (): void => {
    for (let i = 0; i < 50; i++) frame(0.1);
    for (const a of document.getAnimations()) if (a instanceof CSSTransition) a.finish();
  };
  const g: Gallery = { engine, life, ui, skills, minigames, tables, party, partyLink, me, step };
  // You arrive, the island settles, then the state is made up and drawn, and settles in its turn.
  step(2);
  settle();
  try {
    MADE_UP[key](g);
    settle();
  } catch (e) {
    api.error = String(e);
    const say = document.createElement('div');
    say.className = 'gal-error';
    say.textContent = `This can't be made up: ${api.error}`;
    document.body.append(say);
  }
  api.ready = true;
  let last = performance.now();
  const run = (now: number): void => {
    frame(Math.min(0.1, (now - last) / 1000));
    last = now;
    requestAnimationFrame(run);
  };
  requestAnimationFrame(run);
}
