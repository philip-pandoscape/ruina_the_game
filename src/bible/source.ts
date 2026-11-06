// Numbers the rules hold in their source without exporting them (how long the server keeps a
// dungeon's copy, the steepest ground a farm plot takes), read from that source as the bible is built,
// so they are the rules' own and change when they do. Import the source with `?raw`:
//
//   import spaces from '../../../crates/server/src/play/spaces.rs?raw';
//   rustConst(spaces, 'COPY_KEPT')                         // a Rust const, Durations in seconds
//   import farming from '../../sim/life/farming.ts?raw';
//   tsConst(farming, 'HALF')                               // a TypeScript const of plain numbers
//   sourceNumber(farming, /hf\.slope\(px, pz\) > ([\d.]+)\)/, 'the steepest ground a plot takes')
//
// A number that is gone, or no longer a plain number, throws: the completeness test draws every page
// (tests/unit/bible.test.ts), so it fails until the page is brought up to date.

/**
 * The value of `const NAME: Type = expression;` in Rust source: a number, sums and products of
 * numbers, or a Duration (from_secs, from_millis), in seconds.
 */
export function rustConst(source: string, name: string): number {
  const m = new RegExp(`const\\s+${name}\\s*:\\s*[^=]+=\\s*([^;]+);`).exec(source);
  if (!m) throw new Error(`no const ${name} in the Rust source the bible reads`);
  let expr = m[1].trim();
  let scale = 1;
  const d = /^Duration::from_(secs|millis)\((.*)\)$/.exec(expr);
  if (d) {
    expr = d[2];
    scale = d[1] === 'millis' ? 0.001 : 1;
  }
  return plain(expr, name) * scale;
}

/** The value of `const NAME = expression;` (or `NAME: type = …`) in TypeScript source, made of plain numbers. */
export function tsConst(source: string, name: string): number {
  const m = new RegExp(`const\\s+${name}\\s*(?::\\s*[^=]+)?=\\s*([^;\\n]+);`).exec(source);
  if (!m) throw new Error(`no const ${name} in the TypeScript source the bible reads`);
  return plain(m[1].trim(), name);
}

/** The number the first group of `pattern` finds in the source; `what` names it for the error. */
export function sourceNumber(source: string, pattern: RegExp, what: string): number {
  const m = pattern.exec(source);
  const n = m ? Number(m[1]) : Number.NaN;
  if (!Number.isFinite(n)) throw new Error(`the rules' source no longer says ${what} where the bible looks (${pattern})`);
  return n;
}

function plain(expr: string, name: string): number {
  const clean = expr.replace(/_/g, '').replace(/\b(\d+(?:\.\d+)?)(?:u\d+|i\d+|usize|isize|f\d+)\b/g, '$1');
  if (!/^[\d\s.+\-*/()]+$/.test(clean)) throw new Error(`const ${name} is not a plain number: ${expr}`);
  return evaluate(clean);
}

/** Sums, differences, products and quotients of numbers, with brackets. */
function evaluate(expr: string): number {
  const tokens = expr.match(/\d+(?:\.\d+)?|[+\-*/()]/g) ?? [];
  let i = 0;
  const atom = (): number => {
    const t = tokens[i++];
    if (t === '(') {
      const v = sum();
      i++;
      return v;
    }
    if (t === '-') return -atom();
    return Number(t);
  };
  const product = (): number => {
    let v = atom();
    while (tokens[i] === '*' || tokens[i] === '/') v = tokens[i++] === '*' ? v * atom() : v / atom();
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (tokens[i] === '+' || tokens[i] === '-') v = tokens[i++] === '+' ? v + product() : v - product();
    return v;
  };
  return sum();
}
