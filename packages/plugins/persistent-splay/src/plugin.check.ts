/**
 * Conformance, splay behaviour, and the amortised bound a single operation
 * cannot demonstrate.
 *
 *     node packages/plugins/persistent-splay/src/plugin.check.ts
 */

import { createRng, help, parseCommand, type OperationError, type StructureGraph } from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { persistentSplay as plugin } from './plugin.ts';

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

/** `contains` never reshapes, so it is the safe way to read a version. */
const keysOf = (inst: PluginInstance, v: number, upTo: number): number[] => {
  const out: number[] = [];
  for (let k = 0; k <= upTo; k += 1) {
    if ((run(inst, `contains v${v} ${k}`).value as { found: boolean }).found) out.push(k);
  }
  return out;
};

const rootKeyOf = (inst: PluginInstance, version: number): number | undefined => {
  const g: StructureGraph = inst.getStructure();
  const root = g.roots[version];
  return g.nodes.find((n) => n.id === root)?.value;
};

/** Search order, recomputed from the graph rather than taken on trust. */
function searchOrderHolds(graph: StructureGraph): boolean {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const e of graph.edges) {
    const parent = byId.get(e.from);
    const child = byId.get(e.to);
    if (parent === undefined || child === undefined) continue;
    if (e.slot === 'left' && child.value >= parent.value) return false;
    if (e.slot === 'right' && child.value <= parent.value) return false;
  }
  return true;
}

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, ['build [5 2 8 1 9]', 'insert v0 6', 'access v1 2', 'contains v2 8'])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. Correctness ────────────────────────────────────────────────── */

console.log('\ncorrectness');

const inst = fresh();
run(inst, 'build [5 2 8 1 9]');
check('build holds every key', keysOf(inst, 0, 10).join(',') === '1,2,5,8,9');
check('the last key inserted is the root', rootKeyOf(inst, 0) === 9, `root is ${rootKeyOf(inst, 0)}`);

run(inst, 'insert v0 6');
check('insert adds one key', keysOf(inst, 1, 10).join(',') === '1,2,5,6,8,9');
check('the inserted key becomes the root', rootKeyOf(inst, 1) === 6);
check('the earlier version is untouched', keysOf(inst, 0, 10).join(',') === '1,2,5,8,9');
check('a duplicate insert is refused',
  run(inst, 'insert v0 5').error?.code === 'PRECONDITION_FAILED');
check('contains reports a miss without failing',
  (run(inst, 'contains v0 42').value as { found: boolean }).found === false);
check('an unknown version is refused with the list',
  (run(inst, 'contains v9 1').error?.hint ?? '').includes('v0'));

/* ── 3. Reading is writing ─────────────────────────────────────────── */

console.log('\nreading is writing');

const reader = fresh();
run(reader, 'build [1 2 3 4 5 6 7]');
const versionsBefore = reader.getStructure().roots.length;
const accessed = run(reader, 'access v0 1').value as
  { found: boolean; version: number; atRoot: number; rotations: number };

check('access finds the key', accessed.found && accessed.atRoot === 1);
check('access creates a version', reader.getStructure().roots.length === versionsBefore + 1,
  `v${accessed.version} is the tree after reading it`);
check('the key it found is now the root', rootKeyOf(reader, accessed.version) === 1);
check('the version that was read keeps its old shape', rootKeyOf(reader, 0) === 7,
  'v0 still rooted at 7');
check('both versions hold the same keys',
  keysOf(reader, 0, 10).join(',') === keysOf(reader, accessed.version, 10).join(','),
  'the shape moved, the contents did not');
check('accessing rotates', accessed.rotations > 0, `${accessed.rotations} rotations`);

check('contains changes nothing', (() => {
  const p = fresh();
  run(p, 'build [1 2 3 4 5]');
  const before = p.getStructure().roots.length;
  run(p, 'contains v0 1');
  return p.getStructure().roots.length === before && rootKeyOf(p, 0) === 5;
})(), 'the read-only command really is read-only');

check('a missing key still splays the last node reached', (() => {
  const p = fresh();
  run(p, 'build [10 20 30]');
  const r = run(p, 'access v0 25').value as { found: boolean; atRoot: number };
  return !r.found && (r.atRoot === 20 || r.atRoot === 30);
})());

check('search order survives every splay', (() => {
  const p = fresh();
  run(p, `build [${Array.from({ length: 30 }, (_, i) => i + 1).join(' ')}]`);
  for (let i = 0; i < 20; i += 1) {
    run(p, `access v${i} ${((i * 7) % 30) + 1}`);
    if (!searchOrderHolds(p.getStructure())) return false;
  }
  return true;
})(), '20 successive accesses, checked each time');

/* ── 4. The amortised bound ────────────────────────────────────────── */

console.log('\nthe amortised bound');

check('one access on a spine is genuinely expensive', (() => {
  const p = fresh();
  // Ascending inserts leave a left spine: every key is on one path.
  run(p, `build [${Array.from({ length: 64 }, (_, i) => i + 1).join(' ')}]`);
  const r = run(p, 'access v0 1').value as { visits: number };
  return r.visits >= 32;
})(), (() => {
  const p = fresh();
  run(p, `build [${Array.from({ length: 64 }, (_, i) => i + 1).join(' ')}]`);
  return `${(run(p, 'access v0 1').value as { visits: number }).visits} nodes for the first access`;
})());

check('a run of accesses averages out to something logarithmic', (() => {
  const p = fresh();
  const n = 64;
  run(p, `build [${Array.from({ length: n }, (_, i) => i + 1).join(' ')}]`);
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    total += (run(p, `access v${i} ${((i * 13) % n) + 1}`).value as { visits: number }).visits;
  }
  // 64 accesses on a spine: linear each time would be ~2000 reads.
  return total / n < 3 * Math.log2(n);
})(), (() => {
  const p = fresh();
  const n = 64;
  run(p, `build [${Array.from({ length: n }, (_, i) => i + 1).join(' ')}]`);
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    total += (run(p, `access v${i} ${((i * 13) % n) + 1}`).value as { visits: number }).visits;
  }
  return `${(total / n).toFixed(1)} nodes average over 64 accesses, against ${n} for the first`;
})());

check('touching the same key twice is cheap the second time', (() => {
  const p = fresh();
  run(p, `build [${Array.from({ length: 40 }, (_, i) => i + 1).join(' ')}]`);
  const first = (run(p, 'access v0 1').value as { visits: number }).visits;
  const second = (run(p, 'access v1 1').value as { visits: number }).visits;
  return second === 1 && first > second;
})(), 'the second access reads one node');

/* ── 5. Property test against a sorted set ─────────────────────────── */

console.log('\nproperty test vs a sorted set');

const rng = createRng(20_260_814);
let trials = 0;
let operations = 0;
let firstFailure = '';

for (let t = 0; t < 25 && firstFailure === ''; t += 1) {
  const p = fresh();
  const start = [...new Set(Array.from({ length: rng.nextInt(1, 8) }, () => rng.nextInt(0, 25)))];
  run(p, `build [${start.join(' ')}]`);
  const models: number[][] = [[...start].sort((a, b) => a - b)];
  trials += 1;

  for (let op = 0; op < 10 && firstFailure === ''; op += 1) {
    const from = rng.nextInt(0, models.length);
    const model = models[from] as number[];
    const key = rng.nextInt(0, 25);
    const inserting = rng.next() < 0.5;
    operations += 1;

    if (inserting) {
      if (model.includes(key)) {
        if (run(p, `insert v${from} ${key}`).error?.code !== 'PRECONDITION_FAILED') {
          firstFailure = `re-inserting ${key} should have been refused`;
        }
        continue;
      }
      if (run(p, `insert v${from} ${key}`).error !== null) { firstFailure = 'insert failed'; break; }
      models.push([...model, key].sort((a, b) => a - b));
    } else {
      // An access must preserve the contents exactly while changing the shape.
      const r = run(p, `access v${from} ${key}`);
      if (r.error !== null) { firstFailure = 'access failed'; break; }
      if ((r.value as { found: boolean }).found !== model.includes(key)) {
        firstFailure = `access reported the wrong answer for ${key}`;
        break;
      }
      models.push([...model]);
    }

    for (let v = 0; v < models.length && firstFailure === ''; v += 1) {
      const expected = (models[v] as number[]).join(',');
      const got = keysOf(p, v, 25).join(',');
      if (got !== expected) firstFailure = `v${v}: got [${got}], expected [${expected}]`;
    }
    if (firstFailure === '' && !searchOrderHolds(p.getStructure())) {
      firstFailure = 'search order broke';
    }
  }
}

check('every version keeps its keys, and reading never loses one', firstFailure === '',
  firstFailure === '' ? `${trials} trials, ${operations} operations` : firstFailure);

/* ── 6. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build [1 2 3 4 5 6 7]', 'access v0 1', 'access v1 1', 'contains v0 1', 'compare v0 v1']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
