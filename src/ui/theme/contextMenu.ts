// Right-click menus: what you can do with the thing under the pointer, its main action first and in
// bold (that one is also what a double-click does). One menu at a time; it closes on a choice, a
// click anywhere else, Escape, or the window losing focus. The look is in theme.css (.ctx).
import { toUi, uiRoot, uiSize } from './scale';
import { hideTip } from './tooltip';

export interface MenuEntry {
  /** In Title Case, like every label (design/ui.html). */
  label: string;
  run?: () => void;
  /** The main action: listed first, in bold, and what a double-click does. */
  primary?: boolean;
  /** Why it can't be done right now: the entry is shown greyed out with this under it. */
  disabled?: string;
}

let menu: HTMLDivElement | null = null;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Opens a menu titled `title` at a point on screen (CSS px, as a mouse event gives it). */
export function openMenu(clientX: number, clientY: number, title: string, entries: MenuEntry[]): void {
  closeMenu();
  hideTip();
  const m = document.createElement('div');
  m.className = 'ctx';
  m.setAttribute('role', 'menu');
  const sorted = [...entries.filter((e) => e.primary), ...entries.filter((e) => !e.primary)];
  m.innerHTML =
    `<div class="ctx-h">${esc(title)}</div>` +
    (sorted.length ? '' : '<div class="ctx-none">Nothing to do with it here</div>') +
    sorted
      .map(
        (e, i) =>
          `<button type="button" role="menuitem" class="ctx-i${e.primary ? ' primary' : ''}" data-i="${i}"${e.disabled ? ' disabled' : ''}>${esc(e.label)}${e.disabled ? `<small>${esc(e.disabled)}</small>` : ''}</button>`,
      )
      .join('');
  m.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest('[data-i]') as HTMLButtonElement | null;
    if (!b || b.disabled) return;
    ev.stopPropagation();
    const e = sorted[Number(b.dataset.i)];
    closeMenu();
    e?.run?.();
  });
  m.addEventListener('contextmenu', (ev) => ev.preventDefault());
  uiRoot().append(m);
  menu = m;
  // Beside the pointer, kept on screen.
  const at = toUi(clientX, clientY);
  const { width, height } = uiSize();
  const x = Math.max(6, Math.min(width - m.offsetWidth - 6, at.x + 2));
  const y = Math.max(6, Math.min(height - m.offsetHeight - 6, at.y + 2));
  m.style.left = `${x}px`;
  m.style.top = `${y}px`;
}

export function closeMenu(): void {
  menu?.remove();
  menu = null;
}

export function menuOpen(): boolean {
  return menu !== null;
}

/**
 * A controller (or the arrow keys) driving the open menu: move the highlight, choose, or back out.
 * Returns false when no menu is open.
 */
export function menuPress(m: 'up' | 'down' | 'select' | 'back'): boolean {
  if (!menu) return false;
  if (m === 'back') {
    closeMenu();
    return true;
  }
  const items = [...menu.querySelectorAll<HTMLButtonElement>('.ctx-i:not([disabled])')];
  if (!items.length) return true;
  const at = items.findIndex((b) => b.classList.contains('on'));
  if (m === 'select') {
    (items[at] ?? items[0]).click();
    return true;
  }
  const next = at < 0 ? 0 : (at + (m === 'down' ? 1 : items.length - 1)) % items.length;
  items.forEach((b, i) => b.classList.toggle('on', i === next));
  return true;
}

// A press anywhere outside the menu closes it; Escape closes the menu alone, before the game
// (which would close the window behind it) hears the key.
addEventListener(
  'mousedown',
  (e) => {
    if (menu && !menu.contains(e.target as Node)) closeMenu();
  },
  true,
);
addEventListener(
  'keydown',
  (e) => {
    if (menu && e.code === 'Escape') {
      closeMenu();
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  },
  true,
);
addEventListener('blur', () => closeMenu());
