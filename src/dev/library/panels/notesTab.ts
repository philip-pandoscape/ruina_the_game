import type { App } from '../app';
import { ICON, h, icon, modal, toast } from '../dom';
import { matches } from '../measure';
import { openAllNotes } from '../modals';
import { orderOf } from '../notes';
import { store, type Note } from '../store';

// The Notes tab: the note being written (on the frame, a stretch or the whole animation; with a
// corrected pose's picture), the buttons that start one, and a card for each note on this
// animation (what it says, on which frames, its picture, how close the code's pose now comes to a
// correction), which goes to it, edits its words, marks it done or deletes it.

export class NotesTab {
  constructor(private readonly app: App) {}

  render(): void {
    const app = this.app;
    if (app.tab !== 'notes') return;
    const pane = app.el.pane;
    const scroll = pane.scrollTop;
    pane.replaceChildren();
    if (!app.take) return;
    // Starting a note.
    const c = app.notes.composer;
    if (c) {
      const what =
        c.kind === 'anim'
          ? 'The whole animation'
          : c.kind === 'range'
            ? `Frames ${c.range![0]}–${c.range![1]}`
            : `Frame ${c.frame}${c.fix ? ' · corrected pose' : ''}`;
      const ta = h('textarea', {
        placeholder: c.fix ? 'What should change, in your words (optional: the pose says a lot)…' : 'What looks wrong, and what it should look like…',
      });
      ta.value = c.text;
      ta.oninput = () => (c.text = ta.value);
      ta.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void app.notes.submit();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          app.notes.composer = null;
          this.render();
        }
      };
      pane.append(
        h(
          'div',
          { class: 'composer' },
          h('div', { class: 'what' }, icon(c.kind === 'anim' ? 'film' : c.kind === 'range' ? 'range' : c.fix ? 'edit' : 'frame'), what),
          c.picture ? h('img', { src: c.picture.toDataURL('image/jpeg', 0.85), alt: 'Before and after' }) : null,
          ta,
          h(
            'div',
            { class: 'row' },
            h('span', { class: 'hint' }, h('kbd', {}, 'Ctrl'), ' ', h('kbd', {}, 'Enter'), ' keeps it'),
            h(
              'button',
              {
                class: 'btn small ghost',
                onclick: () => {
                  const posing = !!c.fix;
                  app.notes.composer = null;
                  if (posing) {
                    app.tab = 'pose';
                    app.side.render();
                  } else this.render();
                },
              },
              c.fix ? 'Back to Posing' : 'Cancel',
            ),
            h('button', { class: 'btn small primary', onclick: () => void app.notes.submit() }, icon('check'), c.fix ? 'Keep Correction' : 'Keep Note'),
          ),
        ),
      );
      setTimeout(() => ta.focus(), 0);
    } else {
      pane.append(
        h(
          'div',
          { class: 'add-row' },
          h(
            'button',
            { class: 'btn', title: 'Note on this frame (N)', onclick: () => app.notes.compose('frame') },
            icon('frame'),
            h('span', { 'data-frame-label': '' }, `Frame ${app.frame}`),
          ),
          h(
            'button',
            { class: 'btn', title: 'Note on the picked stretch', onclick: () => app.notes.compose('range'), disabled: !app.range },
            icon('range'),
            app.range ? `Frames ${app.range[0]}–${app.range[1]}` : 'A Stretch',
          ),
          h(
            'button',
            { class: 'btn', title: 'Note on the whole animation (Shift+N)', onclick: () => app.notes.compose('anim') },
            icon('film'),
            'Whole Animation',
          ),
        ),
      );
    }
    const notes = [...app.notes.here()].sort((a, b) => (a.status === b.status ? orderOf(a) - orderOf(b) : a.status === 'open' ? -1 : 1));
    if (!notes.length && !c)
      pane.append(
        h(
          'div',
          { class: 'callout' },
          h('p', {}, 'No notes on this animation yet.'),
          h(
            'p',
            { class: 'muted', style: 'margin:0' },
            'Pause on a frame and press ',
            h('kbd', {}, 'N'),
            ' for a note, or ',
            h('kbd', {}, 'P'),
            ' to correct the pose by moving its bones. Shift-drag the timeline to pick a stretch of frames.',
          ),
        ),
      );
    for (const n of notes) pane.append(this.card(n));
    const others = store.count((n) => n.status === 'open') - notes.filter((n) => n.status === 'open').length;
    pane.append(
      h(
        'div',
        { class: 'notes-foot' },
        h('span', {}, others > 0 ? `${others} more open on other animations` : ''),
        h('button', { class: 'link', onclick: () => openAllNotes(app) }, 'All notes'),
      ),
    );
    pane.scrollTop = scroll;
  }

  private card(n: Note): HTMLElement {
    const app = this.app;
    const notes = app.notes;
    const take = app.take!;
    const here = n.kind === 'frame' ? n.frame === app.frame : n.kind === 'range' ? app.frame >= n.range![0] && app.frame <= n.range![1] : false;
    const chip =
      n.kind === 'anim'
        ? h('span', { class: 'chip anim' }, 'Whole')
        : n.kind === 'range'
          ? h('span', { class: 'chip range' }, `${n.range![0]}–${n.range![1]}`)
          : h('span', { class: `chip${n.fix ? ' fix' : ''}` }, `Frame ${n.frame}`);
    const at = n.kind === 'range' ? n.range![0] : n.frame;
    const phase = at !== undefined ? take.phases.find((p) => at >= p.from && at <= p.to) : undefined;
    const editing = notes.editing === n.id;
    const act = (ic: keyof typeof ICON, title: string, fn: () => void) =>
      h(
        'button',
        {
          class: 'icon-btn',
          title,
          onclick: (e: Event) => {
            e.stopPropagation();
            fn();
          },
        },
        icon(ic),
      );
    const card = h(
      'div',
      { class: `note${here ? ' here' : ''}${n.status === 'done' ? ' done' : ''}${editing ? ' editing' : ''}`, onclick: () => !editing && notes.goTo(n.id) },
      h(
        'div',
        { class: 'head' },
        chip,
        n.fix ? h('span', { class: 'chip fix', title: 'A corrected pose' }, 'Pose') : null,
        n.sent && n.status === 'open' ? h('span', { class: 'chip muted', title: `In a prompt ${new Date(n.sent).toLocaleString()}` }, 'Sent') : null,
        n.status === 'done' ? h('span', { class: 'chip muted' }, 'Done') : null,
        h('span', { class: 'phase' }, phase?.label ?? ''),
        h(
          'span',
          { class: 'acts' },
          act('edit', 'Edit the words', () => {
            notes.editing = n.id;
            this.render();
          }),
          act(n.status === 'done' ? 'undo' : 'check', n.status === 'done' ? 'Open it again' : 'Mark done', () =>
            store.update(n.id, { status: n.status === 'done' ? 'open' : 'done' }),
          ),
          act('trash', notes.confirmDelete === n.id ? 'Click again to delete' : 'Delete', () => {
            if (notes.confirmDelete === n.id) {
              store.remove(n.id);
              notes.confirmDelete = null;
            } else {
              notes.confirmDelete = n.id;
              toast('Click the bin again to delete the note');
              setTimeout(() => (notes.confirmDelete = null), 2500);
            }
          }),
        ),
      ),
    );
    if (editing) {
      const ta = h('textarea', {});
      ta.value = n.text;
      const save = () => {
        store.update(n.id, { text: ta.value.trim() });
        notes.editing = null;
      };
      ta.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
        if (e.key === 'Escape') {
          notes.editing = null;
          this.render();
        }
      };
      card.append(
        ta,
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            {
              class: 'btn small ghost',
              onclick: (e: Event) => {
                e.stopPropagation();
                notes.editing = null;
                this.render();
              },
            },
            'Cancel',
          ),
          h(
            'button',
            {
              class: 'btn small primary',
              onclick: (e: Event) => {
                e.stopPropagation();
                save();
              },
            },
            'Save',
          ),
        ),
      );
      setTimeout(() => ta.focus(), 0);
    } else card.append(h('div', { class: `text${n.text ? '' : ' none'}` }, n.text || 'A corrected pose, no words'));
    if (n.fix?.image) {
      const src = store.image(n.fix.image).url;
      card.append(
        h('img', {
          src,
          alt: 'As it was and as corrected',
          loading: 'lazy',
          title: 'Bigger',
          onclick: (e: Event) => {
            e.stopPropagation();
            modal({ title: `Frame ${n.frame}: as it was and as corrected`, sub: n.text, body: h('div', { class: 'zoom' }, h('img', { src, alt: '' })) });
          },
        }),
      );
    }
    if (n.fix) {
      const m = notes.measure(n);
      if (m) {
        const good = matches(m);
        const pct = Math.round(m.progress * 100);
        card.append(
          h(
            'div',
            {
              class: `match ${good ? 'good' : m.progress < 0.25 ? 'bad' : ''}`,
              title: `Worst bone now ${m.worstDeg.toFixed(1)}° from your pose (was ${m.wasDeg.toFixed(1)}°); worst joint ${(m.worstM * 100).toFixed(1)} cm (was ${(m.wasM * 100).toFixed(1)} cm)`,
            },
            h('span', {}, good ? 'The animation matches it' : `Animation ${m.worstDeg.toFixed(0)}° / ${(m.worstM * 100).toFixed(0)} cm off`),
            h('span', { class: 'meter' }, h('i', { style: `width:${Math.max(4, pct)}%` })),
            h('span', {}, `${pct}%`),
          ),
        );
      }
    }
    return card;
  }
}
