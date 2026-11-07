import type { App, Tab } from '../app';
import { fmtTime, h, toast } from '../dom';
import { linkTo } from '../prompt';

// The side panel: its tabs (Notes, Pose and About for something that moves; About and Numbers for a
// gallery's entry), the About tab (what this is, how it is made and where, the frame's state in
// full) and a gallery's Numbers (as it reports them, with its buttons). The Notes and Pose tabs
// draw themselves (notesTab.ts, poseTab.ts).

export class Side {
  constructor(private readonly app: App) {}

  /** The tab strip, and the tab that is open. */
  render(): void {
    const app = this.app;
    const notes = app.notes.here().filter((n) => n.status === 'open').length;
    const tab = (t: Tab, label: string, extra?: HTMLElement | null) =>
      h(
        'button',
        {
          class: app.tab === t ? 'on' : '',
          onclick: () => {
            app.tab = t;
            this.render();
          },
        },
        label,
        extra ?? null,
      );
    if (app.gallery)
      app.el.tabs.replaceChildren(
        ...[tab('about', 'About'), app.gallery.numbers ? tab('numbers', 'Numbers') : null].filter((x): x is HTMLButtonElement => !!x),
      );
    else
      app.el.tabs.replaceChildren(
        tab('notes', 'Notes', notes ? h('span', { class: 'badge' }, String(notes)) : null),
        tab('pose', 'Pose', app.editor.active ? h('span', { class: 'badge fix' }, '●') : null),
        tab('about', 'About'),
      );
    if (app.tab === 'notes') app.notesTab.render();
    else if (app.tab === 'pose') app.poseTab.render();
    else if (app.tab === 'numbers') this.renderNumbers();
    else this.renderAbout();
  }

  /** A gallery entry's numbers (triangles and sizes, joints and costs), as it reports them. */
  renderNumbers(): void {
    const app = this.app;
    if (app.tab !== 'numbers') return;
    const pane = app.el.pane;
    const scroll = pane.scrollTop;
    pane.replaceChildren();
    const acts = app.gallery?.actions?.() ?? [];
    if (acts.length)
      pane.append(
        h(
          'div',
          { class: 'tools' },
          ...acts.map((a) =>
            h(
              'button',
              {
                class: 'btn small',
                onclick: async () => {
                  toast(`${a.label}…`);
                  await a.run();
                  this.renderNumbers();
                },
              },
              a.label,
            ),
          ),
        ),
      );
    for (const t of app.gallery?.numbers?.() ?? [])
      pane.append(h('h3', {}, t.heading), h('dl', { class: 'kv' }, ...t.rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
    pane.scrollTop = scroll;
  }

  renderAbout(): void {
    const app = this.app;
    if (app.tab !== 'about') return;
    const pane = app.el.pane;
    pane.replaceChildren();
    const take = app.take;
    const s = app.subject;
    const a = app.anim;
    if (!s || !a) return;
    const src = s.source(app.options);
    const link = h(
      'button',
      {
        class: 'link',
        onclick: () =>
          void navigator.clipboard
            .writeText(linkTo(location.origin, s.id, a.id, app.address.liveOptions(), take ? app.frame : undefined))
            .then(() => toast('Link copied', 'good')),
      },
      take ? 'Copy a link to this frame' : 'Copy a link to this',
    );
    const how = [
      h('h3', { style: 'margin-top:16px' }, `How ${s.name} ${take ? 'Moves' : 'Is Made'}`),
      h('p', { class: 'about-text' }, src.system),
      h('ul', { class: 'files' }, ...src.files.map((f) => h('li', {}, h('code', {}, f.path), h('span', {}, f.what)))),
      src.conventions ? h('h3', {}, 'Conventions') : null,
      src.conventions ? h('p', { class: 'about-text' }, src.conventions) : null,
    ].filter((x): x is NonNullable<typeof x> => !!x);
    if (!take) {
      pane.append(
        h('h3', {}, 'This One'),
        h(
          'dl',
          { class: 'kv' },
          h('dt', {}, 'Name'),
          h('dd', {}, `${a.label} (${a.id})`),
          h('dt', {}, 'Made by'),
          h('dd', {}, s.animSource(a.id, app.options)),
          h('dt', {}, 'Link'),
          h('dd', {}, link),
        ),
        ...how,
      );
      return;
    }
    const info = app.frame < take.baked ? take.info(app.frame) : null;
    pane.append(
      h('h3', {}, 'This Animation'),
      h(
        'dl',
        { class: 'kv' },
        h('dt', {}, 'Name'),
        h('dd', {}, `${a.label} (${a.id})`),
        h('dt', {}, 'Length'),
        h('dd', {}, `${take.frames} frames at ${take.fps} fps · ${fmtTime(take.frames, take.fps)}${take.loop ? ' · loops' : ''}`),
        h('dt', {}, 'Made by'),
        h('dd', {}, s.animSource(a.id, app.options)),
        h('dt', {}, 'Bones'),
        h('dd', {}, `${take.bones.length} (${take.bones.filter((b) => !b.minor && !b.name.startsWith('@')).length} drawn)`),
        h('dt', {}, 'Link'),
        h('dd', {}, link),
      ),
      h('h3', {}, `Frame ${app.frame}`),
      info ? h('pre', { class: 'detail' }, `${info.line}\n\n${JSON.stringify(info.detail ?? {}, null, 1)}`) : h('p', { class: 'muted' }, 'Working it out…'),
      ...how,
    );
  }
}
