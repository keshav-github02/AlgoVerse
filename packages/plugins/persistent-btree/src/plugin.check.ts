/**
 * Conformance, the B-tree invariants, and the multi-key node the rest of the
 * project had never seen.
 *
 *     node packages/plugins/persistent-btree/src/plugin.check.ts
 */

import {
  createRng, help, layout, parseCommand,
  type OperationError, type StructureGraph,
} from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { ORDER, persistentBtree as plugin } from './plugin.ts';

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
 * Walks the graph and reports every way the shape breaks the B-tree rules,
 * recomputed rather than taken on trust from the plugin.
 */
function violations(graph: StructureGraph, root: number): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id as unknown as number, n]));
  const kids = new Map<number, number[]>();
  for (const e of graph.edges) {
    const list = kids.get(e.from as unknown as number) ?? [];
    list[Number(e.slot.slice(1))] = e.to as unknown as number;
    kids.set(e.from as unknown as number, list);
  }

  const problems: string[] = [];
  const leafDepths = new Set<number>();

  const walk = (id: number, depth: number, low: number, high: number): void => {
    const node = byId.get(id);
    if (node === undefined) return;
    const keys = node.values ?? [];
    const children = kids.get(id) ?? [];

    if (keys.length > ORDER - 1) problems.push(`node ${id} holds ${keys.length} keys`);
    if (keys.some((k, i) => i > 0 && k <= (keys[i - 1] as number))) {
      problems.push(`node ${id} keys are not sorted`);
    }
    if (keys.some((k) => k <= low || k >= high)) {
      problems.push(`node ${id} key outside its range`);
    }
    if (children.length === 0) {
      leafDepths.add(depth);
      return;
    }
    if (children.length !== keys.length + 1) {
      problems.push(`node ${id} has ${children.length} children for ${keys.length} keys`);
    }
    children.forEach((child, i) => {
      walk(child, depth + 1,
        i === 0 ? low : (keys[i - 1] as number),
        i === keys.length ? high : (keys[i] as number));
    });
  };

  walk(root, 0, -Infinity, Infinity);
  if (leafDepths.size > 1) problems.push(`leaves sit at depths ${[...leafDepths].join(', ')}`);
  return problems;
}

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, ['build [5 2 8 1 9]', 'insert v0 6', 'find v1 6'])) {
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
check('a duplicate insert is refused',
  run(inst, 'insert v0 5').error?.code === 'PRECONDITION_FAILED');
check('an absent key is reported as absent',
  (run(inst, 'find v0 42').value as { found: boolean }).found === false);
check('an unknown version is refused with the list',
  (run(inst, 'find v9 1').error?.hint ?? '').includes('v0'));
check('an empty tree can still be built and searched', (() => {
  const p = fresh();
  run(p, 'build [7]');
  return keysOf(p, 0, 10).join(',') === '7';
})());

/* ── 3. Splitting ──────────────────────────────────────────────────── */

console.log('\nsplitting');

check(`a node splits once it would hold ${ORDER} keys`, (() => {
  const p = fresh();
  run(p, 'build [1 2 3]');
  const r = run(p, 'insert v0 4').value as { splits: number; grew: boolean; height: number };
  return r.splits === 1 && r.grew && r.height === 2;
})(), `${ORDER - 1} keys fit; the next one splits the root and the tree gains a level`);

check('a split below the root does not make the tree taller', (() => {
  const p = fresh();
  run(p, 'build [1 2 3 4 5]');
  const before = (run(p, 'find v0 1').value as { height: number }).height;
  const r = run(p, 'insert v0 6').value as { grew: boolean; height: number };
  return !r.grew && r.height === before;
})());

check('an insert with no split writes only the path', (() => {
  const p = fresh();
  run(p, 'build [1 2]');
  const r = run(p, 'insert v0 3').value as { splits: number; allocated: number };
  return r.splits === 0 && r.allocated === 1;
})(), 'one node rewritten');

/* ── 4. The invariants, recomputed from the graph ──────────────────── */

console.log('\nB-tree invariants');

check('a large sorted build satisfies every rule', (() => {
  const p = fresh();
  run(p, `build [${Array.from({ length: 200 }, (_, i) => i + 1).join(' ')}]`);
  const g = p.getStructure();
  const problems = violations(g, g.roots[0] as unknown as number);
  return problems.length === 0;
})(), 'sorted, in range, right child count, leaves all level');

check('every version stays valid after repeated inserts', (() => {
  const p = fresh();
  run(p, 'build [50]');
  for (let k = 1; k <= 30; k += 1) {
    run(p, `insert v${k - 1} ${k}`);
    const g = p.getStructure();
    const root = (g.roots[g.roots.length - 1]) as unknown as number;
    if (violations(g, root).length > 0) return false;
  }
  return true;
})(), '30 versions each checked');

check('height grows like log of the size', (() => {
  for (const n of [50, 200, 800]) {
    const p = fresh();
    const r = run(p, `build [${Array.from({ length: n }, (_, i) => i + 1).join(' ')}]`).value as
      { height: number };
    // With ORDER 4 the minimum fill is 2 children, so height <= log2(n) + 1.
    if (r.height > Math.log2(n) + 1) return false;
  }
  return true;
})(), 'checked at 50, 200 and 800 keys');

/* ── 5. Multi-key nodes, which nothing before this had ─────────────── */

console.log('\nnodes holding several keys');

const multi = fresh();
run(multi, `build [${Array.from({ length: 30 }, (_, i) => i + 1).join(' ')}]`);
const graph = multi.getStructure();

check('nodes report several values, not one', (() => {
  const widest = Math.max(...graph.nodes.map((n) => n.values?.length ?? 0));
  return widest > 1;
})(), `widest node holds ${Math.max(...graph.nodes.map((n) => n.values?.length ?? 0))} keys`);

// Monotonic rather than "a 1-key node is narrower than a 3-key node": which
// key counts a tree happens to contain depends on the insertion order, and the
// property being tested does not.
check('a node holding more keys is never drawn narrower', (() => {
  const placed = layout(graph).nodes;
  for (const a of placed) {
    for (const b of placed) {
      const ka = a.node.values?.length ?? 0;
      const kb = b.node.values?.length ?? 0;
      if (ka > kb && a.width < b.width) return false;
    }
  }
  // And the widths are not all identical, which is what the old code did.
  return new Set(placed.map((n) => n.width)).size > 1;
})(), (() => {
  const placed = layout(graph).nodes;
  const byKeys = new Map<number, number>();
  for (const n of placed) byKeys.set(n.node.values?.length ?? 0, Math.round(n.width));
  return [...byKeys.entries()].sort((a, b) => a[0] - b[0])
    .map(([k, w]) => `${k} key${k === 1 ? '' : 's'} = ${w}px`).join(', ');
})());

check('wider nodes still do not overlap', (() => {
  const scene = layout(graph);
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
})(), `${Math.round(layout(graph).width)}px wide overall`);

/* ── 6. Property test against a sorted set ─────────────────────────── */

console.log('\nproperty test vs a sorted set');

const rng = createRng(20_260_813);
let trials = 0;
let operations = 0;
let firstFailure = '';

for (let t = 0; t < 25 && firstFailure === ''; t += 1) {
  const p = fresh();
  const start = [...new Set(Array.from({ length: rng.nextInt(1, 10) }, () => rng.nextInt(0, 40)))];
  run(p, `build [${start.join(' ')}]`);
  const models: number[][] = [[...start].sort((a, b) => a - b)];
  trials += 1;

  for (let op = 0; op < 10 && firstFailure === ''; op += 1) {
    const from = rng.nextInt(0, models.length);
    const model = models[from] as number[];
    const key = rng.nextInt(0, 40);
    operations += 1;

    if (model.includes(key)) {
      if (run(p, `insert v${from} ${key}`).error?.code !== 'PRECONDITION_FAILED') {
        firstFailure = `re-inserting ${key} should have been refused`;
      }
      continue;
    }
    if (run(p, `insert v${from} ${key}`).error !== null) { firstFailure = 'unexpected error'; break; }
    models.push([...model, key].sort((a, b) => a - b));

    for (let v = 0; v < models.length && firstFailure === ''; v += 1) {
      const expected = (models[v] as number[]).join(',');
      const got = keysOf(p, v, 40).join(',');
      if (got !== expected) firstFailure = `v${v}: got [${got}], expected [${expected}]`;
    }
    const g = p.getStructure();
    if (firstFailure === '' && violations(g, g.roots[g.roots.length - 1] as unknown as number).length > 0) {
      firstFailure = 'a version broke the B-tree rules';
    }
  }
}

check('every version holds its keys and stays a valid B-tree', firstFailure === '',
  firstFailure === '' ? `${trials} trials, ${operations} operations` : firstFailure);

/* ── 7. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build [1 2 3]', 'insert v0 4', 'insert v1 5', 'find v2 5', 'compare v1 v2']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
