import { esc } from '../../util/html';

// The small helpers the components and the life's windows build their pages with.

/** A new element with its class and inner HTML. */
export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

/** Attributes as HTML, ` name="value"` each (escaped) in the order given; those undefined are left out. */
export function attrs(a: Record<string, string | number | undefined>): string {
  let s = '';
  for (const [k, v] of Object.entries(a)) if (v !== undefined) s += ` ${k}="${esc(v)}"`;
  return s;
}
