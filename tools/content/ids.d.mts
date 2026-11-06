// Types for tools/content/ids.mjs, for the test that imports it.
/** A content id found in code. */
export interface Hit {
  file: string;
  line: number;
  id: string;
}
/** The ids checked, each with the kinds of thing it names, read from `root`'s shared/ bundles. */
export function contentIds(root?: string): Map<string, string[]>;
/** Every string literal and object literal key in TypeScript that `want` takes. */
export function tsStrings(file: string, text: string, want: (s: string) => boolean, out?: Hit[]): Hit[];
/** Every string literal in Rust, outside comments and #[cfg(test)] items, that `want` takes. */
export function rustStrings(file: string, text: string, want: (s: string) => boolean, out?: Hit[]): Hit[];
/** Every content id in the game's code under `root` (src/ and crates/). */
export function scan(root?: string, ids?: Map<string, string[]>): Hit[];
