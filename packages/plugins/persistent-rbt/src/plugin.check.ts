/**
 * Conformance, the three colour rules recomputed from the drawing, and a
 * property test against a plain sorted array.
 *
 *     node packages/plugins/persistent-rbt/src/plugin.check.ts
 */

import { createRng, help, parseCommand, type NodeId, type OperationError, type StructureGraph } from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { persistentRbt as plugin } from './plugin.ts';

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

/**
 * Every rule checked here is recomputed by walking the graph the plugin
 * publishes - never read off a field the plugin maintains. A tree that has
 * miscounted its own black height would happily report the miscount.
 */
function audit(graph: StructureGraph, root: NodeId): string | null {
  const colour = new Map<NodeId, string>();
  const value = new Map<NodeId, number>();
  for (const n of graph.nodes) { colour.set(n.id, n.role); value.set(n.id, n.value); }

  const kids = new Map<NodeId, { left: NodeId | null; right: NodeId | null }>();
  for (const n of graph.nodes) kids.set(n.id, { left: null, right: null });
  for (const e of graph.edges) {
    const slot = kids.get(e.from);
    if (slot === undefined) return `edge from unknown node ${e.from}`;
    if (e.slot === 'left') slot.left = e.to; else slot.right = e.to;
  }

  if (colour.get(root) !== 'black') return `rule 1: the root is ${colour.get(root)}, not black`;

  let fault: string | null = null;
  // Returns black nodes from here down; -1 once anything is wrong.
  const walk = (id: NodeId | null, low: number, high: number, seen: Set<NodeId>): number => {
    if (id === null) return 1;
    if (fault !== null) return -1;
    if (seen.has(id)) { fault = `node ${id} appears twice on one path`; return -1; }
    const k = value.get(id);
    if (k === undefined) { fault = `node ${id} is drawn without a value`; return -1; }
    if (k <= low || k >= high) { fault = `key ${k} is out of order for its position`; return -1; }

    const c = colour.get(id);
    const { left, right } = kids.get(id) ?? { left: null, right: null };
    if (c === 'red') {
      for (const child of [left, right]) {
        if (child !== null && colour.get(child) === 'red') {
          fault = `rule 2: red ${k} has red child ${value.get(child)}`;
          return -1;
        }
      }
    }

    const next = new Set(seen).add(id);
    const a = walk(left, low, k, next);
    const b = walk(right, k, high, next);
    if (fault !== null) return -1;
    if (a !== b) {
      fault = `rule 3: under ${k} one side holds ${a} black nodes and the other ${b}`;
      return -1;
    }
    return a + (c === 'black' ? 1 : 0);
  };

  walk(root, -Infinity, Infinity, new Set());
  return fault;
}

/** Reads a version's keys straight off the drawing, in order. */
function keysOf(graph: StructureGraph, root: NodeId | null): number[] {
  if (root === null) return [];
  const kids = new Map<NodeId, { left: NodeId | null; right: NodeId | null }>();
  const value = new Map<NodeId, number>();
  for (const n of graph.nodes) { kids.set(n.id, { left: null, right: null }); value.set(n.id, n.value); }
  for (const e of graph.edges) {
    const slot = kids.get(e.from);
    if (slot === undefined) continue;
    if (e.slot === 'left') slot.left = e.to; else slot.right = e.to;
  }
  const out: number[] = [];
  const walk = (id: NodeId | null): void => {
    if (id === null) return;
    const { left, right } = kids.get(id) ?? { left: null, right: null };
    walk(left);
    out.push(value.get(id) as number);
    walk(right);
  };
  walk(root);
  return out;
}

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, ['build [5 2 8 1 9 3]', 'insert v0 7', 'erase v1 2', 'find v2 8'])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. Building ───────────────────────────────────────────────────── */

console.log('\nbuilding');

const inst = fresh();
const built = run(inst, 'build [5 2 8 1 9 3]').value as
  { size: number; height: number; blackHeight: number };
check('build reports its size', built.size === 6);
check('sorted input does not degenerate', built.height <= 4, `height ${built.height} for 6 keys`);

check('a duplicate key is refused', (() => {
  const r = run(inst, 'insert v0 5');
  return r.error?.code === 'PRECONDITION_FAILED' && (r.error.hint ?? '').includes('each key once');
})());
check('erasing a key that is not there is refused, and says what is',
  (run(inst, 'erase v0 42').error?.hint ?? '').includes('1, 2, 3, 5, 8, 9'));
check('an unknown version is refused, and says what exists',
  (run(inst, 'find v9 1').error?.hint ?? '').includes('v0 to v'));

/* ── 3. The three rules, read off the drawing ──────────────────────── */

console.log('\ncolour rules');

const shaped = fresh();
run(shaped, 'build [5 2 8 1 9 3]');
run(shaped, 'insert v0 7');
run(shaped, 'insert v1 6');
run(shaped, 'erase v2 2');

const graph = shaped.getStructure();
check('every version obeys all three rules',
  graph.roots.every((r) => audit(graph, r) === null),
  graph.roots.map((r) => audit(graph, r)).find((f) => f !== null) ?? `${graph.roots.length} versions`);

check('the colour is on the node, not only in the plugin',
  graph.nodes.every((n) => n.role === 'red' || n.role === 'black')
  && graph.nodes.some((n) => n.role === 'red'),
  `${graph.nodes.filter((n) => n.role === 'red').length} red of ${graph.nodes.length}`);

check('a transient colour never reaches a node', (() => {
  // Double black and negative black exist only mid-repair. One surviving into
  // an allocated node would mean the repair silently gave up.
  const p = fresh();
  const parsed = parseCommand('build [1 2 3 4 5 6 7 8 9 10]', plugin.commands);
  if (!parsed.ok) return false;
  const r = p.execute(parsed.command);
  return r.events.every((e) => e.kind !== 'NodeAllocated' || e.role === 'red' || e.role === 'black');
})());

/* ── 4. Sharing ────────────────────────────────────────────────────── */

console.log('\nsharing');

check('an insert copies a path, not a tree', (() => {
  const p = fresh();
  run(p, 'build [1 2 3 4 5 6 7 8 9 10 11 12 13 14 15]');
  const r = run(p, 'insert v0 16').value as { allocated: number };
  return r.allocated > 0 && r.allocated < 15;
})(), 'fewer nodes allocated than the tree holds');

check('compare finds the shared nodes', (() => {
  const p = fresh();
  run(p, 'build [1 2 3 4 5 6 7 8 9 10 11 12 13 14 15]');
  run(p, 'insert v0 16');
  const r = run(p, 'compare v0 v1').value as { shared: number; sharedPercent: number };
  return r.shared > 0 && r.sharedPercent > 40;
})());

/* ── 5. Against a plain sorted array ───────────────────────────────── */

console.log('\nproperty test vs a sorted array');

const rng = createRng(20_260_819);
let trials = 0;
let writes = 0;
let firstFailure = '';

for (let t = 0; t < 40 && firstFailure === ''; t += 1) {
  const p = fresh();
  const start = [...new Set(Array.from({ length: rng.nextInt(1, 12) }, () => rng.nextInt(1, 40)))];
  run(p, `build [${start.join(' ')}]`);

  // Every version's keys, kept independently of the tree.
  const model: number[][] = [[...start].sort((a, b) => a - b)];

  for (let step = 0; step < rng.nextInt(1, 12); step += 1) {
    const from = rng.nextInt(0, model.length);
    const held = model[from] as number[];
    const adding = held.length === 0 || rng.next() < 0.55;
    let expected: number[];

    if (adding) {
      let key = rng.nextInt(1, 60);
      while (held.includes(key)) key = rng.nextInt(1, 60);
      const r = run(p, `insert v${from} ${key}`);
      if (r.error !== null) { firstFailure = `insert v${from} ${key}: ${r.error.message}`; break; }
      expected = [...held, key].sort((a, b) => a - b);
    } else {
      const key = held[rng.nextInt(0, held.length)] as number;
      const r = run(p, `erase v${from} ${key}`);
      if (r.error !== null) { firstFailure = `erase v${from} ${key}: ${r.error.message}`; break; }
      expected = held.filter((k) => k !== key);
    }
    model.push(expected);
    writes += 1;

    const g = p.getStructure();

    // The rules, every time - a tree that is briefly wrong is wrong.
    const fault = g.roots.map((r) => audit(g, r)).find((f) => f !== null);
    if (fault !== undefined && fault !== null) {
      firstFailure = `after ${adding ? 'insert' : 'erase'}: ${fault}`;
      break;
    }

    /*
     * Every version at once, not just the new one - a write must leave the
     * ones it branched from exactly as they were.
     *
     * The roots are matched to the versions that still hold something, not by
     * index: a version emptied by its last erase has no node to point at, so
     * it is absent from the drawing rather than present and null.
     */
    const drawn = g.roots.map((r) => keysOf(g, r).join(','));
    const want = model.filter((m) => m.length > 0).map((m) => m.join(','));
    if (drawn.length !== want.length || drawn.some((d, k) => d !== want[k])) {
      firstFailure = `versions are [${drawn.map((d) => `(${d})`).join(' ')}], ` +
        `expected [${want.map((w) => `(${w})`).join(' ')}]`;
      break;
    }
  }
  trials += 1;
}

check('keys, ordering and all three rules survive every write',
  firstFailure === '',
  firstFailure === '' ? `${trials} trees, ${writes} writes` : firstFailure);

check('a version emptied by its last erase has no root to draw', (() => {
  // Not a null entry: the drawing lists what can be pointed at, and nothing
  // can be pointed at. This is why versions are matched by order, not index.
  const q = fresh();
  run(q, 'build [30]');
  run(q, 'erase v0 30');
  run(q, 'insert v1 15');
  const g = q.getStructure();
  return g.roots.length === 2 && keysOf(g, g.roots[0] as NodeId).join(',') === '30'
    && keysOf(g, g.roots[1] as NodeId).join(',') === '15';
})(), 'three versions, two of them drawable');

check('depth stays within twice the perfect tree', (() => {
  const p = fresh();
  // Sorted input, the shape that turns a plain BST into a linked list.
  const n = 200;
  run(p, `build [${Array.from({ length: n }, (_, i) => i + 1).join(' ')}]`);
  const r = run(p, `find v0 ${n}`).value as { height: number };
  const bound = 2 * Math.log2(n + 1);
  return r.height <= bound;
})(), (() => {
  const p = fresh();
  run(p, `build [${Array.from({ length: 200 }, (_, i) => i + 1).join(' ')}]`);
  const r = run(p, 'find v0 200').value as { height: number };
  return `height ${r.height}, bound ${(2 * Math.log2(201)).toFixed(1)}`;
})());

/* ── 6. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build [5 2 8 1 9 3]', 'insert v0 7', 'erase v1 5', 'find v2 8', 'compare v0 v2']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
