/**
 * Conformance plus property tests for the persistent segment tree.
 *
 *     node packages/plugins/persistent-segment-tree/src/plugin.check.ts
 */

import { createRng, help, parseCommand, type OperationError } from '@algoverse/core';
import { ZERO_STATS, addStats, runConformance, type PluginInstance, type Statistics } from '@algoverse/plugin-sdk';
import { persistentSegmentTree as plugin } from './plugin.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const fresh = (): PluginInstance => plugin.createInstance({ rng: createRng(1) });

/** Runs a console line. Returns the value, or null when the operation failed. */
function run(inst: PluginInstance, line: string): { value: unknown; error: OperationError | null } {
  const parsed = parseCommand(line, plugin.commands);
  if (!parsed.ok) return { value: null, error: parsed.error };
  const r = inst.execute(parsed.command);
  return r.ok ? { value: r.value, error: null } : { value: null, error: r.error };
}

const sumOf = (r: { value: unknown }): number => (r.value as { sum: number }).sum;

/* ── 1. Conformance kit ────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, [
  'build [3 1 4 1 5 9 2 6]',
  'update v0 3 10',
  'update v1 6 7',
  'query v1 2 5',
  'compare v0 v2',
])) {
  check(r.name, r.ok, r.detail);
}

/* ── 2. The spike's numbers, now from the real plugin ──────────────── */

console.log('\nstructural sharing');

const inst = fresh();
run(inst, 'build [3 1 4 1 5 9 2 6]');
run(inst, 'update v0 3 10');
run(inst, 'update v1 6 7');
const structure = inst.getStructure();

check('three versions produce 23 nodes, not 45', structure.nodes.length === 23,
  `${structure.nodes.length} nodes vs 45 naive (${Math.round((1 - structure.nodes.length / 45) * 100)}% saved)`);
check('every version is reachable', structure.roots.length === 3);
check('reused pointers are flagged', structure.edges.some((e) => e.reused),
  `${structure.edges.filter((e) => e.reused).length} of ${structure.edges.length} edges cross versions`);
check('slots align versions of the same range',
  new Set(structure.nodes.map((n) => n.slot)).size === 15,
  `${new Set(structure.nodes.map((n) => n.slot)).size} distinct slots for 23 nodes`);
check('compare reports 11 shared nodes',
  (run(inst, 'compare v0 v1').value as { shared: number }).shared === 11,
  JSON.stringify(run(inst, 'compare v0 v1').value));

/* ── 3. Errors are returned with useful hints ──────────────────────── */

console.log('\nerrors');

const errCases: readonly { readonly line: string; readonly code: string }[] = [
  { line: 'query v9 2 5', code: 'UNKNOWN_VERSION' },
  { line: 'update v0 99 1', code: 'INDEX_OUT_OF_RANGE' },
  { line: 'query v0 5 2', code: 'INVALID_RANGE' },
  { line: 'query v0 0 99', code: 'INVALID_RANGE' },
];
for (const c of errCases) {
  const r = run(inst, c.line);
  check(`${c.line} -> ${c.code}`, r.error?.code === c.code, r.error?.hint ?? '');
}

const unbuilt = run(fresh(), 'query v0 0 1');
check('querying before build explains itself', unbuilt.error?.code === 'UNKNOWN_VERSION',
  unbuilt.error?.hint ?? '');

/* ── 4. Property test against a naive model ────────────────────────── */

console.log('\nproperty test vs naive arrays');

const rng = createRng(20_260_808);
let trials = 0;
let queries = 0;
let firstFailure = '';

for (let t = 0; t < 60 && firstFailure === ''; t += 1) {
  const n = rng.nextInt(1, 13);
  const start = Array.from({ length: n }, () => rng.nextInt(-20, 40));
  const inst2 = fresh();
  run(inst2, `build [${start.join(' ')}]`);
  const model: number[][] = [[...start]];

  for (let op = 0; op < 8; op += 1) {
    const v = rng.nextInt(0, model.length);
    if (rng.next() < 0.55) {
      const i = rng.nextInt(0, n);
      const val = rng.nextInt(-20, 40);
      const r = run(inst2, `update v${v} ${i} ${val}`);
      if (r.error !== null) { firstFailure = `update failed: ${r.error.code}`; break; }
      const next = [...(model[v] as number[])];
      next[i] = val;
      model.push(next);
    } else {
      let lo = rng.nextInt(0, n);
      let hi = rng.nextInt(0, n);
      if (lo > hi) [lo, hi] = [hi, lo];
      if (lo === hi) hi = Math.min(n, hi + 1);
      if (lo === hi) continue;
      const r = run(inst2, `query v${v} ${lo} ${hi}`);
      queries += 1;
      const expected = (model[v] as number[]).slice(lo, hi).reduce((a, b) => a + b, 0);
      if (r.error !== null || sumOf(r) !== expected) {
        firstFailure = `query v${v} ${lo} ${hi} gave ${r.error?.code ?? sumOf(r)}, expected ${expected}`;
        break;
      }
    }
  }

  // Every version must still read correctly after all later updates.
  for (let v = 0; v < model.length && firstFailure === ''; v += 1) {
    const arr = model[v] as number[];
    for (let i = 0; i < n; i += 1) {
      const r = run(inst2, `query v${v} ${i} ${i + 1}`);
      queries += 1;
      if (r.error !== null || sumOf(r) !== (arr[i] as number)) {
        firstFailure = `v${v}[${i}] drifted: got ${r.error?.code ?? sumOf(r)}, expected ${String(arr[i])}`;
        break;
      }
    }
  }
  trials += 1;
}

check('all versions agree with naive arrays', firstFailure === '',
  firstFailure === '' ? `${trials} trials, ${queries} queries` : firstFailure);

/* ── 5. Statistics accumulate ──────────────────────────────────────── */

console.log('\nstatistics');

const inst3 = fresh();
let stats: Statistics = ZERO_STATS;
for (const line of ['build [1 2 3 4 5 6 7 8]', 'update v0 0 100', 'update v1 7 -5', 'query v2 0 8']) {
  const parsed = parseCommand(line, plugin.commands);
  if (!parsed.ok) continue;
  const r = inst3.execute(parsed.command);
  stats = addStats(stats, r.statsDelta);
}
check('versions counted', stats.versions === 3, `${stats.versions}`);
check('updates counted', stats.updates === 2, `${stats.updates}`);
check('queries counted', stats.queries === 1, `${stats.queries}`);
check('allocation matches 2n-1 plus two paths', stats.nodesAllocated === 15 + 4 + 4,
  `${stats.nodesAllocated}`);
check('height is a level, not a running total', stats.height === 4, `${stats.height}`);
check('measured visits are recorded', stats.nodeVisits > 0, `${stats.nodeVisits} node visits`);

/* ── 6. What the console shows ─────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build [3 1 4 1 5 9 2 6]', 'update v0 3 10', 'query v1 2 5', 'query v0 2 5', 'compare v0 v1', 'query v9 0 1']) {
  const r = run(session, line);
  const out = r.error === null
    ? JSON.stringify(r.value)
    : `${r.error.code}: ${r.error.message}  (${r.error.hint ?? ''})`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
