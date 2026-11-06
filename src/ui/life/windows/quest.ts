import { itemDef } from '../../../content/items';
import { objectiveTarget, type QuestDef } from '../../../content/quests';
import { esc } from '../../../util/html';
import { progressHtml } from '../../components/bars';
import { slotHtml } from '../../components/slot';
import { iconHtml, money, uiIcon } from '../../theme/icons';

// A quest as the windows tell it (whoever gives it, the quest log): its story under a drop cap,
// its objectives with how far along you are, and what it gives you.

/** A story with its first letter dropped. */
export const dropcap = (t: string): string => `<span class="dropcap">${esc(t[0])}</span>${esc(t.slice(1))}`;

/** What a quest gives you: items, skill points, labor, seals and money, a slot each. */
export function rewardsHtml(q: QuestDef): string {
  const r = q.rewards as QuestDef['rewards'] & { skillPoints?: number };
  const reward = (slot: string, name: string, tip?: string) => `<div class="rw"${tip ? ` data-tip="${tip}"` : ''}>${slot}<span class="nm">${name}</span></div>`;
  const rows = (r.items ?? []).map((i) => {
    const it = itemDef(i.item);
    return reward(slotHtml(iconHtml(it.icon, i.item), { n: i.n > 1 ? i.n : undefined }), esc(it.name), `item:${i.item}`);
  });
  if (r.skillPoints) rows.push(reward(slotHtml(uiIcon('star', 32)), `${r.skillPoints} Skill Point${r.skillPoints > 1 ? 's' : ''}`));
  if (r.labor) rows.push(reward(slotHtml(uiIcon('labor', 32)), `${r.labor} Labor`));
  if (r.seals) rows.push(reward(slotHtml(uiIcon('seal', 32)), `${r.seals} Seal${r.seals > 1 ? 's' : ''}`));
  if (r.coins) rows.push(reward(slotHtml(uiIcon('coins', 32)), money(r.coins, 12)));
  return rows.length ? `<div class="h">Rewards</div><div class="q-rewards">${rows.join('')}</div>` : '';
}

/** A quest's steps, those done struck through; with `qp` (the quest under way), how far along each is. */
export function objectivesHtml(q: QuestDef, qp?: { step: number; counts: number[] }): string {
  return `<ul class="q-objs">${q.steps
    .map((s, i) => {
      // One objective counts up; several (places to see) count how many are done.
      const many = s.objectives.length > 1;
      const o = s.objectives[0];
      const t = many ? s.objectives.length : o ? objectiveTarget(o) : 1;
      const now =
        many && qp && i === qp.step ? s.objectives.filter((x, k) => (qp.counts[k] ?? 0) >= objectiveTarget(x)).length : Math.floor(qp?.counts[0] ?? 0);
      const have = qp ? (i < qp.step ? t : i === qp.step ? now : 0) : 0;
      const done = !!qp && i < qp.step;
      const count = t > 1 ? ` <b>${have}/${t}</b>${qp && i === qp.step ? progressHtml(Math.min(100, (have / t) * 100)) : ''}` : '';
      return `<li class="${done ? 'done' : ''}">${esc(s.text)}${count}</li>`;
    })
    .join('')}</ul>`;
}
