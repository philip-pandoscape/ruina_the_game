// One tooltip for the whole UI: hover (or a controller's focus) over anything with data-tip shows
// it beside that element. The owner of the element says what to show for its data-tip value.
import { toUi, uiRoot, uiSize } from './scale';

type Source = (tip: string) => string | null;

let el: HTMLDivElement | null = null;
let shownFor: Element | null = null;
const sources: Source[] = [];

function box(): HTMLDivElement {
  if (!el) {
    el = document.createElement('div');
    el.className = 'tt';
    el.style.display = 'none';
    uiRoot().append(el);
  }
  return el;
}

/** Adds a way to turn a data-tip value into the tooltip's HTML (the first that answers wins). */
export function addTipSource(fn: Source): void {
  sources.push(fn);
}

export function showTip(anchor: Element, html: string): void {
  const t = box();
  t.innerHTML = html;
  t.style.display = 'block';
  shownFor = anchor;
  const r = anchor.getBoundingClientRect();
  const a = toUi(r.left, r.top);
  const b = toUi(r.right, r.bottom);
  const { width, height } = uiSize();
  const w = t.offsetWidth;
  const hgt = t.offsetHeight;
  let x = b.x + 8;
  if (x + w > width - 8) x = a.x - w - 8;
  const y = Math.max(8, Math.min(height - hgt - 8, a.y - 4));
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}

export function hideTip(anchor?: Element): void {
  if (anchor && anchor !== shownFor) return;
  if (el) el.style.display = 'none';
  shownFor = null;
}

/** Shows the tip for an element (and its data-tip), or hides it when there is none. */
export function tipFor(target: Element | null): void {
  const at = target?.closest('[data-tip]');
  if (!at) return hideTip();
  const tip = at.getAttribute('data-tip')!;
  for (const fn of sources) {
    const html = fn(tip);
    if (html) return showTip(at, html);
  }
  hideTip();
}

let wired = false;
/** Follows the mouse over the UI. */
export function wireTips(): void {
  if (wired) return;
  wired = true;
  const root = uiRoot();
  root.addEventListener('mouseover', (e) => tipFor(e.target as Element));
  root.addEventListener('mouseleave', () => hideTip());
}
