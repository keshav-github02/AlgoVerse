/**
 * Conformance, path sums against a plain walk, and the decomposition's own
 * claims recomputed from the drawing.
 *
 *     node packages/plugins/hld/src/plugin.check.ts
 */

import { createRng, help, parseCommand, type NodeId, type OperationError, type StructureGraph } from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { hld as plugin } from './plugin.ts';

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

/** The tree as the drawing reports it: parent, children and edge kind. */
interface Read {
  readonly parent: Map<number, number>;
  readonly kids: Map<number, number[]>;
  readonly heavy: Map<number, number>;
  readonly group: Map<number, number>;
  readonly labels: number[];
  readonly root: number;
}

function readTree(g: StructureGraph): Read {
  const label = new Map<NodeId, number>();
  const group = new Map<number, number>();
  for (const n of g.nodes) {
    label.set(n.id, n.value);
    group.set(n.value, n.group ?? -1);
  }
  const parent = new Map<number, number>();
  const kids = new Map<number, number[]>();
  const heavy = new Map<number, number>();
  for (const n of g.nodes) kids.set(n.value, []);
  for (const e of g.edges) {
    const from = label.get(e.from) as number;
    const to = label.get(e.to) as number;
    parent.set(to, from);
    (kids.get(from) as number[]).push(to);
    if (e.slot === 'heavy') heavy.set(from, to);
  }
  const root = label.get(g.roots[0] as NodeId) as number;
  return { parent, kids, heavy, group, labels: [...label.values()], root };
}

/** The path between two vertices, by climbing parents. A different algorithm. */
function naivePath(t: Read, a: number, b: number): number[] {
  const up = (x: number): number[] => {
    const out = [x];
    let cur = x;
    while (t.parent.has(cur)) { cur = t.parent.get(cur) as number; out.push(cur); }
    return out;
  };
  const fromA = up(a);
  const fromB = up(b);
  const onB = new Set(fromB);
  const meet = fromA.find((x) => onB.has(x)) as number;
  const head = fromA.slice(0, fromA.indexOf(meet) + 1);
  const tail = fromB.slice(0, fromB.indexOf(meet)).reverse();
  return [...head, ...tail];
}

/** Subtree sizes, recomputed rather than trusted. */
function sizes(t: Read): Map<number, number> {
  const size = new Map<number, number>();
  const order: number[] = [];
  const stack = [t.root];
  while (stack.length > 0) {
    const v = stack.pop() as number;
    order.push(v);
    for (const c of t.kids.get(v) ?? []) stack.push(c);
  }
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const v = order[i] as number;
    let s = 1;
    for (const c of t.kids.get(v) ?? []) s += size.get(c) as number;
    size.set(v, s);
  }
  return size;
}

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, ['build [1 2 1 3 2 4 2 5 3 6 5 7]', 'set 4 10', 'path 7 6', 'lca 7 6'])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. Building, and what is not a tree ───────────────────────────── */

console.log('\nbuilding');

const inst = fresh();
const built = run(inst, 'build [1 2 1 3 2 4 2 5 3 6 5 7]').value as
  { vertices: number; root: number; chains: number };
check('edges become a rooted tree', built.vertices === 7 && built.root === 1);

check('an odd list is refused', (() => {
  const r = run(fresh(), 'build [1 2 3]');
  return r.error?.code === 'BAD_ARGUMENT' && (r.error.hint ?? '').includes('hangs 2 and 3 under 1');
})());
check('a cycle is refused, and named', (() => {
  const r = run(fresh(), 'build [1 2 2 3 3 1]');
  return r.error?.code === 'PRECONDITION_FAILED' && (r.error.hint ?? '').includes('cycle');
})(), '3 vertices and 3 edges cannot be a tree');
check('a disconnected graph is refused, and named', (() => {
  const r = run(fresh(), 'build [1 2 3 4]');
  return r.error?.code === 'PRECONDITION_FAILED' && (r.error.hint ?? '').includes('not connected');
})());
check('a repeated edge is refused',
  (run(fresh(), 'build [1 2 1 2]').error?.hint ?? '').includes('one path between any two'));
check('a self loop is refused',
  run(fresh(), 'build [1 1 1 2]').error?.code === 'PRECONDITION_FAILED');
check('an unknown vertex is refused, and says what exists',
  (run(inst, 'path 1 42').error?.hint ?? '').includes('vertices: 1, 2, 3'));

/* ── 3. The decomposition, read off the drawing ────────────────────── */

console.log('\ndecomposition');

const tree = readTree(inst.getStructure());
const size = sizes(tree);

check('the heavy edge goes to the largest child, everywhere', (() => {
  for (const [v, kids] of tree.kids) {
    if (kids.length === 0) { if (tree.heavy.has(v)) return false; continue; }
    const best = Math.max(...kids.map((c) => size.get(c) as number));
    const picked = tree.heavy.get(v);
    if (picked === undefined) return false;
    if ((size.get(picked) as number) !== best) return false;
  }
  return true;
})(), 'recomputed from subtree sizes, not read off the plugin');

check('every vertex has exactly one heavy edge below it, unless it is a leaf', (() => {
  // Counted from the raw edges: reading it back out of a map keyed by parent
  // would make the answer true by construction rather than by test.
  const out = new Map<NodeId, number>();
  const g = inst.getStructure();
  for (const e of g.edges) {
    if (e.slot !== 'heavy') continue;
    out.set(e.from, (out.get(e.from) ?? 0) + 1);
  }
  if ([...out.values()].some((c) => c !== 1)) return false;
  const leaves = g.nodes.filter((n) => !g.edges.some((e) => e.from === n.id)).length;
  return out.size === g.nodes.length - leaves;
})());

check('the chains partition the vertices', (() => {
  // Every vertex in exactly one chain, and no chain empty.
  const counts = new Map<number, number>();
  for (const v of tree.labels) {
    const g = tree.group.get(v) as number;
    if (g < 0) return false;
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return [...counts.values()].reduce((a, b) => a + b, 0) === tree.labels.length;
})());

check('a heavy edge stays inside a chain, a light edge leaves it', (() => {
  for (const [v, kids] of tree.kids) {
    for (const c of kids) {
      const together = tree.group.get(v) === tree.group.get(c);
      if (together !== (tree.heavy.get(v) === c)) return false;
    }
  }
  return true;
})(), 'this is what makes a chain contiguous in the array');

/* ── 4. Paths, against a plain walk ────────────────────────────────── */

console.log('\npaths');

const walked = run(inst, 'path 7 6').value as { total: number; vertices: number; ranges: number; meetsAt: number };
check('the path meets at the common ancestor', walked.meetsAt === 1);
check('every vertex starts at 1, so a path totals its own length',
  walked.total === walked.vertices, `${walked.vertices} vertices, total ${walked.total}`);

check('set changes one value and nothing else', (() => {
  const p = fresh();
  run(p, 'build [1 2 1 3 2 4 2 5 3 6 5 7]');
  const before = (run(p, 'path 7 6').value as { total: number }).total;
  run(p, 'set 7 10');
  const after = (run(p, 'path 7 6').value as { total: number }).total;
  const elsewhere = (run(p, 'path 4 6').value as { total: number }).total;
  // 4 to 6 runs 4-2-1-3-6: five vertices at 1 each, and 7 is on none of them.
  return after === before + 9 && elsewhere === 5;
})(), '7 is on one path and not the other');

check('a path to itself is the vertex alone', (() => {
  const r = run(inst, 'path 4 4').value as { vertices: number; ranges: number };
  return r.vertices === 1 && r.ranges === 1;
})());

/* ── 5. Against a plain walk, and the bound ────────────────────────── */

console.log('\nproperty test vs climbing parents');

const rng = createRng(20_260_820);
let trials = 0;
let queries = 0;
let worstRanges = 0;
let worstLight = 0;
let firstFailure = '';

for (let t = 0; t < 30 && firstFailure === ''; t += 1) {
  const n = rng.nextInt(2, 60);
  // A random rooted tree: every vertex but the first picks an earlier parent.
  const pairs: number[] = [];
  for (let i = 2; i <= n; i += 1) pairs.push(rng.nextInt(1, i), i);

  const p = fresh();
  const r = run(p, `build [${pairs.join(' ')}]`);
  if (r.error !== null) { firstFailure = `build failed: ${r.error.message}`; break; }

  const values = new Map<number, number>();
  for (let i = 1; i <= n; i += 1) values.set(i, 1);
  for (let i = 0; i < 5; i += 1) {
    const v = rng.nextInt(1, n + 1);
    const value = rng.nextInt(-20, 40);
    run(p, `set ${v} ${value}`);
    values.set(v, value);
  }

  const t2 = readTree(p.getStructure());
  trials += 1;

  for (let q = 0; q < 12 && firstFailure === ''; q += 1) {
    const a = rng.nextInt(1, n + 1);
    const b = rng.nextInt(1, n + 1);
    const expected = naivePath(t2, a, b);
    const want = expected.reduce((acc, v) => acc + (values.get(v) as number), 0);

    const got = run(p, `path ${a} ${b}`).value as
      { total: number; vertices: number; ranges: number; meetsAt: number };
    queries += 1;
    worstRanges = Math.max(worstRanges, got.ranges);

    if (got.total !== want) {
      firstFailure = `path ${a}-${b} on ${n} vertices totals ${got.total}, walking gives ${want}`;
      break;
    }
    if (got.vertices !== expected.length) {
      firstFailure = `path ${a}-${b} covers ${got.vertices} vertices, walking gives ${expected.length}`;
      break;
    }
    if (got.meetsAt !== naiveMeet(t2, a, b)) {
      firstFailure = `path ${a}-${b} meets at ${got.meetsAt}, walking meets at ${naiveMeet(t2, a, b)}`;
      break;
    }

    const l = run(p, `lca ${a} ${b}`).value as { lca: number; lightEdgesCrossed: number };
    if (l.lca !== naiveMeet(t2, a, b)) {
      firstFailure = `lca ${a}-${b} says ${l.lca}, walking says ${naiveMeet(t2, a, b)}`;
      break;
    }
    worstLight = Math.max(worstLight, l.lightEdgesCrossed);

    /*
     * The bound the whole decomposition exists for. Stepping down a light edge
     * at least halves the subtree, so no path can cross more than log2(n) of
     * them from either end.
     */
    if (l.lightEdgesCrossed > 2 * Math.log2(n) + 1) {
      firstFailure = `lca ${a}-${b} crossed ${l.lightEdgesCrossed} light edges on ${n} vertices, ` +
        `above the 2*log2(${n}) bound`;
      break;
    }
    if (got.ranges > 2 * Math.log2(n) + 1) {
      firstFailure = `path ${a}-${b} needed ${got.ranges} ranges on ${n} vertices, above the bound`;
      break;
    }
  }
}

function naiveMeet(t: Read, a: number, b: number): number {
  const up = (x: number): number[] => {
    const out = [x];
    let cur = x;
    while (t.parent.has(cur)) { cur = t.parent.get(cur) as number; out.push(cur); }
    return out;
  };
  const onB = new Set(up(b));
  return up(a).find((x) => onB.has(x)) as number;
}

check('sums, lengths and meeting points agree with climbing parents',
  firstFailure === '',
  firstFailure === '' ? `${trials} trees, ${queries} queries` : firstFailure);
check('no path ever needed more ranges than the bound allows',
  firstFailure === '',
  `worst seen: ${worstRanges} ranges, ${worstLight} light edges`);

check('a path graph is one chain, a balanced tree is many', (() => {
  const line = fresh();
  run(line, `build [${Array.from({ length: 63 }, (_, i) => [i + 1, i + 2]).flat().join(' ')}]`);
  const straight = (run(line, 'chains').value as { chains: number }).chains;

  const balanced = fresh();
  const pairs: number[] = [];
  for (let i = 2; i <= 64; i += 1) pairs.push(Math.floor(i / 2), i);
  run(balanced, `build [${pairs.join(' ')}]`);
  const split = (run(balanced, 'chains').value as { chains: number }).chains;

  return straight === 1 && split > 20;
})(), 'a line needs no decomposing; a balanced tree is where it earns its keep');

/* ── 6. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build [1 2 1 3 2 4 2 5 3 6 5 7]', 'chains', 'path 7 6', 'lca 7 6', 'set 7 10', 'path 7 6']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
