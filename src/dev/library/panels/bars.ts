import type { App } from '../app';
import { ICON, fmtTime, h, icon } from '../dom';
import type { Prefs } from '../prefs';
import { SPEEDS, savePrefs } from '../prefs';
import { VIEWS } from '../stage';
import { store } from '../store';
import { PHASE_COLOURS } from '../timeline';

// The bars round the picture: where you are (the crumbs) and the open notes in the header; the
// views and the toggles over the picture with the legend of what's drawn on it; the readout of the
// frame on screen; the banner while a pose is being corrected; and the transport under it (the
// frame, the speed, the picked stretch, and starting a note or a correction).

export class Bars {
  /** What the legend last showed, so it is drawn again only when that changes. */
  private legendKey = '';

  constructor(private readonly app: App) {}

  renderCrumbs(): void {
    const app = this.app;
    const c = app.el.crumbs;
    c.replaceChildren();
    if (!app.subject || !app.anim) {
      c.append(h('span', {}, 'Pick something'));
      return;
    }
    const optWords = app.subject.options
      .map((o) => (o.choices ? o.choices.find((x) => x.value === app.options[o.id])?.label : app.options[o.id] ? `${o.label} ${app.options[o.id]}` : ''))
      .filter(Boolean)
      .join(' · ');
    const frames = app.take?.frames ?? app.anim.frames;
    const fps = app.take?.fps ?? app.anim.fps;
    c.append(
      ...[
        h('span', { class: 'sep' }, '/'),
        h('span', {}, app.subject.name),
        h('span', { class: 'sep' }, '/'),
        h('b', {}, app.anim.label),
        optWords ? h('span', { class: 'tag' }, optWords) : null,
        h('span', { class: 'tag' }, app.gallery ? (app.anim.tag ?? '') : `${frames} f · ${fmtTime(frames, fps)}`),
      ].filter((x): x is HTMLElement => !!x && !!x.textContent),
    );
  }

  renderCount(): void {
    const el = this.app.el.count;
    const open = store.count((n) => n.status === 'open');
    const fixes = store.count((n) => n.status === 'open' && !!n.fix);
    el.className = `pill-count${open ? '' : ' none'}`;
    el.replaceChildren(
      h('span', { class: 'dot' }),
      open ? `${open} open ${open === 1 ? 'note' : 'notes'}${fixes ? `, ${fixes} with poses` : ''}` : 'No open notes',
    );
  }

  renderViewBar(): void {
    const app = this.app;
    app.el.views.replaceChildren(
      ...VIEWS.map((v) =>
        h(
          'button',
          {
            class: app.stage.view === v.id ? 'on' : '',
            title: `${v.label} (${v.key})`,
            onclick: () => app.setView(v.id),
          },
          v.label.replace('Three-Quarter', '¾'),
        ),
      ),
    );
    const t = (key: keyof Prefs, ic: keyof typeof ICON, title: string) =>
      h(
        'button',
        {
          class: `icon-btn${app.prefs[key] ? ' on' : ''}`,
          title,
          onclick: () => app.togglePref(key),
        },
        icon(ic),
      );
    app.el.toggles.replaceChildren(
      t('skeleton', 'bones', 'Skeleton (K)'),
      t('onion', 'onion', 'Onion skin: the frames before (blue) and after (orange) (O)'),
      t('trails', 'trails', 'Paths of the hands, feet and blade through the whole animation (J)'),
      t('ghosts', 'ghost', 'Corrected poses as green ghosts on their frames (G)'),
      t('swoosh', 'spark', 'The swoosh a swing draws in the game (W)'),
      t('outdoors', 'sun', 'Outdoors: on grass under the sky (B)'),
      h(
        'button',
        {
          class: `icon-btn${app.sheet.active ? ' on' : ''}`,
          title: 'Contact sheet: eight frames side by side, of the picked stretch or the whole (H)',
          onclick: () => (app.sheet.active ? app.playback.endSheet() : app.playback.showSheet()),
        },
        icon('film'),
      ),
    );
    const legend: HTMLElement[] = [];
    if (app.prefs.onion)
      legend.push(h('span', {}, h('i', { style: 'background:#58a6ff' }), 'Before'), h('span', {}, h('i', { style: 'background:#ffa94d' }), 'After'));
    if (app.prefs.ghosts && !app.editor.active && app.notes.here().some((n) => n.fix && n.frame === app.frame))
      legend.push(h('span', {}, h('i', { style: 'background:#3ddc97' }), 'Your correction'));
    if (app.editor.active) legend.push(h('span', {}, h('i', { style: 'background:#9aa4b2' }), 'As it was'));
    app.el.legend.replaceChildren(...legend);
    app.el.legend.style.display = legend.length ? '' : 'none';
  }

  renderTransport(): void {
    const app = this.app;
    const take = app.take;
    const play = app.playback;
    const b = (ic: keyof typeof ICON, title: string, on: () => void, cls = '') => h('button', { class: `icon-btn ${cls}`, title, onclick: on }, icon(ic));
    const speed = h('select', { class: 'speed', title: 'Speed (, and .)' });
    for (const s of SPEEDS) speed.add(new Option(`${s}×`, String(s), false, s === app.prefs.speed));
    speed.onchange = () => {
      app.prefs.speed = Number(speed.value);
      savePrefs(app.prefs);
    };
    const input = app.el.frameInput;
    input.value = String(app.frame);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        play.seek(Number(input.value) || 0);
        input.blur();
      }
      e.stopPropagation();
    };
    app.el.tbar.replaceChildren(
      b('first', 'First frame (Home)', () => play.seek(app.range ? app.range[0] : 0)),
      b('prev', 'Back a frame (←, Shift: 10)', () => play.step(-1)),
      h(
        'button',
        { class: 'icon-btn', title: 'Play / pause (Space)', onclick: () => play.toggle(), style: 'width:38px' },
        icon(app.playing ? 'pause' : 'play'),
      ),
      b('next', 'On a frame (→, Shift: 10)', () => play.step(1)),
      b('last', 'Last frame (End)', () => play.seek(app.range ? app.range[1] : (take?.frames ?? 1) - 1)),
      b('loop', 'Loop (L)', () => app.togglePref('loop'), app.prefs.loop ? 'on' : ''),
      speed,
      h(
        'div',
        { class: 'framebox' },
        'Frame',
        input,
        h('span', {}, `/ ${take ? take.frames - 1 : 0}`),
        h('span', { class: 'muted' }, take ? `${(app.frame / take.fps).toFixed(2)} s` : ''),
      ),
      app.range
        ? h(
            'span',
            { class: 'range-chip', title: 'The picked stretch: playback loops inside it' },
            `${app.range[0]}–${app.range[1]} (${app.range[1] - app.range[0] + 1} f)`,
            h('button', { title: 'Clear (Esc)', onclick: () => play.setRange(null) }, '✕'),
          )
        : h('span', { class: 'muted hint-range' }, 'Shift-drag to pick a stretch'),
      h('div', { class: 'grow' }),
      h('button', { class: 'btn small', title: 'Note on this frame (N)', onclick: () => app.notes.compose('frame') }, icon('frame'), 'Note Frame'),
      h(
        'button',
        { class: 'btn small', title: 'Note on the picked stretch (N with a stretch picked)', onclick: () => app.notes.compose('range'), disabled: !app.range },
        icon('range'),
        'Note Range',
      ),
      h(
        'button',
        {
          class: `btn small${app.editor.active ? ' primary' : ''}`,
          title: 'Correct this frame by moving its bones (P)',
          onclick: () => (app.editor.active ? void app.posing.save() : app.posing.enter()),
        },
        icon('edit'),
        app.editor.active ? 'Save Correction' : 'Correct Pose',
      ),
    );
  }

  /** The readout of the frame on screen: its number and time, what the animation is doing, what drives it. */
  renderHud(): void {
    const app = this.app;
    const fixHere = app.notes.here().some((n) => n.fix && n.frame === app.frame);
    const key = `${fixHere}|${app.editor.active}|${app.prefs.onion}|${app.prefs.ghosts}`;
    if (key !== this.legendKey) {
      this.legendKey = key;
      this.renderViewBar();
    }
    const take = app.take;
    if (!take) {
      app.el.hud.textContent = '';
      return;
    }
    if (app.el.frameInput !== document.activeElement) app.el.frameInput.value = String(app.frame);
    const info = app.frame < take.baked ? take.info(app.frame) : { line: 'working it out…' };
    const phase = take.phases.find((p) => app.frame >= p.from && app.frame <= p.to);
    app.el.hud.replaceChildren(
      h('b', {}, `f ${app.frame}`),
      ` · ${(app.frame / take.fps).toFixed(2)} s · `,
      phase ? h('span', { style: `color:${PHASE_COLOURS[phase.kind] ?? '#fff'}` }, phase.label) : '',
      // The state in words, unless it only says what the band does.
      info.line.toLowerCase() === phase?.label.toLowerCase() ? '' : phase ? ' · ' : '',
      info.line.toLowerCase() === phase?.label.toLowerCase() ? '' : h('span', { class: 'state' }, info.line),
    );
    for (const label of app.el.pane.querySelectorAll<HTMLElement>('[data-frame-label]'))
      label.textContent = `${label.dataset.frameLabel || 'Frame'} ${app.frame}`;
    const timeEl = app.el.tbar.querySelector('.framebox .muted');
    if (timeEl) timeEl.textContent = `${(app.frame / take.fps).toFixed(2)} s`;
  }

  /** The banner over the picture while a pose is being corrected. */
  renderBanner(): void {
    const app = this.app;
    const b = app.el.banner;
    if (!app.editor.active) {
      b.style.display = 'none';
      return;
    }
    b.style.display = '';
    const n = app.editor.touched.size;
    b.replaceChildren(
      h('span', { class: 'what' }, `Correcting frame ${app.frame}`),
      h('span', { class: 'hint' }, app.editor.selected ? `${app.editor.selected.name} · R turn · G move · S scale · Ctrl+Z undo` : 'Click a joint to pick it'),
      h('button', { class: 'btn small ghost', onclick: () => app.posing.discard() }, 'Discard'),
      h(
        'button',
        { class: 'btn small primary', onclick: () => void app.posing.save(), disabled: !n },
        icon('check'),
        n ? `Save Correction (${n})` : 'Save Correction',
      ),
    );
  }
}
