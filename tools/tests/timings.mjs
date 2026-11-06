// Prints where a Playwright run spent its time, from the JSON report every run writes
// (playwright.config.ts): the slowest tests, the slowest files, and the run's totals.
//
//   node tools/tests/timings.mjs                      the last run (test-results/timings.json)
//   node tools/tests/timings.mjs report.json --top 40 another report, more rows
//   node tools/tests/timings.mjs --md                 Markdown tables, for the refactor's notes

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--top') ?? 'test-results/timings.json';
const top = Number(option('--top', 20));
const md = flag('--md');

const report = JSON.parse(readFileSync(file, 'utf8'));

// The report nests suites (files, then describe blocks) holding specs, each run as a test per project,
// each with one result per try. A test's time is all its tries together, as the run spent it.
const tests = [];
function walk(suite, file, titles) {
  const here = suite.file ?? file;
  const path = suite.title && suite.title !== here ? [...titles, suite.title] : titles;
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const ms = (test.results ?? []).reduce((sum, r) => sum + (r.duration ?? 0), 0);
      const outcome = test.status ?? 'unknown';
      tests.push({ file: spec.file ?? here, title: [...path, spec.title].join(' > '), project: test.projectName, ms, outcome });
    }
  }
  for (const child of suite.suites ?? []) walk(child, here, path);
}
for (const suite of report.suites ?? []) walk(suite, suite.file, []);

const files = new Map();
for (const t of tests) {
  const f = files.get(t.file) ?? { file: t.file, ms: 0, count: 0, failed: 0 };
  f.ms += t.ms;
  f.count += 1;
  if (t.outcome === 'unexpected' || t.outcome === 'flaky') f.failed += 1;
  files.set(t.file, f);
}

const seconds = (ms) => (ms / 1000).toFixed(1);
const stats = report.stats ?? {};
const counts = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
for (const t of tests) if (t.outcome in counts) counts[t.outcome] += 1;
const busy = tests.reduce((sum, t) => sum + t.ms, 0);

const slowTests = [...tests].sort((a, b) => b.ms - a.ms).slice(0, top);
const slowFiles = [...files.values()].sort((a, b) => b.ms - a.ms).slice(0, top);

if (md) {
  console.log(`Run: ${seconds(stats.duration ?? 0)} s on the clock, ${seconds(busy)} s of test time; ` +
    `${counts.expected} passed, ${counts.unexpected} failed, ${counts.flaky} flaky, ${counts.skipped} skipped.\n`);
  console.log('| Test | File | s |\n|---|---|---|');
  for (const t of slowTests) console.log(`| ${t.title.replaceAll('|', '/')} | ${t.file} | ${seconds(t.ms)} |`);
  console.log('\n| File | Tests | s | Failed |\n|---|---|---|---|');
  for (const f of slowFiles) console.log(`| ${f.file} | ${f.count} | ${seconds(f.ms)} | ${f.failed} |`);
} else {
  console.log(`${file}: ${tests.length} tests, ${seconds(stats.duration ?? 0)} s on the clock, ${seconds(busy)} s of test time`);
  console.log(`passed ${counts.expected}, failed ${counts.unexpected}, flaky ${counts.flaky}, skipped ${counts.skipped}\n`);
  console.log(`Slowest ${slowTests.length} tests:`);
  for (const t of slowTests) console.log(`${seconds(t.ms).padStart(7)} s  ${t.file}  ${t.title}${t.outcome === 'expected' ? '' : `  [${t.outcome}]`}`);
  console.log(`\nSlowest ${slowFiles.length} files:`);
  for (const f of slowFiles) console.log(`${seconds(f.ms).padStart(7)} s  ${String(f.count).padStart(3)} tests  ${f.file}${f.failed ? `  (${f.failed} failed)` : ''}`);
  const failed = tests.filter((t) => t.outcome === 'unexpected' || t.outcome === 'flaky');
  if (failed.length) {
    console.log(`\nFailed or flaky:`);
    for (const t of failed) console.log(`  [${t.outcome}] ${t.file}  ${t.title}`);
  }
}
