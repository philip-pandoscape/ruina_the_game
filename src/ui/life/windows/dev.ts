import { dungeonDef } from '../../../engine/zone';
import { esc } from '../../../util/html';
import { buttonHtml } from '../../components/button';
import type { View } from '../../components/window';
import type { IslandUI } from '../context';

// Developer Tools (`, or from the Admin window): gifts, island time, teleports (to the dungeons'
// doors too), starting the island over and bug reports, for trying things out quickly. Online the
// server answers its commands for admins only.

/** A small button in the panel. */
const small = (label: string, act: string, arg?: string | number): string => buttonHtml(label, act, { arg, small: true });

export function devView(ui: IslandUI): View {
  const life = ui.life;
  const app = ui.app;
  // The dungeons' doors too (they're no place on the map: the way in is a secret).
  const doors = (life.zone.recipe.doors ?? []).map((d) => small(`${esc(dungeonDef(d.id)?.name ?? d.id)} Door`, 'tp', `door:${d.id}`));
  const places = life.zone.recipe.places.map((pl) => small(esc(pl.name), 'tp', pl.id)).join('') + doors.join('');
  return {
    title: 'Developer Tools',
    sub: 'For trying things out quickly. ` toggles this window.',
    w: 560,
    h: 600,
    body: `<div class="lui-dev"><div class="h">Give</div>
      ${small('+1 Gold', 'grant', 'coins')}
      ${small('+10 Seals', 'grant', 'seals')}
      ${small('+500 Labor', 'grant', 'labor')}
      ${small('Seeds, Saplings & Young Animals', 'grant', 'seeds')}
      ${small('Produce for Packs', 'grant', 'produce')}
      ${small('Building Materials', 'grant', 'mats')}
      ${small('Every Vehicle, Mount & Glider', 'grant', 'rides')}
      ${small('Cottage Blueprint, Cog Design, Scarecrows', 'grant', 'house')}
      <div class="h">Island Time</div>
      ${small('+1 Minute', 'warp', 60)}
      ${small('+10 Minutes', 'warp', 600)}
      ${small('+1 Hour', 'warp', 3600)}
      <div class="note">Skips ahead on your island: crops grow, and labor and prices recover. ${app.skyHour ? "The sky and the weather keep the world's time, the same for everyone." : 'The sky and the weather move on with it.'}</div>
      <div class="h">Teleport</div>${places}
      <div class="h">Save</div>${small('Start Emberholm Over', 'reset')}
      ${app.onBugReport ? `<div class="h">Bug Report</div>${small('Record a Bug Report', 'bug')}<div class="note">Or press <b>${esc(app.bugKey())}</b> any time (click both sticks on a controller). It keeps the last 30 seconds of play, then records your voice and the screen until you press it again.</div>` : ''}</div>`,
    handlers: {
      grant: (what) => {
        const g = (item: string, n = 1) => ui.command({ t: 'grant', item, n });
        if (what === 'coins') ui.command({ t: 'grant', coins: 10000 });
        if (what === 'seals') ui.command({ t: 'grant', seals: 10 });
        if (what === 'labor') ui.command({ t: 'grant', labor: 500 });
        if (what === 'seeds')
          ['seed.sunroot', 'seed.barley', 'seed.flax', 'seed.emberberry'].forEach((s) => g(s, 20)),
            g('sapling.apple', 4),
            g('sapling.pine', 4),
            g('animal.chick', 3),
            g('animal.lamb', 2),
            g('animal.calf', 2);
        if (what === 'produce') g('sunroot', 30), g('barley', 40), g('flax', 16), g('emberberry', 16), g('apple', 16), g('egg', 8), g('milk', 6), g('wool', 16);
        if (what === 'mats') g('lumber', 120), g('stone', 40), g('ironOre', 30), g('flax', 30);
        if (what === 'rides')
          [
            'deed.farmCart',
            'deed.roadster',
            'deed.hauler',
            'deed.rowboat',
            'deed.sloop',
            'deed.cog',
            'whistle.donkey',
            'whistle.horse',
            'glider.wayfarer',
            'glider.swiftwing',
          ].forEach((i) => life.count(i) || g(i));
        if (what === 'house') g('blueprint.cottage'), g('scarecrow', 2), g('design.cog');
        if (what === 'rides' && !life.state.glider) ui.command({ t: 'use', item: 'glider.wayfarer' });
      },
      warp: (s) => ui.command({ t: 'warp', seconds: Number(s) }),
      tp: (id) => {
        const door = id.startsWith('door:') ? life.zone.recipe.doors?.find((d) => d.id === id.slice(5)) : undefined;
        if (door) app.onTeleport?.(door.outside.x, door.outside.z, door.outside.facing + Math.PI);
        else {
          const pl = life.zone.recipe.places.find((x) => x.id === id)!;
          app.onTeleport?.(pl.x, pl.z);
        }
        ui.finish();
      },
      reset: () => app.onReset?.(),
      bug: () => {
        // Close first, so the report's screenshot shows the game rather than this window. The
        // mouse stays free: the bug reporter may ask for a microphone, or for the bug in writing.
        ui.closeAll();
        app.onBugReport?.();
      },
    },
  };
}
