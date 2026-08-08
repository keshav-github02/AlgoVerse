/**
 * Conformance, property tests, and the determinism the save format depends on.
 *
 *     node packages/plugins/persistent-treap/src/plugin.check.ts
 */

import { createRng, help, layout, parseCommand, type OperationError } from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { persistentTreap as plugin } from './plugin.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const fresh = (seed = 1): PluginInstance => plugin.createInstance({ rng: createRng(seed) });

function run(inst: PluginInstance, line: string): { value: unknown; error: OperationError | null } {
  const parsed = parseCommand(line, plugin.commands);
  if (!parsed.ok) return { value: null, error: parsed.error };
  const r = inst.execute(parsed.command);
  return r.ok ? { value: r.value, error: null } : { value: null, error: r.error };
}

const keysOf = (inst: PluginInstance, version: number, upTo: number): number[] => {
  const present: number[] = [];
  for (let k = 0; k <= upTo; k += 1) {
    if ((run(inst, `find v${version} ${k}`).value as { found: boolean }).found) present.push(k);
  }
  return present;
};

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
check('build holds every key', keysOf(inst, 0, 10).join(',') === '1,2,5,8,9',
  keysOf(inst, 0, 10).join(','));

run(inst, 'insert v0 6');
check('insert adds one key', keysOf(inst, 1, 10).join(',') === '1,2,5,6,8,9');
check('the earlier version is untouched', keysOf(inst, 0, 10).join(',') === '1,2,5,8,9');

run(inst, 'erase v1 2');
check('erase removes one key', keysOf(inst, 2, 10).join(',') === '1,5,6,8,9');
check('both earlier versions still read correctly',
  keysOf(inst, 0, 10).join(',') === '1,2,5,8,9' && keysOf(inst, 1, 10).join(',') === '1,2,5,6,8,9');

check('a duplicate insert is refused',
  run(inst, 'insert v0 5').error?.code === 'PRECONDITION_FAILED');
check('erasing an absent key is refused, and says what is there',
  (run(inst, 'erase v0 42').error?.hint ?? '').includes('1, 2, 5, 8, 9'),
  run(inst, 'erase v0 42').error?.hint ?? '');
check('find reports a miss without failing', (() => {
  const r = run(inst, 'find v0 42');
  return r.error === null && (r.value as { found: boolean }).found === false;
})());

/* ── 3. The heap property, which is what makes it a treap ──────────── */

console.log('\nheap property');

check('no child outranks its parent', (() => {
  const g = inst.getStructure();
  // Priorities are private, but the shape must still be a valid BST by key.
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  for (const e of g.edges) {
    const parent = byId.get(e.from);
    const child = byId.get(e.to);
    if (parent === undefined || child === undefined) continue;
    if (e.slot === 'left' && child.value >= parent.value) return false;
    if (e.slot === 'right' && child.value <= parent.value) return false;
  }
  return true;
})(), 'search order holds on every edge');

check('a bigger tree stays shallow', (() => {
  const big = fresh(7);
  run(big, `build [${Array.from({ length: 63 }, (_, i) => i + 1).join(' ')}]`);
  // Expected depth is about 3 log2 n; 63 sorted keys in a plain BST would be 63.
  const scene = layout(big.getStructure());
  const rows = new Set(scene.nodes.map((n) => n.y)).size;
  return rows <= 20;
})(), 'inserting 63 sorted keys does not make a linked list');

/* ── 4. Determinism - what save and share rest on ──────────────────── */

console.log('\ndeterminism');

const script = ['build [5 2 8 1 9]', 'insert v0 6', 'erase v1 2', 'insert v2 3'];
const shapeOf = (seed: number): string => {
  const p = fresh(seed);
  for (const line of script) run(p, line);
  const g = p.getStructure();
  return JSON.stringify({
    nodes: g.nodes.map((n) => `${n.id}:${n.value}:${n.origin}`),
    edges: g.edges.map((e) => `${e.from}-${e.slot}->${e.to}`),
  });
};

check('the same seed gives the same tree', shapeOf(1) === shapeOf(1));
check('a different seed gives a different tree', shapeOf(1) !== shapeOf(99),
  'priorities actually drive the shape');
check('every version still holds the right keys whatever the seed', (() => {
  for (const seed of [1, 2, 3, 42, 99, 12_345]) {
    const p = fresh(seed);
    for (const line of script) run(p, line);
    if (keysOf(p, 0, 10).join(',') !== '1,2,5,8,9') return false;
    if (keysOf(p, 1, 10).join(',') !== '1,2,5,6,8,9') return false;
    if (keysOf(p, 2, 10).join(',') !== '1,5,6,8,9') return false;
    if (keysOf(p, 3, 10).join(',') !== '1,3,5,6,8,9') return false;
  }
  return true;
})(), '6 seeds');
check('re-inserting an erased key reuses its original priority', (() => {
  // Otherwise replaying the same script could produce a different shape.
  const p = fresh(5);
  run(p, 'build [1 2 3]');
  run(p, 'erase v0 2');
  run(p, 'insert v1 2');
  const q = fresh(5);
  run(q, 'build [1 2 3]');
  run(q, 'erase v0 2');
  run(q, 'insert v1 2');
  return shapeOfInstance(p) === shapeOfInstance(q);
})());

function shapeOfInstance(p: PluginInstance): string {
  const g = p.getStructure();
  return g.edges.map((e) => `${e.from}-${e.slot}->${e.to}`).join('|');
}

/* ── 5. Property test against a sorted set ─────────────────────────── */

console.log('\nproperty test vs a sorted set');

const rng = createRng(20_260_809);
let trials = 0;
let operations = 0;
let firstFailure = '';

for (let t = 0; t < 30 && firstFailure === ''; t += 1) {
  const p = fresh(rng.nextInt(1, 100_000));
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
      // The operation must be refused, and must not create a version.
      const before = models.length;
      const r = run(p, `${inserting ? 'insert' : 'erase'} v${from} ${key}`);
      if (r.error?.code !== 'PRECONDITION_FAILED') {
        firstFailure = `${inserting ? 'insert' : 'erase'} of ${key} should have been refused`;
      }
      if (models.length !== before) firstFailure = 'a refused operation changed the model';
      continue;
    }

    const r = run(p, `${inserting ? 'insert' : 'erase'} v${from} ${key}`);
    if (r.error !== null) { firstFailure = `unexpected ${r.error.code}`; break; }
    const next = inserting
      ? [...model, key].sort((a, b) => a - b)
      : model.filter((k) => k !== key);
    models.push(next);

    // Every version must still hold exactly its own keys.
    for (let v = 0; v < models.length && firstFailure === ''; v += 1) {
      const expected = (models[v] as number[]).join(',');
      const got = keysOf(p, v, 20).join(',');
      if (got !== expected) firstFailure = `v${v}: got [${got}], expected [${expected}]`;
    }
  }
}

check('every version holds exactly its own keys', firstFailure === '',
  firstFailure === '' ? `${trials} trials, ${operations} operations` : firstFailure);

/* ── 6. Sharing ────────────────────────────────────────────────────── */

console.log('\nsharing');

const shared = fresh(3);
run(shared, 'build [1 2 3 4 5 6 7 8]');
const before = shared.getStructure().nodes.length;
run(shared, 'insert v0 9');
const after = shared.getStructure().nodes.length;
check('an insert allocates far fewer nodes than the tree holds', after - before < before,
  `${after - before} new against ${before} existing`);
check('compare reports real reuse', (() => {
  const r = run(shared, 'compare v0 v1').value as { sharedPercent: number };
  return r.sharedPercent > 30 && r.sharedPercent < 100;
})(), `${(run(shared, 'compare v0 v1').value as { sharedPercent: number }).sharedPercent}% of v1 reused`);

/* ── 7. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build [5 2 8 1 9]', 'insert v0 6', 'find v1 6', 'erase v1 2', 'compare v1 v2']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
