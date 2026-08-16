/**
 * Conformance, and every read checked against a plain array - including the
 * claim the second Fenwick tree exists to buy.
 *
 *     node packages/plugins/fenwick-range/src/plugin.check.ts
 */

import { createRng, help, parseCommand, type OperationError } from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { fenwickRange as plugin } from './plugin.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const fresh = (): PluginInstance => plugin.createInstance({ rng: createRng(1) });

function run(inst: PluginInstance, line: string): { value: unknown; error: OperationError | null } {
  const parsed = parseCommand(line, plugin.commands);
  if (!parsed.ok) return { value: null, error: parsed.error };
  const r = inst.execute(parsed.command);
  return r.ok ? { value: r.value, error: null } : { value: null, error: r.error };
}

const numberAt = (r: { value: unknown }, key: string): number | undefined =>
  (r.value as Record<string, number> | null)?.[key];

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, ['build [3 1 4 1 5 9 2 6]', 'apply v0 2 6 10', 'prefix v1 5', 'range v1 2 6'])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. Building ───────────────────────────────────────────────────── */

console.log('\nbuilding');

const inst = fresh();
const built = run(inst, 'build [3 1 4 1 5 9 2 6]').value as
  { size: number; total: number; cells: number };
check('build reads the array back', built.size === 8 && built.total === 31);
check('two arrays means two cells per index', built.cells === 16, `${built.cells} cells for 8 values`);

check('an empty array is refused', run(fresh(), 'build []').error?.code === 'BAD_ARGUMENT');
check('an unknown version is refused, and says what exists',
  (run(inst, 'prefix v9 1').error?.hint ?? '').includes('v0'));
check('a backwards or out-of-bounds range is refused', (() => {
  const a = run(inst, 'apply v0 5 2 1');
  const b = run(inst, 'range v0 0 3');
  return a.error?.code === 'INVALID_RANGE' && b.error?.code === 'INVALID_RANGE';
})());

/* ── 3. What the second array buys ─────────────────────────────────── */

console.log('\nrange writes');

check('a range of any width costs the same four chains', (() => {
  // The whole reason for the difference encoding: 200 indices must not cost
  // more than 2, because neither one touches what lies between the edges.
  const q = fresh();
  run(q, `build [${Array.from({ length: 256 }, () => 1).join(' ')}]`);
  const wide = numberAt(run(q, 'apply v0 20 220 5'), 'allocated') ?? -1;
  const narrow = numberAt(run(q, 'apply v0 20 22 5'), 'allocated') ?? -1;
  return wide > 0 && wide <= narrow * 1.5;
})(), (() => {
  const q = fresh();
  run(q, `build [${Array.from({ length: 256 }, () => 1).join(' ')}]`);
  const wide = numberAt(run(q, 'apply v0 20 220 5'), 'allocated');
  const narrow = numberAt(run(q, 'apply v0 20 22 5'), 'allocated');
  return `201 indices cost ${String(wide)} cells, 3 indices cost ${String(narrow)}`;
})());

check('a range write shows up in the sums', (() => {
  const q = fresh();
  run(q, 'build [1 1 1 1 1 1 1 1]');
  run(q, 'apply v0 3 5 10');
  return numberAt(run(q, 'prefix v1 8'), 'sum') === 38
    && numberAt(run(q, 'range v1 3 5'), 'sum') === 33
    && numberAt(run(q, 'range v1 1 2'), 'sum') === 2;
})(), '30 added across three of eight');

check('a write touching the last index is not lost', (() => {
  // The take-back write lands at hi + 1, which falls off the end here. It is
  // skipped rather than stored, and skipping it must not change any answer.
  const q = fresh();
  run(q, 'build [1 1 1 1]');
  run(q, 'apply v0 3 4 5');
  return numberAt(run(q, 'prefix v1 4'), 'sum') === 14
    && numberAt(run(q, 'at v1 4'), 'entry') === 6
    && numberAt(run(q, 'at v1 2'), 'entry') === 1;
})());

check('add is a range of width one', (() => {
  const q = fresh();
  run(q, 'build [1 2 3 4]');
  run(q, 'add v0 2 100');
  return numberAt(run(q, 'at v1 2'), 'entry') === 102
    && numberAt(run(q, 'at v1 1'), 'entry') === 1
    && numberAt(run(q, 'prefix v1 4'), 'sum') === 110;
})());

check('earlier versions are untouched', (() => {
  const q = fresh();
  run(q, 'build [1 1 1 1]');
  run(q, 'apply v0 1 4 7');
  return numberAt(run(q, 'prefix v0 4'), 'sum') === 4
    && numberAt(run(q, 'prefix v1 4'), 'sum') === 32;
})());

check('compare finds shared cells between versions', (() => {
  const q = fresh();
  run(q, `build [${Array.from({ length: 32 }, () => 1).join(' ')}]`);
  run(q, 'apply v0 3 4 2');
  const shared = numberAt(run(q, 'compare v0 v1'), 'shared') ?? 0;
  return shared > 0;
})());

check('the two arrays are drawn apart', (() => {
  // A cell of one is meaningless beside a cell of the other, so they carry
  // different groups and the drawing colours them separately.
  const q = fresh();
  run(q, 'build [1 2 3 4]');
  const g = q.getStructure();
  const groups = new Set(g.nodes.map((n) => n.group));
  return groups.size === 2 && groups.has(0) && groups.has(1);
})());

check('no cell of one array points into the other', (() => {
  const q = fresh();
  run(q, 'build [1 2 3 4 5 6 7 8]');
  run(q, 'apply v0 2 6 3');
  const g = q.getStructure();
  const group = new Map(g.nodes.map((n) => [n.id, n.group]));
  return g.edges.every((e) => group.get(e.from) === group.get(e.to));
})(), 'they are two forests, not one');

/* ── 4. Against a plain array ──────────────────────────────────────── */

console.log('\nproperty test vs a plain array');

const rng = createRng(20_260_824);
let trials = 0;
let queries = 0;
let firstFailure = '';

for (let t = 0; t < 40 && firstFailure === ''; t += 1) {
  const n = rng.nextInt(1, 15);
  const start = Array.from({ length: n }, () => rng.nextInt(-15, 30));
  const q = fresh();
  run(q, `build [${start.join(' ')}]`);
  const model: number[][] = [[...start]];

  for (let op = 0; op < 6; op += 1) {
    const v = rng.nextInt(0, model.length);
    let lo = rng.nextInt(1, n + 1);
    let hi = rng.nextInt(1, n + 1);
    if (lo > hi) [lo, hi] = [hi, lo];
    const delta = rng.nextInt(-12, 20);
    const r = run(q, `apply v${v} ${lo} ${hi} ${delta}`);
    if (r.error !== null) { firstFailure = `apply failed: ${r.error.code}`; break; }
    const next = [...(model[v] as number[])];
    for (let i = lo; i <= hi; i += 1) next[i - 1] = (next[i - 1] as number) + delta;
    model.push(next);
  }

  for (let v = 0; v < model.length && firstFailure === ''; v += 1) {
    const arr = model[v] as number[];

    // Every entry, every prefix, and a handful of ranges.
    for (let i = 1; i <= n; i += 1) {
      const entry = numberAt(run(q, `at v${v} ${i}`), 'entry');
      queries += 1;
      if (entry !== arr[i - 1]) {
        firstFailure = `at v${v} ${i} gave ${String(entry)}, expected ${String(arr[i - 1])}`;
        break;
      }
      const wanted = arr.slice(0, i).reduce((a, b) => a + b, 0);
      const got = numberAt(run(q, `prefix v${v} ${i}`), 'sum');
      queries += 1;
      if (got !== wanted) {
        firstFailure = `prefix v${v} ${i} gave ${String(got)}, expected ${wanted}`;
        break;
      }
    }
    if (firstFailure !== '') break;

    for (let probe = 0; probe < 4; probe += 1) {
      let lo = rng.nextInt(1, n + 1);
      let hi = rng.nextInt(1, n + 1);
      if (lo > hi) [lo, hi] = [hi, lo];
      const wanted = arr.slice(lo - 1, hi).reduce((a, b) => a + b, 0);
      const got = numberAt(run(q, `range v${v} ${lo} ${hi}`), 'sum');
      queries += 1;
      if (got !== wanted) {
        firstFailure = `range v${v} ${lo} ${hi} gave ${String(got)}, expected ${wanted}`;
        break;
      }
    }
  }
  trials += 1;
}

check('entries, prefixes and ranges agree with a plain array, in every version',
  firstFailure === '',
  firstFailure === '' ? `${trials} trials, ${queries} queries` : firstFailure);

/* ── 5. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build [1 1 1 1 1 1 1 1]', 'apply v0 3 5 10', 'prefix v1 8', 'range v1 3 5', 'at v1 4', 'compare v0 v1']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
