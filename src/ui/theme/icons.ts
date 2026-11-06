// Painted icons (tools/icons: painted with Gemini, cut out by `npm run icons`) for what content
// names by emoji (items, packs, vehicles, skills, places), the HUD's own by name (hearts, menu
// buttons, quest marks), and money drawn as gold, silver and copper coins.
import { EMOJI_ICONS, ICON_URLS, ITEM_ICONS, type IconName } from './icons.gen';
import { esc } from '../../util/html';

export type { IconName };

/** The painted icon for an emoji (or an item, for those with a picture of their own), if there is one. */
export function iconUrl(emoji: string, itemId?: string): string | null {
  const name = (itemId && ITEM_ICONS[itemId]) || EMOJI_ICONS[emoji.replace(/️/g, '')];
  return name ? ICON_URLS[name] : null;
}

/** An <img> of the painted icon, or the emoji itself when there is none. */
export function iconHtml(emoji: string, itemId?: string, px = 32): string {
  const url = iconUrl(emoji, itemId);
  return url ? `<img class="ico" src="${url}" width="${px}" height="${px}" alt="" draggable="false">` : `<span class="emoji">${esc(emoji)}</span>`;
}

/** One of the HUD's own icons, `px` wide. */
export function uiIcon(name: IconName, px = 24): string {
  return `<img class="uic" src="${ICON_URLS[name]}" width="${px}" height="${px}" alt="" draggable="false">`;
}

const images = new Map<string, HTMLImageElement>();
/** A painted icon to draw on a canvas: null until it has loaded (a canvas drawn every frame picks it up then). */
export function iconImage(emoji: string, itemId?: string): HTMLImageElement | null {
  const url = iconUrl(emoji, itemId);
  return url ? loaded(url) : null;
}
/** One of the HUD's own icons to draw on a canvas, once it has loaded. */
export function uiImage(name: IconName): HTMLImageElement | null {
  return loaded(ICON_URLS[name]);
}
function loaded(url: string): HTMLImageElement | null {
  let img = images.get(url);
  if (!img) {
    img = new Image();
    img.src = url;
    images.set(url, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

/** Copper split into gold, silver and copper, each with its own coin. Zero parts are left out. */
export function money(copper: number, size = 14): string {
  const c = Math.max(0, Math.floor(copper));
  const g = Math.floor(c / 10000);
  const s = Math.floor(c / 100) % 100;
  const k = c % 100;
  const part = (n: number, coin: IconName) => `<b>${n}</b>${uiIcon(coin, size)}`;
  const bits: string[] = [];
  if (g) bits.push(part(g, 'coin-gold'));
  if (s) bits.push(part(s, 'coin-silver'));
  if (k || !bits.length) bits.push(part(k, 'coin-copper'));
  return `<span class="mny">${bits.join('')}</span>`;
}
