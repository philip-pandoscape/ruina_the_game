import { ICON, h, icon } from './dom';

// The library's page: the header (its name, where you are, the note count, Create Prompt and the
// keys), the list of everything on the left, the viewport in the middle with its bars over it and
// the transport and timeline under it, and the side panel's tabs on the right. Built once; the
// parts (panels/) fill the elements this returns.

/** The elements the parts fill and change. */
export interface Layout {
  crumbs: HTMLElement;
  count: HTMLButtonElement;
  libBody: HTMLDivElement;
  viewport: HTMLDivElement;
  views: HTMLDivElement;
  toggles: HTMLDivElement;
  hud: HTMLDivElement;
  legend: HTMLDivElement;
  banner: HTMLDivElement;
  loading: HTMLDivElement;
  toasts: HTMLDivElement;
  tbar: HTMLDivElement;
  tabs: HTMLDivElement;
  pane: HTMLDivElement;
  frameInput: HTMLInputElement;
}

/** What the header's buttons and the search box do. */
export interface LayoutActions {
  prompt(): void;
  help(): void;
  allNotes(): void;
  /** The search box changed: what it holds, trimmed and in lower case. */
  search(q: string): void;
}

/** Builds the page in `host`, with the timeline (`timeline`) under the viewport. */
export function layout(host: HTMLElement, timeline: HTMLElement, on: LayoutActions): Layout {
  const el: Layout = {
    crumbs: h('nav', { class: 'crumbs' }),
    count: h('button', { class: 'pill-count', title: 'Every note, on every animation' }),
    libBody: h('div', { class: 'lib-body' }),
    viewport: h('div', { class: 'viewport' }),
    views: h('div', { class: 'views glass' }),
    toggles: h('div', { class: 'toggles glass' }),
    hud: h('div', { class: 'hud glass' }),
    legend: h('div', { class: 'legend glass' }),
    banner: h('div', { class: 'banner' }),
    loading: h('div', { class: 'loading' }),
    toasts: h('div', { class: 'toast-host' }),
    tbar: h('div', { class: 'tbar' }),
    tabs: h('div', { class: 'tabs' }),
    pane: h('div', { class: 'pane' }),
    frameInput: h('input', { type: 'text', spellcheck: 'false', title: 'Go to frame' }),
  };
  const top = h(
    'header',
    { class: 'top' },
    h('div', { class: 'brand' }, h('span', { class: 'logo', html: ICON.play }), 'Content Library', h('small', {}, 'Ruina')),
    el.crumbs,
    h('div', { class: 'spacer' }),
    h(
      'div',
      { class: 'top-actions' },
      el.count,
      h(
        'button',
        { class: 'btn primary', title: 'Turn the open notes into a prompt for Claude (Ctrl+Enter)', onclick: () => on.prompt() },
        icon('spark'),
        'Create Prompt',
      ),
      h('button', { class: 'icon-btn', title: 'Keyboard shortcuts (?)', onclick: () => on.help() }, icon('help')),
    ),
  );
  const search = h('input', { type: 'search', placeholder: 'Search the library', spellcheck: 'false' });
  search.addEventListener('input', () => on.search(search.value.trim().toLowerCase()));
  const lib = h('aside', { class: 'library' }, h('div', { class: 'search' }, search), el.libBody);
  el.viewport.append(
    h('div', { class: 'vp-bar vp-tl' }, el.views),
    h('div', { class: 'vp-bar vp-tr' }, el.toggles),
    h('div', { class: 'vp-bar vp-bl' }, el.legend, el.hud),
    el.banner,
    el.loading,
    el.toasts,
  );
  const transport = h('div', { class: 'transport' }, el.tbar, timeline);
  const center = h('main', { class: 'center' }, el.viewport, transport);
  const side = h('aside', { class: 'side' }, el.tabs, el.pane);
  host.append(top, lib, center, side);
  el.count.onclick = () => on.allNotes();
  return el;
}
