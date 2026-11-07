// Types for tools/content/contentc.mjs, for the tests that import it.
export class ContentError extends Error {}
/** Builds every bundle from `root` (content/ by default), and the hash of shared/: their paths under shared/ and their data. */
export function build(root?: string): Map<string, unknown>;
/** The bundles whose file under shared/ isn't what content/ builds. */
export function stale(bundles: Map<string, unknown>): string[];
/** Writes the bundles that changed into shared/: their paths. */
export function write(bundles: Map<string, unknown>): string[];
