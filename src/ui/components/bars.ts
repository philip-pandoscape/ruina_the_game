// Bars (design/ui.html: Bars): the vitals beside your portrait, and the thin ones under a quest's
// step or a contract that show how far along it is.

/**
 * A bar on the HUD (.hud-bar): an icon on its cap, then a track whose fill and number `setBar`
 * moves. `k` names it (its class is v-`k`), `colour` is a colour (var(--hp)...).
 */
export function barHtml(k: string, icon: string, colour: string, title: string, slim = true): string {
  return `<div class="hud-bar v-${k}${slim ? ' slim' : ''}" style="--c:${colour}" title="${title}"><span class="cap">${icon}</span><div class="track"><div class="fill"></div><span class="txt"></span></div></div>`;
}

/**
 * Fills bar `k` in `root` to `frac` (0..1) and writes its number, touching the page only where
 * either changed since `shown` last saw them.
 */
export function setBar(root: HTMLElement, shown: Map<string, string>, k: string, frac: number, text: string): void {
  const width = `calc((100% - 12px) * ${Math.max(0, Math.min(1, frac)).toFixed(3)})`;
  if (shown.get(k) !== width) {
    shown.set(k, width);
    (root.querySelector(`.v-${k} .fill`) as HTMLElement).style.width = width;
  }
  if (shown.get(`${k}.text`) !== text) {
    shown.set(`${k}.text`, text);
    (root.querySelector(`.v-${k} .txt`) as HTMLElement).textContent = text;
  }
}

/** A thin bar (.q-bar), `pct` per cent of it filled. */
export const progressHtml = (pct: number): string => `<div class="q-bar"><i style="width:${pct}%"></i></div>`;
