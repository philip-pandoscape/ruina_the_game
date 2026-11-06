import { QUESTS, questDef } from '../../../content/quests';
import { isReady } from '../../../sim/life/quests';
import { esc } from '../../../util/html';
import { buttonHtml } from '../../components/button';
import type { View } from '../../components/window';
import { uiIcon } from '../../theme/icons';
import type { IslandUI } from '../context';
import type { Untracked } from '../hud/quests';
import { dropcap, objectivesHtml, rewardsHtml } from './quest';

// The quest log (L): the quests under way, the milestones and what's done, in a list; the one
// picked told in full beside it. A quest under way can come off the tracker, and be given up
// (asked once more first).

export class QuestLog {
  /** The quest picked in the list. */
  sel = '';
  /** The quest whose Abandon was pressed once: the log asks before giving it up. */
  private abandonAsk = '';

  constructor(
    private ui: IslandUI,
    private untracked: Untracked,
  ) {}

  view(): View {
    const ui = this.ui;
    const life = ui.life;
    const all = life.state.quests.active;
    const active = all.filter((qp) => !questDef(qp.id).milestone);
    const milestones = all.filter((qp) => questDef(qp.id).milestone);
    if (!this.sel || !all.some((q) => q.id === this.sel)) this.sel = active[0]?.id ?? milestones[0]?.id ?? '';
    const row = (qp: { id: string }) =>
      `<div class="ql-q${qp.id === this.sel ? ' sel' : ''}${isReady(life, qp.id) ? ' ready' : ''}" data-act="logsel" data-arg="${qp.id}"><i class="dot"></i>${esc(questDef(qp.id).name)}</div>`;
    const done = life.state.quests.done;
    const list =
      `<div class="ql-zone"><span>${esc(life.zone.recipe.name)}</span><span>${active.length}</span></div>` +
      active.map(row).join('') +
      (milestones.length
        ? `<div class="ql-zone" style="margin-top:14px"><span>Milestones</span><span>${milestones.length}</span></div>` + milestones.map(row).join('')
        : '') +
      `<div class="ql-zone" style="margin-top:14px"><span>Completed</span><span>${done.length}</span></div>` +
      done
        .map(
          (id) =>
            `<div class="ql-q done"><i class="dot done"></i>${esc(questDef(id).name)}<small>✓ ${questDef(id).milestone ? 'Milestone' : 'Done'}</small></div>`,
        )
        .join('');
    let page = '<p class="muted">No quests under way. Look for people with a gold mark over their heads.</p>';
    const qp = all.find((x) => x.id === this.sel);
    if (qp) {
      const q = questDef(qp.id);
      const who = life.zone.recipe.npcs.find((n) => n.id === (q.turnIn ?? q.giver))?.name ?? '';
      const kind = q.milestone ? '<div class="sd-type">Milestone · done the moment you get there</div>' : '';
      page = `<h2 class="q-title">${esc(q.name)}</h2>${kind}<p class="q-story">${dropcap(q.intro)}</p><div class="h">Objectives</div>${objectivesHtml(q, qp)}${isReady(life, q.id) ? `<p style="margin-top:6px;color:var(--good);font-weight:700">Ready: return to ${esc(who)}.</p>` : ''}${rewardsHtml(q)}`;
    }
    const quests = QUESTS.filter((q) => !q.milestone);
    const doneQuests = done.filter((id) => !questDef(id).milestone).length;
    // A quest under way can come off the tracker, and be given up (asked once more first); a
    // milestone can't be either, and the quests that start by themselves can't be given up.
    let foot: string | undefined;
    const sel = qp ? questDef(qp.id) : null;
    if (sel && !sel.milestone) {
      const tracked = !this.untracked.get().has(sel.id);
      const track = buttonHtml(tracked ? 'Untrack' : 'Track on Screen', 'track', { arg: sel.id, small: true, gold: true });
      const give = sel.auto
        ? '<span></span>'
        : this.abandonAsk === sel.id
          ? `<span style="display:flex;gap:10px;align-items:center"><span class="muted">Give it up?</span>${buttonHtml('Abandon', 'abandon', { arg: sel.id, small: true })}${buttonHtml('Keep', 'keep', { small: true })}</span>`
          : buttonHtml('Abandon', 'ask', { arg: sel.id, small: true });
      foot = give + track;
    }
    return {
      title: 'Quest Log',
      sub: `${doneQuests} of ${quests.length} Quests · ${done.length - doneQuests} of ${QUESTS.length - quests.length} Milestones`,
      portrait: uiIcon('scroll'),
      w: 700,
      h: 520,
      body: `<div class="ql"><div class="ql-list">${list}</div><div>${page}</div></div>`,
      foot,
      handlers: {
        logsel: (id) => {
          this.sel = id;
          this.abandonAsk = '';
          ui.redraw();
        },
        ask: (id) => {
          this.abandonAsk = id;
          ui.redraw();
        },
        keep: () => {
          this.abandonAsk = '';
          ui.redraw();
        },
        abandon: (id) => {
          this.abandonAsk = '';
          life.command({ t: 'abandon', quest: id });
          ui.redraw();
        },
        track: (id) => {
          this.untracked.setTracked(id, this.untracked.get().has(id));
          ui.redraw();
        },
      },
    };
  }
}
