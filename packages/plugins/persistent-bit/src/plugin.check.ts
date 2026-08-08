/**
 * Conformance plus property tests for the persistent BIT.
 *
 *     node packages/plugins/persistent-bit/src/plugin.check.ts
 */

import { createRng, help, layout, parseCommand, type OperationError } from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { persistentBit as plugin } from './plugin.ts';

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

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, ['build [3 1 4 1 5 9 2 6]', 'add v0 3 5', 'prefix v1 5'])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. Correctness ────────────────────────────────────────────────── */

console.log('\ncorrectness');

const ARR = [3, 1, 4, 1, 5, 9, 2, 6];
const inst = fresh();
run(inst, `build [${ARR.join(' ')}]`);

check('build reports the total', (run(inst, 'prefix v0 8').value as { sum: number }).sum === 31,
  `${(run(inst, 'prefix v0 8').value as { sum: number }).sum}`);
check('prefix sums match a plain scan', (() => {
  for (let k = 0; k <= ARR.length; k += 1) {
    const expected = ARR.slice(0, k).reduce((a, b) => a + b, 0);
    if ((run(inst, `prefix v0 ${k}`).value as { sum: number }).sum !== expected) return false;
  }
  return true;
})(), '9 prefixes');
check('a prefix costs O(log n) visits',
  (run(inst, 'prefix v0 7').value as { visits: number }).visits === 3,
  `${(run(inst, 'prefix v0 7').value as { visits: number }).visits} cells for k=7 (binary 111)`);

run(inst, 'add v0 3 5');
check('an update copies only the upward walk',
  (() => { const r = run(inst, 'add v1 3 0').value as { allocated: number }; return r.allocated === 3; })(),
  'index 3 -> 4 -> 8');
check('the new version sees the change',
  (run(inst, 'prefix v1 3').value as { sum: number }).sum === 13);
check('the old version is untouched',
  (run(inst, 'prefix v0 3').value as { sum: number }).sum === 8);

check('1-indexing is enforced at both ends', (() => {
  const lo = run(inst, 'add v0 0 1').error?.code;
  const hi = run(inst, 'add v0 9 1').error?.code;
  return lo === 'INDEX_OUT_OF_RANGE' && hi === 'INDEX_OUT_OF_RANGE';
})());
check('an unknown version is refused with the list',
  (run(inst, 'prefix v9 1').error?.hint ?? '').includes('v0'));

/* ── 3. The forest ─────────────────────────────────────────────────── */

console.log('\nforest shape');

check('a power-of-two size has one root', (() => {
  const p = fresh();
  run(p, 'build [1 1 1 1 1 1 1 1]');
  return p.getStructure().roots.length === 1;
})());
check('a non-power-of-two size has several', (() => {
  const p = fresh();
  run(p, 'build [1 1 1 1 1 1]');
  // n=6: cells 4 and 6 have no parent inside the array.
  return p.getStructure().roots.length === 2;
})(), 'n=6 gives roots at 4 and 6');
check('every version records its own roots', (() => {
  const p = fresh();
  run(p, 'build [1 1 1 1 1 1]');
  run(p, 'add v0 2 1');
  return p.getStructure().roots.length === 4;
})(), 'two versions x two roots');

/* ── 4. Layout ─────────────────────────────────────────────────────── */

console.log('\nlayout');

const laid = fresh();
run(laid, 'build [3 1 4 1 5 9 2 6]');
run(laid, 'add v0 3 5');
const scene = layout(laid.getStructure());

check('cells are drawn in index order, not traversal order', (() => {
  const first = new Map<number, number>();
  for (const n of scene.nodes) {
    const index = Number(n.node.slot.slice(1));
    if (!first.has(index)) first.set(index, n.x);
  }
  const xs = [...first.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => x);
  return xs.every((x, i) => i === 0 || x > (xs[i - 1] as number));
})(), '1..8 left to right');
check('wider cells sit higher', (() => {
  const depth = (i: number): number =>
    scene.nodes.find((n) => n.node.slot === `i${i}`)?.y ?? Number.NaN;
  return depth(8) < depth(4) && depth(4) < depth(2) && depth(2) < depth(1);
})());
check('no two cells overlap on a row', (() => {
  const rows = new Map<number, { x: number; width: number }[]>();
  for (const n of scene.nodes) rows.set(n.y, [...(rows.get(n.y) ?? []), { x: n.x, width: n.width }]);
  for (const row of rows.values()) {
    const sorted = [...row].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i += 1) {
      const a = sorted[i - 1] as { x: number; width: number };
      const b = sorted[i] as { x: number; width: number };
      if (b.x - a.x < (a.width + b.width) / 2) return false;
    }
  }
  return true;
})(), `${Math.round(scene.width)} x ${Math.round(scene.height)} px`);

/* ── 5. Property test against a plain array ────────────────────────── */

console.log('\nproperty test vs a plain array');

const rng = createRng(20_260_808);
let trials = 0;
let queries = 0;
let firstFailure = '';

for (let t = 0; t < 25 && firstFailure === ''; t += 1) {
  const n = rng.nextInt(1, 12);
  const base = Array.from({ length: n }, () => rng.nextInt(-20, 20));
  const p = fresh();
  run(p, `build [${base.join(' ')}]`);
  const models = [[...base]];
  trials += 1;

  for (let op = 0; op < 6 && firstFailure === ''; op += 1) {
    const from = rng.nextInt(0, models.length - 1);
    const index = rng.nextInt(1, n);
    const delta = rng.nextInt(-15, 15);
    const r = run(p, `add v${from} ${index} ${delta}`);
    if (r.error !== null) { firstFailure = `add failed: ${r.error.code}`; break; }
    const next = [...(models[from] as number[])];
    next[index - 1] = (next[index - 1] as number) + delta;
    models.push(next);

    // Every version must still answer every prefix correctly.
    for (let v = 0; v < models.length && firstFailure === ''; v += 1) {
      for (let k = 0; k <= n; k += 1) {
        queries += 1;
        const expected = (models[v] as number[]).slice(0, k).reduce((a, b) => a + b, 0);
        const got = (run(p, `prefix v${v} ${k}`).value as { sum: number }).sum;
        if (got !== expected) {
          firstFailure = `v${v} prefix ${k}: got ${got}, expected ${expected}`;
          break;
        }
      }
    }
  }
}

check('every version answers every prefix correctly', firstFailure === '',
  firstFailure === '' ? `${trials} trials, ${queries} queries` : firstFailure);

/* ── 6. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build [3 1 4 1 5 9 2 6]', 'add v0 3 5', 'prefix v0 4', 'prefix v1 4', 'compare v0 v1']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
