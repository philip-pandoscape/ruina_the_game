import { recipesAt, vendorFor } from '../../../content/items';
import { questDef } from '../../../content/quests';
import { CONTRACTS, PACKS, packDef, placeName, route } from '../../../content/trade';
import { shortTime } from '../../../sim/life/interact';
import { questsAt } from '../../../sim/life/quests';
import { carried, demandAt, freshness, quote } from '../../../sim/life/trade';
import { esc } from '../../../util/html';
import { buttonHtml } from '../../components/button';
import { listHtml, rowHtml } from '../../components/list';
import { slotHtml } from '../../components/slot';
import type { Handler, View } from '../../components/window';
import { iconHtml, money, uiIcon } from '../../theme/icons';
import type { IslandUI } from '../context';
import { dropcap, objectivesHtml, rewardsHtml } from './quest';

// Talking to someone: what they say, the quests they have for you (on offer, under way, to hand
// in), what else they do (their goods, their workshop or workbench), and at an outpost what its
// trader pays for trade packs today and the contracts on offer. One quest and nothing else to talk
// about opens straight away. Who they are, what they say and the bench they stand at are theirs
// (content/npcs/<id>.json).

/** A line in a list of what you can say (.g-opts): its icon, what it is, and a note at its end. */
const option = (act: string, arg: string, icon: string, label: string, note = '', cls = ''): string =>
  `<li${cls ? ` class="${cls}"` : ''} data-act="${act}" data-arg="${arg}">${icon}<span>${label}</span>${note ? `<small>${note}</small>` : ''}</li>`;

export function dialogView(ui: IslandUI, npcId: string, questId?: string, trade?: boolean): View {
  const life = ui.life;
  const n = life.zone.recipe.npcs.find((x) => x.id === npcId)!;
  const qa = questsAt(life, npcId);
  const active = life.state.quests.active.filter((qp) => {
    const q = questDef(qp.id);
    return (q.turnIn ?? q.giver) === npcId && !qa.turnIn.some((t) => t.id === q.id);
  });
  const outpost = life.zone.recipe.outposts.find((o) => o.npc === npcId);
  const talk: string[] = [];
  if (vendorFor(npcId)) talk.push(option('shop', '', uiIcon('coins', 24), `Browse ${esc(n.name.split(' ')[0])}'s Goods`, '', 'talk'));
  if (outpost) talk.push(option('trade', '', uiIcon('scroll', 24), 'Trade Packs and Contracts', '', 'talk'));
  if (recipesAt(npcId).length) talk.push(option('craft', npcId, uiIcon('craft', 24), 'Commission Work', '', 'talk'));
  if (n.bench) talk.push(option('craft', n.bench, uiIcon('craft', 24), 'Use the Workbench', '', 'talk'));
  const base = { title: n.name, sub: esc(n.title), portrait: ui.face(npcId), w: 424, h: 560 };
  const handlers: Record<string, Handler> = {
    quest: (id) => ui.open({ kind: 'dialog', id: npcId, quest: id }),
    back: () => ui.open({ kind: 'dialog', id: npcId }),
    accept: (id) => {
      life.command({ t: 'accept', quest: id });
      ui.open({ kind: 'dialog', id: npcId });
    },
    complete: (id) => {
      life.command({ t: 'complete', quest: id });
      ui.open({ kind: 'dialog', id: npcId });
    },
    shop: () => ui.open({ kind: 'shop', id: npcId, tab: 'buy' }),
    trade: () => ui.open({ kind: 'dialog', id: npcId, trade: true }),
    craft: (id) => ui.open({ kind: 'craft', id }),
    contract: (id) => life.command({ t: 'contract', id: Number(id) }),
    sellpack: () => life.command({ t: 'interact' }),
  };
  // One quest and nothing else to talk about: open it straight away.
  const only = [...qa.turnIn, ...qa.offer];
  if (!questId && !trade && only.length === 1 && !active.length && !talk.length) questId = only[0].id;

  if (trade && outpost) {
    const rows = PACKS.filter((pk) => (pk as { kind?: string }).kind !== 'material')
      .map((pk) => {
        const r = route(pk.origin, outpost.id);
        if (!r) return '';
        const dmd = demandAt(life, outpost.id, pk.id);
        const fresh = Math.round(pk.base * r.factor * dmd * freshness(0));
        return rowHtml({
          tip: `pack:${pk.id}`,
          slot: slotHtml(iconHtml(pk.icon)),
          body: `<b>${esc(pk.name)}</b><small>From ${esc(placeName(pk.origin))} · Demand ${Math.round(dmd * 100)}%</small>`,
          price: `${money(fresh, 12)}${r.seals ? ` +${r.seals} ${uiIcon('seal', 14)}` : ''}`,
        });
      })
      .join('');
    const cs = life.state.contracts;
    const mine = (cs?.active ?? []).filter((k) => k.outpost === outpost.id);
    const offered = (cs?.offered ?? []).filter((k) => k.outpost === outpost.id);
    const contracts =
      mine.length || offered.length
        ? `<div class="h">Contracts</div>${listHtml(
            mine
              .map((k) =>
                rowHtml({
                  slot: slotHtml(uiIcon('scroll', 32)),
                  body: `<b>${k.count} × ${esc(packDef(k.pack).name)}</b><small>Taken · ${k.delivered}/${k.count} Delivered · ${shortTime(k.expires - life.state.clock)} Left</small>`,
                  price: `+${money(k.bonusCoins, 12)}`,
                }),
              )
              .join('') +
              offered
                .map((k) =>
                  rowHtml({
                    slot: slotHtml(uiIcon('scroll', 32)),
                    body: `<b>${k.count} × ${esc(packDef(k.pack).name)}</b><small>A bonus on the normal price · ${shortTime(CONTRACTS.durationSeconds)} to fill once taken</small>`,
                    price: `+${money(k.bonusCoins, 12)}`,
                    end: buttonHtml('Take', 'contract', { arg: k.id, small: true, gold: true }),
                  }),
                )
                .join(''),
          )}`
        : '';
    const pk = carried(life, ui.sim);
    const q = pk ? quote(life, pk, outpost.id) : null;
    return {
      ...base,
      h: 650,
      body: `<div class="h">Buying Today (Fresh Packs)</div>${listHtml(rows)}<p class="note" style="margin-top:8px">Carry a pack here and press F to sell. Each sale lowers demand by 5%; it recovers over time. Fresh packs earn up to +15%; stale ones lose up to 12%.</p>${contracts}`,
      foot:
        buttonHtml('Back', 'back') +
        (pk && q ? buttonHtml(`Sell ${esc(packDef(pk.def).name)} for ${money(q.coins, 12)}`, 'sellpack', { gold: true }) : buttonHtml('Goodbye', 'close')),
      handlers,
    };
  }

  if (questId) {
    const q = questDef(questId);
    const qp = life.state.quests.active.find((x) => x.id === questId);
    if (qa.turnIn.some((t) => t.id === questId)) {
      return {
        ...base,
        body: `<h2 class="q-title">${esc(q.name)}</h2><p class="q-story">${dropcap(q.outro)}</p>${rewardsHtml(q)}`,
        foot: buttonHtml('Complete Quest', 'complete', { arg: q.id, gold: true }) + buttonHtml('Cancel', 'back'),
        handlers,
      };
    }
    if (qa.offer.some((t) => t.id === questId)) {
      return {
        ...base,
        body: `<h2 class="q-title">${esc(q.name)}</h2><p class="q-story">${dropcap(q.intro)}</p><div class="h">Objectives</div>${objectivesHtml(q)}${rewardsHtml(q)}`,
        foot: buttonHtml('Accept', 'accept', { arg: q.id, gold: true }) + buttonHtml('Decline', 'back'),
        handlers,
      };
    }
    return {
      ...base,
      body: `<h2 class="q-title">${esc(q.name)}</h2><p class="q-story">${dropcap(q.intro)}</p><div class="h">Objectives</div>${objectivesHtml(q, qp)}${rewardsHtml(q)}`,
      foot: buttonHtml('Back', 'back') + buttonHtml('Goodbye', 'close'),
      handlers,
    };
  }

  const quests = [
    ...qa.turnIn.map((q) => option('quest', q.id, uiIcon('quest-done', 24), esc(q.name), 'Complete')),
    ...qa.offer.map((q) => option('quest', q.id, uiIcon('quest-new', 24), esc(q.name))),
    ...active.map((qp) => option('quest', qp.id, uiIcon('quest-active', 24), esc(questDef(qp.id).name), 'In Progress', 'prog')),
  ];
  return {
    ...base,
    body: `<p class="g-say">“${esc(n.greeting)}”</p>${quests.length ? `<div class="h">Quests</div><ul class="g-opts">${quests.join('')}</ul>` : ''}${talk.length ? `<div class="h">Talk</div><ul class="g-opts">${talk.join('')}</ul>` : ''}`,
    foot: `<span></span>${buttonHtml('Goodbye', 'close')}`,
    handlers,
  };
}
