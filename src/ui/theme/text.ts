// How UI text is written (design/ui.html, "Writing"). Labels are in Title Case: buttons, menu
// entries, tabs, window titles, headings, status tags, stat names, the controls hint. Sentences
// (what people say, descriptions, notes, toasts) are in sentence case. tests/integration/ui.spec.ts holds the
// open windows to this.

/** Words a title keeps in lower case, unless they start or end it. */
export const SMALL_WORDS: ReadonlySet<string> = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet', 'as', 'at', 'by', 'in', 'of', 'off', 'on', 'per', 'to', 'up', 'via', 'vs']);

/** "sell all produce" → "Sell All Produce". Words already capitalised (names, "UI") are kept. */
export function titleCase(text: string): string {
  const words = text.split(' ');
  const last = words.length - 1;
  return words
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (i !== 0 && i !== last && SMALL_WORDS.has(lower)) return lower;
      return w.replace(/\p{L}/u, (c) => c.toUpperCase());
    })
    .join(' ');
}

/**
 * Whether a label is in Title Case: every word that begins with a letter is capitalised, except
 * the small words in the middle. Numbers, symbols and the units after a number ("52 m", "3s") are
 * let through.
 */
export function isTitleCase(text: string): boolean {
  const words = text.split(/[\s·/–—]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/^[("“'‘]+/, '');
    if (!/^\p{L}/u.test(w)) continue;
    if (i > 0 && /^[\d.,%×~+-]+$/.test(words[i - 1])) continue; // a unit after a number
    if (/^\p{Lu}/u.test(w)) continue;
    const middle = i !== 0 && i !== words.length - 1;
    if (middle && SMALL_WORDS.has(w.toLowerCase())) continue;
    return false;
  }
  return true;
}
