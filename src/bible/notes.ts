// The written explanations of things whose content has no description of its own: one file per
// kind in src/bible/notes/ (crops.md, npcs.md...), a `## <id>` heading per thing and its prose under
// it, with [[links]] to other pages. Numbers stay out of them (the completeness test checks): a
// thing's numbers are drawn from its content on its entry. When the content moves into a folder per
// kind (.plans/refactor, Phase 7), each note can move beside its thing.

const FILES = import.meta.glob<string>('./notes/*.md', { query: '?raw', import: 'default', eager: true });

/** kind → id → note. */
const NOTES = new Map<string, Map<string, string>>();

for (const [path, text] of Object.entries(FILES)) {
  const kind = /([^/]+)\.md$/.exec(path)?.[1];
  if (!kind) continue;
  const byId = new Map<string, string>();
  let id: string | null = null;
  let lines: string[] = [];
  const done = () => {
    if (id !== null) byId.set(id, lines.join('\n').trim());
  };
  for (const line of text.split(/\r?\n/)) {
    const h = /^##\s+(\S+)\s*$/.exec(line);
    if (h) {
      done();
      id = h[1];
      lines = [];
    } else if (id !== null) lines.push(line);
  }
  done();
  NOTES.set(kind, byId);
}

/** The note on a thing, or undefined. */
export const noteFor = (kind: string, id: string): string | undefined => NOTES.get(kind)?.get(id) || undefined;

/** Every note there is, by kind and id: the completeness test finds the ones whose thing is gone. */
export const allNotes = (): ReadonlyMap<string, ReadonlyMap<string, string>> => NOTES;
