// Everything the page says on the console, and every error nobody caught, kept for bug reports.
// Installed once at startup. It costs a capped list of short strings.
//
// vite.config.ts puts this file on DevTools' ignore list, so console messages still point at the
// code that logged them rather than at the wrapper below.

export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  t: number; // performance.now()
  level: LogLevel;
  text: string;
}

export interface ErrorEntry {
  t: number;
  kind: 'error' | 'rejection' | 'webgl';
  message: string;
  stack?: string;
  source?: string;
}

const MAX_LOGS = 800;
const MAX_ERRORS = 60;
const MAX_TEXT = 2000;

export const logs: LogEntry[] = [];
export const errors: ErrorEntry[] = [];
let installed = false;

function clip(s: string, n = MAX_TEXT): string {
  return s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s;
}

function push<T>(list: T[], v: T, max: number): void {
  list.push(v);
  if (list.length > max) list.splice(0, list.length - max);
}

/** A readable one-line version of anything that was logged. */
export function describe(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
  if (v === undefined || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || v === null) return String(v);
  if (typeof v === 'function') return `[function ${v.name || 'anonymous'}]`;
  if (typeof Element !== 'undefined' && v instanceof Element) return `<${v.tagName.toLowerCase()}${v.id ? `#${v.id}` : ''}>`;
  try {
    const seen = new WeakSet<object>();
    return clip(
      JSON.stringify(v, (_k, x: unknown) => {
        if (typeof x === 'object' && x !== null) {
          if (seen.has(x)) return '[circular]';
          seen.add(x);
          // Three.js objects and typed arrays are huge and say little in a log.
          if (ArrayBuffer.isView(x)) return `[${x.constructor.name} × ${(x as unknown as { length?: number }).length ?? '?'}]`;
          if ('isObject3D' in x || 'isMaterial' in x || 'isBufferGeometry' in x) return `[${(x as { type?: string }).type ?? 'three.js object'}]`;
        }
        return typeof x === 'bigint' ? String(x) : x;
      }) ?? String(v),
      600,
    );
  } catch {
    return Object.prototype.toString.call(v);
  }
}

export function recordError(kind: ErrorEntry['kind'], message: string, stack?: string, source?: string): void {
  push(errors, { t: performance.now(), kind, message: clip(message, 600), stack: stack ? clip(stack, 4000) : undefined, source }, MAX_ERRORS);
}

export function installLogCapture(): void {
  if (installed) return;
  installed = true;
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try {
        push(logs, { t: performance.now(), level, text: clip(args.map(describe).join(' ')) }, MAX_LOGS);
      } catch {
        /* never let logging break the caller */
      }
      original(...args);
    };
  }
  addEventListener('error', (e) => {
    // Resource load failures (a missing image or script) arrive here too, without a message.
    if (!(e instanceof ErrorEvent)) return;
    const err = e.error as Error | undefined;
    recordError('error', e.message || String(err), err?.stack, e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined);
  });
  addEventListener('unhandledrejection', (e) => {
    const r = e.reason as unknown;
    recordError('rejection', r instanceof Error ? `${r.name}: ${r.message}` : describe(r), r instanceof Error ? r.stack : undefined);
  });
}
