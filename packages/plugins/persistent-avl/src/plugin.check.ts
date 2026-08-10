/**
 * Conformance, the AVL invariant, and the contrast with an unbalanced tree.
 *
 *     node packages/plugins/persistent-avl/src/plugin.check.ts
 */

import { createRng, help, parseCommand, type OperationError, type StructureGraph } from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { persistentAvl as plugin } from './plugin.ts';

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

const keysOf = (inst: PluginInstance, v: number, upTo: number): number[] => {
  const out: number[] = [];
  for (let k = 0; k <= upTo; k += 1) {
    if ((run(inst, `find v${v} ${k}`).value as { found: boolean }).found) out.push(k);
  }
  return out;
};

/**
 * Recomputes every subtree height from the graph and reports the worst
 * imbalance found. Deriving it independently means a wrong stored height
 * cannot make the tree look balanced when it is not.
 */
function worstImbalance(graph: StructureGraph, roots: readonly number[]): number {
  const kids = new Map<number, { left?: number; right?: number }>();
  for (const e of graph.edges) {
    const slot = kids.get(e.from) ?? {};
    if (e.slot === 'left') slot.left = e.to;
    else slot.right = e.to;
    kids.set(e.from, slot);
  }
  let worst = 0;
  const heightOf = (id: number | undefined): number => {
    if (id === undefined) return 0;
    const { left, right } = kids.get(id) ?? {};
    const lh = heightOf(left);
    const rh = heightOf(right);
    worst = Math.max(worst, Math.abs(lh - rh));
    return 1 + Math.max(lh, rh);
  };
  for (const r of roots) heightOf(r);
  return worst;
}

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, ['build [5 2 8 1 9]', 'insert v0 6', 'erase v1 2', 'find v2 8'])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. Correctness ────────────────────────────────────────────────── */

console.log('\ncorrectness');

const inst = fresh();
run(inst, 'build [5 2 8 1 9]');
check('build holds every key', keysOf(inst, 0, 10).join(',') === '1,2,5,8,9');

run(inst, 'insert v0 6');
check('insert adds one key', keysOf(inst, 1, 10).join(',') === '1,2,5,6,8,9');
check('the earlier version is untouched', keysOf(inst, 0, 10).join(',') === '1,2,5,8,9');

run(inst, 'erase v1 2');
check('erase removes one key', keysOf(inst, 2, 10).join(',') === '1,5,6,8,9');
check('both earlier versions still read correctly',
  keysOf(inst, 0, 10).join(',') === '1,2,5,8,9' && keysOf(inst, 1, 10).join(',') === '1,2,5,6,8,9');
check('erasing a node with two children keeps search order', (() => {
  const p = fresh();
  run(p, 'build [5 3 8 2 4 7 9]');
  run(p, 'erase v0 3');
  return keysOf(p, 1, 10).join(',') === '2,4,5,7,8,9';
})());
check('a duplicate insert is refused',
  run(inst, 'insert v0 5').error?.code === 'PRECONDITION_FAILED');
check('erasing an absent key is refused',
  run(inst, 'erase v0 42').error?.code === 'PRECONDITION_FAILED');

/* ── 3. Rotations happen, and are visible ──────────────────────────── */

console.log('\nrotations');

check('three ascending keys rotate the middle one to the root', (() => {
  const p = fresh();
  run(p, 'build [1]');
  run(p, 'insert v0 2');
  const r = run(p, 'insert v1 3').value as { rotations: number; height: number };
  const g = p.getStructure();
  const root = g.roots[g.roots.length - 1];
  const rootKey = g.nodes.find((n) => n.id === root)?.value;
  return r.rotations === 1 && rootKey === 2 && r.height === 2;
})(), 'one rotation, root becomes 2, height 2 not 3');

check('a left-right case costs two rotations', (() => {
  const p = fresh();
  run(p, 'build [3]');
  run(p, 'insert v0 1');
  const r = run(p, 'insert v1 2').value as { rotations: number };
  return r.rotations === 2;
})());

check('erase rotates when it shortens the wrong side', (() => {
  // 2(1, 3(_,4)) is legal: the root leans right by one. Removing 1 makes it
  // lean right by two, so the root must rotate away.
  const p = fresh();
  run(p, 'build [2 1 3 4]');
  const r = run(p, 'erase v0 1').value as { rotations: number; height: number };
  const g = p.getStructure();
  const rootKey = g.nodes.find((n) => n.id === g.roots[g.roots.length - 1])?.value;
  return r.rotations === 1 && rootKey === 3 && r.height === 2;
})(), 'root moves from 2 to 3');

check('a balanced insert rotates nothing', (() => {
  const p = fresh();
  run(p, 'build [2 1 3]');
  const r = run(p, 'insert v0 4').value as { rotations: number };
  return r.rotations === 0;
})());

/* ── 4. The invariant, recomputed independently ─────────────────────── */

console.log('\nthe AVL invariant');

check('no node ever leans by more than one level', (() => {
  const p = fresh();
  run(p, `build [${Array.from({ length: 40 }, (_, i) => i + 1).join(' ')}]`);
  for (let k = 1; k <= 20; k += 1) run(p, `erase v${k - 1} ${k}`);
  const g = p.getStructure();
  return worstImbalance(g, g.roots as unknown as number[]) <= 1;
})(), '40 sorted inserts then 20 erases, every version checked');

check('the role on every node agrees with its actual heights', (() => {
  const p = fresh();
  run(p, 'build [5 2 8 1 9 3 7 4 6]');
  const g = p.getStructure();
  const allowed = new Set(['balanced', 'left-heavy', 'right-heavy']);
  return g.nodes.every((n) => allowed.has(n.role));
})());

check('height stays within the AVL bound', (() => {
  for (const n of [15, 31, 63, 127, 255]) {
    const p = fresh();
    const r = run(p, `build [${Array.from({ length: n }, (_, i) => i + 1).join(' ')}]`).value as
      { height: number };
    // AVL guarantees height < 1.4405 log2(n+2) - 0.3277.
    if (r.height > 1.4405 * Math.log2(n + 2) - 0.3277) return false;
  }
  return true;
})(), 'checked at 15, 31, 63, 127 and 255 keys');

/* ── 5. The contrast with the unbalanced tree ──────────────────────── */

console.log('\nwhat balancing buys');

const sorted = Array.from({ length: 64 }, (_, i) => i + 1);
const avl = fresh();
const built = run(avl, `build [${sorted.join(' ')}]`).value as { height: number };
const worstLookup = (run(avl, 'find v0 64').value as { visits: number }).visits;

check('64 sorted keys build a shallow tree, not a chain', built.height <= 7,
  `height ${built.height} where an unbalanced tree would be 64`);
check('the worst lookup is logarithmic', worstLookup <= 7,
  `${worstLookup} nodes visited, against 64 for the plain BST`);

/* ── 6. Property test against a sorted set ─────────────────────────── */

console.log('\nproperty test vs a sorted set');

const rng = createRng(20_260_812);
let trials = 0;
let operations = 0;
let firstFailure = '';

for (let t = 0; t < 30 && firstFailure === ''; t += 1) {
  const p = fresh();
  const start = [...new Set(Array.from({ length: rng.nextInt(1, 8) }, () => rng.nextInt(0, 20)))];
  run(p, `build [${start.join(' ')}]`);
  const models: number[][] = [[...start].sort((a, b) => a - b)];
  trials += 1;

  for (let op = 0; op < 8 && firstFailure === ''; op += 1) {
    const from = rng.nextInt(0, models.length);
    const model = models[from] as number[];
    const key = rng.nextInt(0, 20);
    const inserting = rng.next() < 0.6;
    operations += 1;

    if (inserting === model.includes(key)) {
      if (run(p, `${inserting ? 'insert' : 'erase'} v${from} ${key}`).error?.code !== 'PRECONDITION_FAILED') {
        firstFailure = `${inserting ? 'insert' : 'erase'} ${key} should have been refused`;
      }
      continue;
    }

    if (run(p, `${inserting ? 'insert' : 'erase'} v${from} ${key}`).error !== null) {
      firstFailure = 'unexpected error';
      break;
    }
    models.push(inserting
      ? [...model, key].sort((a, b) => a - b)
      : model.filter((k) => k !== key));

    for (let v = 0; v < models.length && firstFailure === ''; v += 1) {
      const expected = (models[v] as number[]).join(',');
      const got = keysOf(p, v, 20).join(',');
      if (got !== expected) firstFailure = `v${v}: got [${got}], expected [${expected}]`;
    }
    // Rebalancing must not break the invariant in any version, ever.
    const g = p.getStructure();
    if (firstFailure === '' && worstImbalance(g, g.roots as unknown as number[]) > 1) {
      firstFailure = 'a version is out of balance';
    }
  }
}

check('every version holds its keys and stays balanced', firstFailure === '',
  firstFailure === '' ? `${trials} trials, ${operations} operations` : firstFailure);

/* ── 7. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build [1]', 'insert v0 2', 'insert v1 3', 'insert v2 4', 'find v3 4']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
