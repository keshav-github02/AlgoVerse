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

/* ── Ranges and the descent ────────────────────────────────────────── */

console.log('\nranges and descent');

check('a range is the difference of two prefixes', (() => {
  const q = fresh();
  run(q, 'build [3 1 4 1 5 9 2 6]');
  const all = run(q, 'range v0 1 8').value as { sum: number };
  const middle = run(q, 'range v0 3 5').value as { sum: number };
  const one = run(q, 'range v0 4 4').value as { sum: number };
  return all.sum === 31 && middle.sum === 10 && one.sum === 1;
})(), 'both ends included');

check('a range agrees with the two prefixes it is made of', (() => {
  const q = fresh();
  run(q, 'build [3 1 4 1 5 9 2 6]');
  const upper = (run(q, 'prefix v0 6').value as { sum: number }).sum;
  const lower = (run(q, 'prefix v0 2').value as { sum: number }).sum;
  const direct = (run(q, 'range v0 3 6').value as { sum: number }).sum;
  return direct === upper - lower;
})());

check('a backwards or out-of-bounds range is refused', (() => {
  const q = fresh();
  run(q, 'build [1 2 3]');
  return run(q, 'range v0 3 2').error?.code === 'INVALID_RANGE'
    && run(q, 'range v0 0 2').error?.code === 'INVALID_RANGE'
    && run(q, 'range v0 1 9').error?.code === 'INVALID_RANGE';
})(), 'the structure is 1-indexed, so 0 is out');

check('kth finds where the running total first reaches k', (() => {
  const q = fresh();
  run(q, 'build [2 0 3 1]');
  // running totals: 2, 2, 5, 6
  const first = (run(q, 'kth v0 1').value as { index: number }).index;
  const edge = (run(q, 'kth v0 2').value as { index: number }).index;
  const third = (run(q, 'kth v0 3').value as { index: number }).index;
  const last = (run(q, 'kth v0 6').value as { index: number }).index;
  return first === 1 && edge === 1 && third === 3 && last === 4;
})(), 'k = 2 stops at index 1, because index 2 adds nothing');

check('kth refuses rather than guessing when an entry is negative', (() => {
  const q = fresh();
  run(q, 'build [3 -1 4]');
  const r = run(q, 'kth v0 2');
  return r.error?.code === 'PRECONDITION_FAILED' && r.error.message.includes('negative');
})());

check('the negative count follows writes, in both directions', (() => {
  // It is maintained rather than recomputed, so it has to be right after a
  // value goes negative and again after it comes back.
  const q = fresh();
  run(q, 'build [5 5 5]');
  const clean = run(q, 'kth v0 6').error === null;
  run(q, 'add v0 2 -20');
  const dirty = run(q, 'kth v1 6').error?.code === 'PRECONDITION_FAILED';
  run(q, 'add v1 2 20');
  const cleanAgain = run(q, 'kth v2 6').error === null;
  return clean && dirty && cleanAgain;
})(), 'refuses once an entry goes below zero, and answers again once it does not');

check('kth refuses a k the array never reaches', (() => {
  const q = fresh();
  run(q, 'build [1 2 3]');
  return run(q, 'kth v0 7').error?.code === 'PRECONDITION_FAILED'
    && run(q, 'kth v0 0').error?.code === 'BAD_ARGUMENT';
})());

check('kth descends once instead of scanning', (() => {
  const q = fresh();
  run(q, `build [${Array.from({ length: 256 }, () => 1).join(' ')}]`);
  const r = run(q, 'kth v0 200').value as { index: number; visits: number };
  return r.index === 200 && r.visits <= 9;
})(), (() => {
  const q = fresh();
  run(q, `build [${Array.from({ length: 256 }, () => 1).join(' ')}]`);
  const r = run(q, 'kth v0 200').value as { visits: number };
  return `${r.visits} cells visited for 256 entries`;
})());

check('older versions keep their own answers', (() => {
  const q = fresh();
  run(q, 'build [1 1 1 1]');
  run(q, 'add v0 1 10');
  const older = (run(q, 'kth v0 3').value as { index: number }).index;
  const newer = (run(q, 'kth v1 3').value as { index: number }).index;
  return older === 3 && newer === 1;
})(), 'v0 needs three entries to reach 3; v1 gets there at the first');

/* ── Property test: ranges and descent vs a plain array ────────────── */

console.log('\nproperty test vs a plain array');

{
  const rng2 = createRng(20_260_822);
  let trials2 = 0;
  let queries2 = 0;
  let failure = '';

  for (let t = 0; t < 40 && failure === ''; t += 1) {
    const n = rng2.nextInt(1, 15);
    // Non-negative to start, so kth applies; some trials then break that.
    const start = Array.from({ length: n }, () => rng2.nextInt(0, 12));
    const q = fresh();
    run(q, `build [${start.join(' ')}]`);
    const model: number[][] = [[...start]];

    for (let op = 0; op < 6; op += 1) {
      const v = rng2.nextInt(0, model.length);
      const i = rng2.nextInt(1, n + 1);
      const delta = rng2.nextInt(-6, 12);
      const r = run(q, `add v${v} ${i} ${delta}`);
      if (r.error !== null) { failure = `add failed: ${r.error.code}`; break; }
      const next = [...(model[v] as number[])];
      next[i - 1] = (next[i - 1] as number) + delta;
      model.push(next);
    }

    for (let v = 0; v < model.length && failure === ''; v += 1) {
      const arr = model[v] as number[];

      for (let attempt = 0; attempt < 4; attempt += 1) {
        let lo = rng2.nextInt(1, n + 1);
        let hi = rng2.nextInt(1, n + 1);
        if (lo > hi) [lo, hi] = [hi, lo];
        const expected = arr.slice(lo - 1, hi).reduce((a, b) => a + b, 0);
        const r = run(q, `range v${v} ${lo} ${hi}`);
        queries2 += 1;
        const got = (r.value as { sum: number } | null)?.sum;
        if (r.error !== null || got !== expected) {
          failure = `range v${v} ${lo} ${hi} gave ${r.error?.code ?? String(got)}, expected ${expected}`;
          break;
        }
      }
      if (failure !== '') break;

      /*
       * kth must answer exactly when every entry is non-negative, and must
       * refuse otherwise - a wrong index would be worse than no index.
       */
      const total = arr.reduce((a, b) => a + b, 0);
      const clean = arr.every((x) => x >= 0);
      if (total > 0) {
        const k = rng2.nextInt(1, total + 1);
        const r = run(q, `kth v${v} ${k}`);
        queries2 += 1;
        if (!clean) {
          if (r.error?.code !== 'PRECONDITION_FAILED') {
            failure = `kth v${v} ${k} answered over a negative entry`;
            break;
          }
        } else {
          let running = 0;
          let expected = -1;
          for (let i = 0; i < n; i += 1) {
            running += arr[i] as number;
            if (running >= k) { expected = i + 1; break; }
          }
          const got = (r.value as { index: number } | null)?.index;
          if (r.error !== null || got !== expected) {
            failure = `kth v${v} ${k} gave ${r.error?.code ?? String(got)}, expected ${expected}`;
            break;
          }
        }
      }
    }
    trials2 += 1;
  }

  check('ranges and descents agree with a plain array, every version',
    failure === '',
    failure === '' ? `${trials2} trials, ${queries2} queries` : failure);
}
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
