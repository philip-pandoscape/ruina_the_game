import type { App } from './app';
import { h, icon, modal, toast } from './dom';
import { orderOf } from './notes';
import { store, type Note } from './store';

// The library's two windows besides Create Prompt (prompts.ts): every note on every animation,
// grouped by animation, each one a way to it; and the keys.

export function openAllNotes(app: App): void {
  const body = h('div', { class: 'all-notes' });
  let close = () => {};
  const draw = () => {
    body.replaceChildren();
    const groups = new Map<string, Note[]>();
    for (const n of store.notes) {
      const k = `${n.subjectName} · ${n.animLabel}`;
      groups.set(k, [...(groups.get(k) ?? []), n]);
    }
    if (!groups.size) body.append(h('div', { class: 'empty' }, 'No notes yet.'));
    for (const [k, list] of groups) {
      const open = list.filter((n) => n.status === 'open').length;
      body.append(
        h(
          'div',
          { class: 'group' },
          h('h4', {}, k, open ? h('span', { class: 'badge' }, String(open)) : h('span', { class: 'chip muted' }, 'All done')),
          ...list
            .sort((a, b) => orderOf(a) - orderOf(b))
            .map((n) =>
              h(
                'div',
                {
                  class: 'row',
                  onclick: () => {
                    close();
                    app.notes.goTo(n.id);
                  },
                },
                h(
                  'span',
                  { class: `chip${n.kind === 'range' ? ' range' : n.kind === 'anim' ? ' anim' : n.fix ? ' fix' : ''}` },
                  n.kind === 'anim' ? 'Whole' : n.kind === 'range' ? `${n.range![0]}–${n.range![1]}` : `Frame ${n.frame}`,
                ),
                h('span', { class: 't' }, n.text || (n.fix ? 'A corrected pose' : '')),
                n.status === 'done' ? h('span', { class: 'chip muted' }, 'Done') : null,
              ),
            ),
        ),
      );
    }
  };
  draw();
  close = modal({
    title: 'All Notes',
    sub: `${store.count((n) => n.status === 'open')} open, ${store.count((n) => n.status === 'done')} done`,
    body,
    foot: [
      h(
        'span',
        { class: 'grow' },
        store.dir ? `Kept in ${store.dir}` : 'Kept in this browser only: the development server (npm run dev) keeps them as files, pictures and all.',
      ),
      h(
        'button',
        {
          class: 'btn danger',
          onclick: () => {
            const k = store.clearDone();
            toast(`${k} done ${k === 1 ? 'note' : 'notes'} cleared`);
            draw();
          },
        },
        icon('trash'),
        'Clear Done Notes',
      ),
    ],
  });
}

export function openHelp(): void {
  const row = (k: string, what: string) => h('div', {}, h('span', {}, what), h('span', {}, ...k.split(' ').map((x) => h('kbd', {}, x))));
  modal({
    title: 'Keyboard',
    narrow: true,
    body: h(
      'div',
      { class: 'keys' },
      h('h4', {}, 'Playing'),
      row('Space', 'Play / pause'),
      row('← →', 'A frame back / on'),
      row('Shift+← Shift+→', 'Ten frames'),
      row('Home End', 'First / last frame'),
      row(', .', 'Slower / faster'),
      row('L', 'Loop'),
      row('[ ]', 'Stretch starts / ends here'),
      row('Esc', 'Clear the stretch'),
      h('h4', {}, 'Looking'),
      row('1 2 3 4 5 6', 'Camera: ¾, front, sides, behind, above'),
      row('F', 'Frame the body again'),
      row('K', 'Skeleton'),
      row('O', 'Onion skin'),
      row('J', 'Paths of hands and feet'),
      row('W', 'The swing’s swoosh'),
      row('B', 'Outdoors or in the studio'),
      row('H', 'Contact sheet: eight frames side by side'),
      row('G', 'Correction ghosts (when not posing)'),
      h('h4', {}, 'Notes'),
      row('N', 'Note on this frame (or the stretch)'),
      row('Shift+N', 'Note on the whole animation'),
      row('Ctrl+Enter', 'Keep the note / Create Prompt'),
      h('h4', {}, 'Correcting a pose'),
      row('P', 'Start (or click a joint)'),
      row('R', 'Turn the joint'),
      row('G', 'Move: a hand or foot reaches'),
      row('S', 'Squash and stretch'),
      row('X Y Z', 'Nudge 5° about its axis (Shift: back)'),
      row('Ctrl+Z Ctrl+Shift+Z', 'Undo / redo'),
      row('Enter', 'Save the correction'),
      row('Esc', 'Discard it'),
    ),
  });
}
