import { attrs } from './dom';

/**
 * A row in a list (.lui-row): an item slot (src/ui/components/slot.ts), the body (a bold name and
 * small lines under it), a price, then its buttons (`end`). `tip` is its tooltip (data-tip).
 */
export function rowHtml(r: { slot: string; body: string; price?: string; end?: string; tip?: string }): string {
  return `<div class="lui-row"${attrs({ 'data-tip': r.tip })}>${r.slot}<div class="body">${r.body}</div>${r.price === undefined ? '' : `<div class="price">${r.price}</div>`}${r.end ?? ''}</div>`;
}

/** Rows one under another (.lui-list). */
export const listHtml = (rows: string): string => `<div class="lui-list">${rows}</div>`;
