import { attrs } from './dom';

// Item slots (design/ui.html: Items): what you have, an icon in a square with how many in its
// corner. Hovering one shows its tooltip (data-tip, src/ui/theme/tooltip.ts); in a grid a click
// picks it (data-act), a double-click does its main thing and a right-click lists the rest.

/**
 * An item slot (.ib): `icon` in a square, `n` in its corner. `cls` adds `sm` (the bag's size), `big`
 * (the character's), `sel` (picked), `empty`, `ghost` (a slot's outline); `act` and `arg` say what
 * it does, `tip` what its tooltip shows.
 */
export function slotHtml(icon: string, o: { cls?: string; n?: number; act?: string; arg?: string | number; tip?: string } = {}): string {
  return `<div class="ib${o.cls ? ` ${o.cls}` : ''}"${attrs({ 'data-act': o.act, 'data-arg': o.arg, 'data-tip': o.tip })}>${icon}${o.n === undefined ? '' : `<span class="n">${o.n}</span>`}</div>`;
}

/** Slots in rows, the bag's grid (.bag-grid). */
export const gridHtml = (cells: readonly string[]): string => `<div class="bag-grid">${cells.join('')}</div>`;
