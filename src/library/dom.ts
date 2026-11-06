// Small DOM helpers for the library's panels: elements, icons, toasts and modal windows.

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | null | undefined>;

/** An element with attributes (on* are listeners, class/className a class) and children. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Array<Child | Child[]>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class' || k === 'className') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const svg = (body: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICON = {
  play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/></svg>`,
  first: svg('<path d="M6 5v14M18 6l-8 6 8 6z"/>'),
  last: svg('<path d="M18 5v14M6 6l8 6-8 6z"/>'),
  prev: svg('<path d="m15 6-6 6 6 6"/>'),
  next: svg('<path d="m9 6 6 6-6 6"/>'),
  loop: svg('<path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>'),
  bones: svg('<circle cx="6" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="18" cy="19" r="2"/><path d="m7.4 6.4 3.2 4.2M13.4 13.4l3.2 4.2"/>'),
  onion: svg('<circle cx="9" cy="12" r="6" opacity=".45"/><circle cx="15" cy="12" r="6"/>'),
  trails: svg('<path d="M3 17c4-9 8-9 9-4s5 5 9-4"/><circle cx="21" cy="9" r="1.5" fill="currentColor"/>'),
  ghost: svg('<path d="M5 21V10a7 7 0 0 1 14 0v11l-3-2-2 2-2-2-2 2-2-2z"/><circle cx="9.5" cy="10" r="1" fill="currentColor"/><circle cx="14.5" cy="10" r="1" fill="currentColor"/>'),
  frame: svg('<rect x="9" y="3" width="6" height="18" rx="1.5"/>'),
  range: svg('<path d="M4 4v16M20 4v16M4 12h16"/><path d="m8 9-3 3 3 3M16 9l3 3-3 3"/>'),
  film: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M17 9h4M3 15h4M17 15h4"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7"/>'),
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
  redo: svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>'),
  rotate: svg('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>'),
  move: svg('<path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3"/>'),
  scale: svg('<path d="M4 14v6h6M20 10V4h-6M4 20l7-7M20 4l-7 7"/>'),
  reset: svg('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/>'),
  back: svg('<path d="m15 18-6-6 6-6"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  copy: svg('<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>'),
  spark: svg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>'),
  target: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01"/>'),
  camera: svg('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  list: svg('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
};

export function icon(name: keyof typeof ICON): HTMLElement {
  const s = document.createElement('span');
  s.style.display = 'contents';
  s.innerHTML = ICON[name];
  return s;
}

let toastHost: HTMLElement | null = null;
export function setToastHost(el: HTMLElement): void {
  toastHost = el;
}

/** A message that fades after a few seconds. */
export function toast(text: string, kind: 'good' | 'warn' | '' = '', ms = 2600): void {
  if (!toastHost) return;
  const t = h('div', { class: `toast ${kind}` }, text);
  toastHost.append(t);
  setTimeout(() => {
    t.style.transition = 'opacity 0.3s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 320);
  }, ms);
}

/** A modal window; returns a function that closes it. Escape and a click outside close it too. */
export function modal(opts: { title: string; sub?: string; body: Node; foot?: Node[]; narrow?: boolean; onClose?: () => void }): () => void {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    scrim.remove();
    window.removeEventListener('keydown', onKey, true);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      close();
    }
  };
  const x = h('button', { class: 'icon-btn x', title: 'Close (Esc)', onclick: close }, icon('close'));
  const box = h(
    'div',
    { class: `modal${opts.narrow ? ' narrow' : ''}`, role: 'dialog' },
    h('header', {}, h('div', {}, h('h2', {}, opts.title), opts.sub ? h('div', { class: 'sub' }, opts.sub) : null), x),
    h('div', { class: 'body' }, opts.body),
    opts.foot ? h('footer', {}, ...opts.foot) : null,
  );
  const scrim: HTMLDivElement = h('div', { class: 'scrim', onmousedown: (e: Event) => e.target === scrim && close() }, box);
  document.body.append(scrim);
  window.addEventListener('keydown', onKey, true);
  return close;
}

export const fmtTime = (frames: number, fps: number): string => `${(frames / fps).toFixed(2)} s`;
