// Pixel icons for things content names by emoji (items, packs, vehicles, skills, places), and money
// drawn as gold, silver and copper coins.
import { EMOJI_ICONS, ITEM_ICONS } from './icons.gen';
import { COIN, pixelIcon } from './pixelIcons';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The baked pixel art for an emoji (or an item, for those with their own art), if there is one. */
export function iconUrl(emoji: string, itemId?: string): string | null {
  return (itemId && ITEM_ICONS[itemId]) || EMOJI_ICONS[emoji] || EMOJI_ICONS[emoji.replace(/️/g, '')] || null;
}

/** An <img> of the pixel art, or the emoji itself when there is none. */
export function iconHtml(emoji: string, itemId?: string, px = 32): string {
  const url = iconUrl(emoji, itemId);
  return url ? `<img class="icon16" src="${url}" width="${px}" height="${px}" alt="">` : `<span class="emoji">${esc(emoji)}</span>`;
}

/** Copper split into gold, silver and copper, each with its own coin. Zero parts are left out. */
export function money(copper: number, size = 14): string {
  const c = Math.max(0, Math.floor(copper));
  const g = Math.floor(c / 10000);
  const s = Math.floor(c / 100) % 100;
  const k = c % 100;
  const part = (n: number, pal: Record<string, string> | undefined) => `<b>${n}</b>${pixelIcon('coin', size, pal)}`;
  const bits: string[] = [];
  if (g) bits.push(part(g, COIN.gold));
  if (s) bits.push(part(s, COIN.silver));
  if (k || !bits.length) bits.push(part(k, COIN.copper));
  return `<span class="mny">${bits.join('')}</span>`;
}
