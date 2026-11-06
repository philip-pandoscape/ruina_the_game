import type { App } from '../app';
import { fmtTime, h, icon } from '../dom';
import { store } from '../store';
import { GROUP_ORDER, SUBJECTS } from '../subjects';
import { thumbnails } from '../thumbs';
import type { AnimDef, Options, Subject } from '../types';

// The list on the left: everything the library shows, by group, with a portrait and its open notes;
// once one is open, its options and its animations (or a gallery's entries); and what matches a
// search, subjects and animations alike.

export class Browser {
  /** Every subject, or the open subject's options and animations. */
  view: 'subjects' | 'anims' = 'subjects';
  /** What the search box holds, in lower case. */
  search = '';
  private thumbs = new Map<string, string>();

  constructor(private readonly app: App) {}

  /** Thumbnails for the list, made in the background (of what moves: a gallery shows its initial). */
  async makeThumbs(): Promise<void> {
    await thumbnails(SUBJECTS, (id, url) => this.setThumb(id, url));
  }

  setThumb(id: string, url: string): void {
    this.thumbs.set(id, url);
    this.render();
  }

  private thumb(subject: Subject): HTMLElement {
    const url = this.thumbs.get(subject.id);
    return h('div', { class: 'thumb' }, url ? h('img', { src: url, alt: '' }) : subject.name.slice(0, 1));
  }

  render(): void {
    const app = this.app;
    const body = app.el.libBody;
    const scroll = body.scrollTop;
    body.replaceChildren();
    const q = this.search;
    if (q) {
      // Everything that matches, characters and animations alike.
      let any = false;
      for (const s of SUBJECTS) {
        const o = s.id === app.subject?.id ? app.options : app.defaults(s);
        const hitsSubject = `${s.name} ${s.blurb} ${s.group}`.toLowerCase().includes(q);
        const anims = s.anims(o).filter((a) => hitsSubject || `${a.label} ${a.id} ${a.group}`.toLowerCase().includes(q));
        if (!anims.length) continue;
        any = true;
        body.append(h('div', { class: 'lib-group' }, s.name));
        for (const a of anims.slice(0, 40)) body.append(this.animRow(s, a, o, true));
      }
      if (!any) body.append(h('div', { class: 'empty' }, 'Nothing by that name.'));
      return;
    }
    if (this.view === 'subjects' || !app.subject) {
      for (const group of GROUP_ORDER) {
        const list = SUBJECTS.filter((s) => s.group === group);
        if (!list.length) continue;
        body.append(h('div', { class: 'lib-group' }, group));
        for (const s of list) {
          const open = store.count((n) => n.subject === s.id && n.status === 'open');
          body.append(
            h(
              'button',
              {
                class: `subject${s.id === app.subject?.id ? ' on' : ''}`,
                onclick: () => void app.open(s.id, null, s.id === app.subject?.id ? app.options : {}),
              },
              this.thumb(s),
              h(
                'div',
                { class: 'meta' },
                h('div', { class: 'name' }, s.name, open ? h('span', { class: 'badge' }, String(open)) : null),
                h('div', { class: 'blurb' }, s.blurb),
              ),
              h('span', { class: 'count', title: 'Animations' }, String(s.anims(app.defaults(s)).length)),
            ),
          );
        }
      }
      return;
    }
    const s = app.subject;
    body.append(
      h('button', { class: 'back', onclick: () => ((this.view = 'subjects'), this.render()) }, icon('back'), 'Everything'),
      h('div', { class: 'subject-head' }, this.thumb(s), h('div', {}, h('h2', {}, s.name), h('p', {}, s.blurb))),
    );
    if (s.options.length) {
      const opts = h('div', { class: 'opts' });
      // An option this animation doesn't use (a film with a weapon of its own) is shown but greyed.
      const used = app.anim && s.optionsFor ? Object.keys(s.optionsFor(app.anim.id, app.options)) : null;
      const set = (id: string, value: string) => void app.open(s.id, app.anim?.id ?? null, { ...app.options, [id]: value }, app.frame, { keepCamera: true });
      for (const o of s.options) {
        const idle = used !== null && !used.includes(o.id);
        let field: HTMLElement;
        if (o.choices)
          field = h(
            'div',
            { class: 'seg' },
            ...o.choices.map((c) => h('button', { class: app.options[o.id] === c.value ? 'on' : '', onclick: () => set(o.id, c.value) }, c.label)),
          );
        else {
          // A value of its own: typed in, kept on Enter (or leaving the box).
          const input = h('input', { type: 'text', class: 'opt-text', spellcheck: 'false', placeholder: o.hint ?? '', value: app.options[o.id] ?? '' });
          const keep = () => input.value.trim() !== (app.options[o.id] ?? '') && set(o.id, input.value.trim());
          input.onkeydown = (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') keep();
          };
          input.onchange = keep;
          field = input;
        }
        opts.append(
          h(
            'div',
            { class: `opt${idle ? ' idle' : ''}`, title: idle ? `${app.anim?.label} has its own ${o.label.toLowerCase()}` : '' },
            h(
              'label',
              {},
              o.label,
              idle ? h('span', { class: 'muted', style: 'text-transform:none;letter-spacing:0;font-weight:400' }, ' · this one has its own') : null,
            ),
            field,
          ),
        );
      }
      body.append(opts);
    }
    let group = '';
    for (const a of s.anims(app.options)) {
      if (a.group !== group) {
        group = a.group;
        body.append(h('div', { class: 'lib-group' }, group));
      }
      body.append(this.animRow(s, a, app.options, false));
    }
    body.scrollTop = scroll;
  }

  private animRow(s: Subject, a: AnimDef, o: Options, showOwner: boolean): HTMLElement {
    const app = this.app;
    const notes = store.forAnim(s.id, a.id, app.keyed(s.id, a.id, o)).filter((n) => n.status === 'open');
    const fixes = notes.filter((n) => n.fix).length;
    const on = s.id === app.subject?.id && a.id === app.anim?.id;
    return h(
      'button',
      { class: `anim${on ? ' on' : ''}`, onclick: () => void app.open(s.id, a.id, o, 0, { keepCamera: s.id === app.subject?.id }), title: a.note ?? '' },
      h('span', { class: 'label' }, a.label, showOwner ? h('span', { class: 'owner' }, ` · ${s.name}`) : null),
      notes.length ? h('span', { class: `badge${fixes ? ' fix' : ''}` }, String(notes.length)) : null,
      h('span', { class: 'len' }, a.tag ?? fmtTime(a.frames, a.fps)),
    );
  }
}
