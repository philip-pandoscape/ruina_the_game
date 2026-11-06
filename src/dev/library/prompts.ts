import type { App } from './app';
import { h, icon, modal, toast } from './dom';
import { openAllNotes } from './modals';
import { buildPrompt } from './prompt';
import { noteKey, store, type Note } from './store';
import { subjectById } from './subjects';

// The Create Prompt window: the open notes on this animation, on everything of this subject or on
// everything, turned into one prompt for Claude (prompt.ts writes it), copied to the clipboard and
// kept beside the notes on disk.

/** Which open notes go into a prompt. */
export type Scope = 'anim' | 'subject' | 'all';

/** The prompt for the open notes in `scope`, and those notes. */
export async function promptText(app: App, scope: Scope): Promise<{ text: string; notes: Note[] }> {
  const open = store.notes.filter((n) => n.status === 'open');
  const notes = open.filter((n) =>
    scope === 'all'
      ? true
      : scope === 'subject'
        ? n.subject === app.subject?.id
        : n.subject === app.subject?.id &&
          n.anim === app.anim?.id &&
          noteKey(n.subject, n.anim, n.options) === noteKey(n.subject, n.anim, app.keyed(n.subject, n.anim, app.options)),
  );
  // Whatever the notes are on has to be ready to describe (a made body loaded).
  for (const sid of new Set(notes.map((n) => n.subject))) {
    const s = subjectById(sid);
    for (const n of notes.filter((x) => x.subject === sid)) if (s?.ready) await s.ready(n.options, n.anim).catch(() => undefined);
  }
  const text = buildPrompt(notes, {
    subject: subjectById,
    take: (sid, aid, o) => {
      const s = subjectById(sid);
      return s ? app.takeOf(sid, aid, app.defaults(s, o)) : null;
    },
    image: (name) => store.image(name),
    reviewFile: store.dir ? `${store.dir}${store.dir.includes('\\') ? '\\' : '/'}review.json` : null,
    origin: location.origin,
  });
  return { text, notes };
}

export async function openPrompt(app: App): Promise<void> {
  if (app.notes.composer?.text.trim()) {
    toast('Keep or cancel the note you are writing first', 'warn');
    return;
  }
  await store.flush();
  let scope: Scope = store.count((n) => n.status === 'open') ? 'all' : 'anim';
  const area = h('textarea', { class: 'prompt-text', readonly: true, spellcheck: 'false' });
  const stats = h('div', { class: 'stats' });
  const seg = h('div', { class: 'seg' });
  const where = h('span', { class: 'grow' });
  let current: { text: string; notes: Note[] } = { text: '', notes: [] };
  const refresh = async () => {
    seg.replaceChildren(
      ...(
        [
          ['anim', 'This Animation'],
          ['subject', `All of ${app.subject?.name ?? 'This Character'}`],
          ['all', 'Everything Open'],
        ] as Array<[Scope, string]>
      ).map(([s, label]) =>
        h(
          'button',
          {
            class: s === scope ? 'on' : '',
            onclick: () => {
              scope = s;
              void refresh();
            },
          },
          label,
        ),
      ),
    );
    current = await promptText(app, scope);
    const n = current.notes;
    area.value = n.length
      ? current.text
      : 'No open notes here yet.\n\nLeave a note on the animation, on a stretch of frames, or correct a frame by moving its bones, then come back.';
    const fixes = n.filter((x) => x.fix).length;
    const anims = new Set(n.map((x) => `${x.subject}/${x.anim}`)).size;
    stats.replaceChildren(
      h('span', {}, h('b', {}, String(n.length)), ' notes'),
      h('span', {}, h('b', {}, String(fixes)), ' pose corrections'),
      h('span', {}, h('b', {}, String(anims)), ' animations'),
      h('span', {}, h('b', {}, `${Math.round(current.text.length / 1000)}k`), ' characters'),
    );
    copy.disabled = !n.length;
  };
  const copy = h('button', { class: 'btn primary', onclick: () => void doCopy() }, icon('copy'), 'Copy Prompt');
  const doCopy = async () => {
    const text = current.text;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      area.removeAttribute('readonly');
      area.select();
      ok = document.execCommand('copy');
      area.setAttribute('readonly', '');
    }
    const path = await store.savePrompt(text);
    const now = Date.now();
    for (const n of current.notes) store.update(n.id, { sent: now });
    where.textContent = path ? `Also saved to ${path}` : '';
    toast(ok ? 'Prompt copied: paste it to Claude' : 'Could not reach the clipboard: select the text and copy it', ok ? 'good' : 'warn', 3200);
  };
  modal({
    title: 'Create Prompt',
    sub: 'Everything Claude needs to fix the animations: what moves them and where, your notes, and your corrected poses in numbers and pictures.',
    body: h('div', {}, h('div', { style: 'display:flex;gap:10px;align-items:center;margin-bottom:10px' }, seg), area, stats),
    foot: [where, h('button', { class: 'btn', onclick: () => openAllNotes(app) }, icon('list'), 'All Notes'), copy],
  });
  await refresh();
}
