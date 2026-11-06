// Types for moves-lib.mjs (plain JavaScript, run by Node), for the tests that check it.

export interface Move {
  from: string;
  to: string;
}

export interface Resolved {
  file: string;
  form: 'exact' | 'extension' | 'index';
  ext?: string;
}

export interface MoveContext {
  map: Map<string, string>;
  moves: Move[];
  files: Set<string>;
  exists: (file: string) => boolean;
  pathReplacements: [string, string][];
  pathPattern: RegExp;
}

export const SCRIPT_EXTENSIONS: string[];
export function isTextFile(file: string): boolean;
export function parseMoves(text: string): Move[];
export function expandMoves(moves: Move[], files: Set<string>): Map<string, string>;
export function resolveSpecifier(fromFile: string, specPath: string, exists: (file: string) => boolean): Resolved | null;
export function respecify(fromFile: string, fromNew: string, spec: string, map: Map<string, string>, exists: (file: string) => boolean): string;
export function folderPlace(dir: string, moves: Move[], map: Map<string, string>, files: Set<string>): string;
export function reglob(fromFile: string, fromNew: string, pattern: string, moves: Move[], map: Map<string, string>, files: Set<string>): string;
export function refolder(fromFile: string, fromNew: string, dirSpec: string, moves: Move[], map: Map<string, string>, files: Set<string>): string;
export function rewriteScript(text: string, fromFile: string, fromNew: string, ctx: MoveContext): string;
export function rewriteRust(text: string, fromFile: string, fromNew: string, ctx: MoveContext): string;
export function rewriteCss(text: string, fromFile: string, fromNew: string, ctx: MoveContext): string;
export function rewriteHtmlRoots(text: string, ctx: MoveContext): string;
export function rewriteRepoPaths(text: string, ctx: MoveContext): string;
export function pathReplacementsFor(moves: Move[], map: Map<string, string>): Pick<MoveContext, 'pathReplacements' | 'pathPattern'>;
export function rewriteFile(text: string, fromFile: string, ctx: MoveContext): string;
export function contextFor(moves: Move[], files: Set<string>): MoveContext;
