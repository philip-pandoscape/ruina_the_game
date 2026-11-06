import { objectiveTarget, QUESTS, questDef } from '../../../content/quests';
import { packDef, placeName } from '../../../content/trade';
import { shortTime, questsAt } from '../../../engine/island';
import { esc } from '../../../util/html';
import { progressHtml } from '../../components/bars';
import { el } from '../../components/dom';
import { uiIcon } from '../../theme/icons';
import type { IslandUI } from '../context';

// The quest tracker on the right: each quest under way you haven't taken off it, with its step and
// how far along, then your contracts, then how many more are in the log and how many are on offer.

/** Quests you've taken off the tracker, kept in this browser for each name you play under. */
export class Untracked {
  private owner = '';
  private ids = new Set<string>();

  /** `name` is the name you play under now. */
  constructor(private name: () => string) {}

  get(): Set<string> {
    const name = this.name();
    if (this.owner !== name) {
      this.owner = name;
      try {
        this.ids = new Set(JSON.parse(localStorage.getItem(`ruina.untracked.${name}`) ?? '[]') as string[]);
      } catch {
        this.ids = new Set();
      }
    }
    return this.ids;
  }

  /** Puts a quest back on the tracker (`on`) or takes it off. */
  setTracked(id: string, on: boolean): void {
    const u = this.get();
    if (on) u.delete(id);
    else u.add(id);
    try {
      localStorage.setItem(`ruina.untracked.${this.name()}`, JSON.stringify([...u]));
    } catch {
      /* storage unavailable */
    }
  }
}

export class QuestTracker {
  readonly el = el('div', 'lui');
  private shown = '';

  constructor(
    private ui: IslandUI,
    private untracked: Untracked,
  ) {
    this.el.id = 'lui-quests';
  }

  update(): void {
    const life = this.ui.life;
    const parts: string[] = [];
    const hidden = this.untracked.get();
    let untracked = 0;
    for (const qp of life.state.quests.active) {
      const q = questDef(qp.id);
      if (q.milestone) continue; // the log keeps those
      if (hidden.has(qp.id)) {
        untracked++;
        continue;
      }
      if (qp.step >= q.steps.length) {
        const who = life.zone.recipe.npcs.find((n) => n.id === (q.turnIn ?? q.giver))?.name ?? '';
        parts.push(`<div class="q ready"><div class="qt"><i></i>${esc(q.name)}</div><div class="step">Return to ${esc(who)}</div></div>`);
        continue;
      }
      const step = q.steps[qp.step];
      let bars = '';
      const counts = step.objectives
        .map((o, i) => {
          const t = objectiveTarget(o);
          if (t <= 1) return '';
          const have = o.type === 'glide' ? Math.floor(qp.counts[i]) : qp.counts[i];
          bars += progressHtml(Math.min(100, (have / t) * 100));
          return ` <span class="count">${have}/${t}${o.type === 'glide' ? 's' : ''}</span>`;
        })
        .join('');
      parts.push(`<div class="q"><div class="qt"><i></i>${esc(q.name)}</div><div class="step">${esc(step.text)}${counts}</div>${bars}</div>`);
    }
    for (const k of life.state.contracts?.active ?? []) {
      parts.push(
        `<div class="q"><div class="qt"><i></i>Contract · ${esc(placeName(k.outpost))}</div><div class="step">${k.count} × ${esc(packDef(k.pack).name)} <span class="count">${k.delivered}/${k.count}</span> · ${shortTime(k.expires - life.state.clock)} Left</div>${progressHtml((k.delivered / k.count) * 100)}</div>`,
      );
    }
    if (untracked) parts.push(`<div class="hint">${untracked} more in your quest log (L)</div>`);
    const offers = QUESTS.filter((q) => !q.auto && questsAt(life, q.giver).offer.includes(q)).length;
    if (offers) parts.push(`<div class="hint">${offers} quest${offers > 1 ? 's' : ''} on offer: look for ${uiIcon('quest-new', 15)}</div>`);
    if (!parts.length) parts.push(`<div class="hint">Nothing under way. Look for ${uiIcon('quest-new', 15)} over people's heads.</div>`);
    const html = `<div class="scroll"><h4>Quests</h4>${parts.join('')}</div>`;
    if (html !== this.shown) {
      this.shown = html;
      this.el.innerHTML = html;
    }
  }
}
