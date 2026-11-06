// Text put into HTML: the characters that would be read as markup, escaped.

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/** `s` as text in HTML (null and undefined as nothing). */
export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"]/g, (c) => ENTITIES[c]!);
