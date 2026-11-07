import { esc } from '../../util/html';

/**
 * A row of tabs over a window's body (a merchant's Buy, Sell and Buyback): each one a
 * data-act="tab" whose data-arg is its id, `on` the one showing. Labels in Title Case.
 */
export function tabsHtml(tabs: ReadonlyArray<readonly [id: string, label: string]>, on: string): string {
  return `<div class="m-tabs">${tabs.map(([id, label]) => `<span class="m-tab${on === id ? ' on' : ''}" data-act="tab" data-arg="${esc(id)}">${esc(label)}</span>`).join('')}</div>`;
}
