import { itemDef } from '../../../content/items';
import { LABOR, packDef } from '../../../content/trade';
import { glider as gliderDef } from '../../../content/vehicles';
import { pointsLeft } from '../../../content/build';
import type { Vitals } from '../../../render/hud';
import { skillBudget } from '../../../sim/life/progress';
import { carried } from '../../../sim/life/trade';
import { esc } from '../../../util/html';
import { slotHtml } from '../../components/slot';
import type { View } from '../../components/window';
import { WEAPON_ICONS, WEAPON_NAMES } from '../../icons';
import { comboDamage } from '../../skills/describe';
import { iconHtml, money } from '../../theme/icons';
import type { IslandUI } from '../context';

// The character window (P): you, what you wear and carry in each slot (most still to come), and
// your numbers. Its MP and stamina tick along with the bars beside your portrait.

export function characterView(ui: IslandUI): View {
  const life = ui.life;
  const p = ui.sim.player;
  const v = ui.vitals();
  const hp = v?.hp ?? 0;
  const maxHp = v?.maxHp ?? 0;
  const slot = (label: string, filled: string | null, emoji: string, tip: string) =>
    `<div class="ch-slot" data-tip="${tip}">${filled ?? slotHtml(iconHtml(emoji, undefined, 48), { cls: 'big empty ghost' })}<span>${label}</span></div>`;
  const item = (id: string) => slotHtml(iconHtml(itemDef(id).icon, id, 48), { cls: 'big' });
  const glider = life.state.glider ? `glider.${life.state.glider}` : null;
  const mount = life.state.bag.find((s) => itemDef(s.item)?.cat === 'mount')?.item ?? null;
  const back = carried(life, ui.sim);
  const body = ui.app.portraitOf('body');
  const weapon = p.weapon;
  return {
    title: 'Character',
    sub: esc(ui.app.playerName),
    portrait: ui.face('player'),
    w: 620,
    h: 520,
    body: `<div class="ch">
        <div class="ch-col">${slot('Head', null, '🪖', 'slot:Head')}${slot('Back', glider ? item(glider) : null, '🪁', glider ? `item:${glider}` : 'slot:Back')}${slot('Chest', null, '👕', 'slot:Chest')}${slot('Hands', null, '🧤', 'slot:Hands')}</div>
        <div class="ch-mid"><div class="ch-model">${body ? `<img src="${body}" alt="">` : '<div style="display:grid;place-items:center;height:100%;font-size:90px">🧑</div>'}</div>
          <div class="ch-weap">${slot('Main Hand', slotHtml(iconHtml(WEAPON_ICONS[weapon] ?? '🗡️', undefined, 48), { cls: 'big' }), '🗡️', `weapon:${weapon}`)}${slot('Off Hand', null, '🛡️', 'slot:Off Hand')}${slot('Tool', null, '🔨', 'slot:Tool')}</div></div>
        <div class="ch-col">${slot('Legs', null, '👖', 'slot:Legs')}${slot('Feet', null, '🥾', 'slot:Feet')}${slot('Mount', mount ? item(mount) : null, '🐎', mount ? `item:${mount}` : 'slot:Mount')}${slot('Pack', back ? slotHtml(iconHtml(packDef(back.def).icon, undefined, 48), { cls: 'big' }) : null, '📦', back ? `pack:${back.def}` : 'slot:Pack')}</div>
        <div class="ch-stats"><h4>${esc(ui.app.playerName)}</h4>
          ${maxHp ? `<div class="r"><span>Health</span><b>${Math.round(hp)} / ${maxHp}</b></div>` : ''}
          ${v ? `<div class="r"><span>MP</span><b data-vital="mp">${Math.floor(v.mp)} / ${v.maxMp}</b></div>` : ''}
          ${v ? `<div class="r"><span>Stamina</span><b data-vital="stamina">${Math.floor(v.stamina)} / ${v.maxStamina}</b></div>` : ''}
          <div class="r"><span>Labor</span><b>${Math.floor(life.state.labor)} / ${LABOR.max}</b></div>
          <div class="r"><span>Weapon</span><b>${esc(WEAPON_NAMES[weapon] ?? '')}</b></div>
          <div class="r"><span>Combo Damage</span><b>${comboDamage(weapon, ui.sim.stats)}</b></div>
          <div class="r"><span>Skill Points</span><b>${pointsLeft(p.skills, skillBudget(life.state))} Left</b></div>
          <div class="r"><span>Glider</span><b>${life.state.glider ? esc(gliderDef(life.state.glider).name) : 'None'}</b></div>
          <div class="r"><span>Money</span>${money(life.state.coins, 12)}</div>
          <div class="r"><span>Seals</span><b>${life.state.seals}</b></div>
          <div class="note">Head, chest, hands, legs, feet, off hand and tool are slots for armour and tools still to come.</div></div>
      </div>`,
  };
}

/** The open character window's MP and stamina, kept up with `v` without drawing the window again. */
export function tickVitals(card: HTMLElement, v: Vitals): void {
  const mp = `${Math.floor(v.mp)} / ${v.maxMp}`;
  const stamina = `${Math.floor(v.stamina)} / ${v.maxStamina}`;
  for (const e of card.querySelectorAll<HTMLElement>('[data-vital]')) {
    const text = e.dataset.vital === 'mp' ? mp : stamina;
    if (e.textContent !== text) e.textContent = text;
  }
}
