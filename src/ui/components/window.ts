import { esc } from '../../util/html';
import { closeMenu } from '../theme/contextMenu';
import { hideTip, tipFor } from '../theme/tooltip';
import { el } from './dom';

// A window (design/ui.html: Windows): a wood frame with a title strip (the title, then a short
// subtitle), a close button, a body that scrolls (a drawn scrollbar and a fade when its text runs
// past the foot) and a foot holding the actions. Someone you talk to looks out of a portrait
// medallion over its top left corner. What a window shows is a View: its buttons and items say
// what they do in data-act (and data-arg), and the View's handlers do it on a click, its menus on
// a right-click (the menus themselves: src/ui/theme/contextMenu.ts). Anything in it with a
// data-tip has a tooltip (src/ui/theme/tooltip.ts), shown for a controller's highlight too.

/** What a click on something in a window does: `arg` is its data-arg. */
export type Handler = (arg: string, e: MouseEvent | null) => void;

/** What a right-click on something in a window does (opens its menu): `arg` is its data-arg. */
export type MenuHandler = (arg: string, target: HTMLElement, e: MouseEvent) => void;

/** What a window shows. */
export interface View {
  /** The title strip's text. */
  title: string;
  /** A short subtitle after the title (HTML). */
  sub?: string;
  /** Whoever looks out of the medallion over the top left corner (HTML). */
  portrait?: string;
  body: string;
  /** The actions along the bottom (HTML). */
  foot?: string;
  /** Where it docks and what kind of window it is: `left` unless it says (`center map`...). */
  cls?: string;
  /** Its width in the UI's virtual px, and its height unless it is as tall as what it holds. */
  w: number;
  h?: number;
  /** What a click on each data-act does. */
  handlers?: Record<string, Handler>;
  /** What a right-click on each data-act does. */
  menus?: Record<string, MenuHandler>;
}

/**
 * The frame round what a window shows: the medallion, the title strip, the close button (its key
 * in its tooltip, `closeKey`), the body (`bodyStyle` its inline style) and the foot.
 */
export function frameHtml(v: Pick<View, 'title' | 'sub' | 'portrait' | 'body' | 'foot'>, o: { closeKey?: string; bodyStyle?: string } = {}): string {
  return (
    (v.portrait ? `<div class="mw-portrait">${v.portrait}</div>` : '') +
    `<div class="mw-bar">${esc(v.title)}${v.sub ? ` <small>${v.sub}</small>` : ''}</div><div class="mw-x" data-act="close" title="Close (${o.closeKey ?? 'Esc'})">✕</div>` +
    `<div class="mw-body"${o.bodyStyle ? ` style="${o.bodyStyle}"` : ''}>${v.body}</div>${v.foot ? `<div class="mw-foot">${v.foot}</div>` : ''}`
  );
}

/**
 * A window docked at a side of the screen (or in its middle): its element, hidden until it shows
 * something, doing what its View says when something in it is clicked or right-clicked, with a
 * highlight a controller moves over what can be pressed.
 */
export class DockedWindow {
  readonly el: HTMLDivElement;
  private handlers: Record<string, Handler> = {};
  private menus: Record<string, MenuHandler> = {};

  /** `name` is its own class (`lui-card`), `dock` where it docks until a View says (`left`); `onClose` is its close button's. */
  constructor(
    private name: string,
    dock: string,
    private onClose: () => void,
  ) {
    this.el = el('div', `${name} mw ${dock}`);
    this.el.hidden = true;
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('contextmenu', (e) => this.onMenu(e));
  }

  /**
   * Draws a View in it, sized and docked as the View says: a fresh one from its top, otherwise
   * (`fresh` false) scrolled where it was. `fill` adds to the body what isn't HTML (the map's canvas).
   */
  render(v: View, fresh: boolean, fill?: (body: HTMLElement) => void): void {
    const old = this.el.querySelector('.mw-body');
    const keep = !fresh && old ? old.scrollTop : 0;
    this.el.className = `${this.name} mw ${v.cls ?? 'left'}${v.portrait ? ' has-portrait' : ''}`;
    this.el.style.width = `${v.w}px`;
    this.el.style.height = v.h ? `${v.h}px` : '';
    this.fill(frameHtml(v), v.handlers, v.menus);
    const body = this.el.querySelector('.mw-body') as HTMLElement;
    fill?.(body);
    body.scrollTop = keep;
    body.addEventListener('scroll', () => this.drawScroll());
    this.drawScroll();
  }

  /** Puts `html` in it, with what clicks and right-clicks on its data-acts do. */
  fill(html: string, handlers: Record<string, Handler> = {}, menus: Record<string, MenuHandler> = {}): void {
    this.el.innerHTML = html;
    this.handlers = handlers;
    this.menus = menus;
  }

  show(): void {
    this.el.hidden = false;
  }

  /** Hides and empties it, with the tooltip and any menu open over it. */
  hide(): void {
    this.el.hidden = true;
    this.el.innerHTML = '';
    this.handlers = {};
    this.menus = {};
    hideTip();
    closeMenu();
  }

  /** What a controller's highlight moves over: everything in it that does something, but its close button. */
  focusables(): HTMLElement[] {
    return [...this.el.querySelectorAll<HTMLElement>('[data-act]:not([disabled]):not(.mw-x)')];
  }

  /** Highlights the `i`th of those (-1: none), scrolled into view, with its tooltip. */
  highlight(i: number): void {
    const all = this.focusables();
    all.forEach((b, k) => b.classList.toggle('lui-focus', k === i));
    const b = all[i];
    if (b) {
      b.scrollIntoView({ block: 'nearest' });
      tipFor(b);
    }
  }

  private onClick(e: MouseEvent): void {
    const b = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!b || b.hasAttribute('disabled')) return;
    e.stopPropagation();
    const act = b.dataset.act!;
    if (act === 'close') return this.onClose();
    this.handlers[act]?.(b.dataset.arg ?? '', e);
  }

  private onMenu(e: MouseEvent): void {
    e.preventDefault();
    const b = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!b) return;
    this.menus[b.dataset.act ?? '']?.(b.dataset.arg ?? '', b, e);
  }

  /** A drawn scrollbar and a fade, when the body's text runs past its foot. */
  private drawScroll(): void {
    const w = this.el;
    for (const x of w.querySelectorAll('.mw-track, .mw-fade')) x.remove();
    const body = w.querySelector('.mw-body') as HTMLElement | null;
    if (!body || body.scrollHeight <= body.clientHeight + 2) return;
    const top = body.offsetTop + 8;
    const hgt = body.clientHeight - 16;
    const thumb = Math.max(36, (hgt * body.clientHeight) / body.scrollHeight);
    const pos = ((hgt - thumb) * body.scrollTop) / (body.scrollHeight - body.clientHeight);
    const track = el('div', 'mw-track', `<i style="top:${pos}px;height:${thumb}px"></i>`);
    track.style.top = `${top}px`;
    track.style.height = `${hgt}px`;
    w.append(track);
    if (body.scrollTop + body.clientHeight < body.scrollHeight - 4) {
      const f = el('div', 'mw-fade');
      f.style.top = `${body.offsetTop + body.clientHeight - 46}px`;
      w.append(f);
    }
    if (body.scrollTop > 4) {
      const f = el('div', 'mw-fade up');
      f.style.top = `${body.offsetTop}px`;
      w.append(f);
    }
  }
}
