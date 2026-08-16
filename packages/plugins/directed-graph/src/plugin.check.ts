/**
 * Conformance, Tarjan against Kosaraju, and the first edges that are drawn
 * with a direction rather than only having one.
 *
 *     node packages/plugins/directed-graph/src/plugin.check.ts
 */

import { createRng, help, layout, parseCommand, type OperationError } from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { directedGraph as plugin } from './plugin.ts';

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

const key = (groups: readonly (readonly number[])[]): string =>
  groups.map((g) => [...g].sort((a, b) => a - b).join('.'))
    .sort()
    .join('|');

/**
 * Kosaraju: order by finish time, then walk the reversed graph in that order.
 * A completely different route to the same components, which is the point -
 * a bug in Tarjan's low-link bookkeeping has no way to show up here too.
 */
function kosaraju(
  vertices: readonly number[],
  edges: readonly (readonly [number, number])[],
): number[][] {
  const out = new Map<number, number[]>();
  const back = new Map<number, number[]>();
  for (const v of vertices) { out.set(v, []); back.set(v, []); }
  for (const [a, b] of edges) {
    (out.get(a) as number[]).push(b);
    (back.get(b) as number[]).push(a);
  }

  const order: number[] = [];
  const seen = new Set<number>();
  const visit = (v: number): void => {
    seen.add(v);
    for (const w of out.get(v) as number[]) if (!seen.has(w)) visit(w);
    order.push(v);
  };
  for (const v of vertices) if (!seen.has(v)) visit(v);

  const assigned = new Set<number>();
  const groups: number[][] = [];
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const root = order[i] as number;
    if (assigned.has(root)) continue;
    const group: number[] = [];
    const stack = [root];
    assigned.add(root);
    while (stack.length > 0) {
      const v = stack.pop() as number;
      group.push(v);
      for (const w of back.get(v) as number[]) {
        if (assigned.has(w)) continue;
        assigned.add(w);
        stack.push(w);
      }
    }
    groups.push(group);
  }
  return groups;
}

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, ['build [1 2 2 3 3 1 3 4]', 'link 4 5', 'scc', 'topo'])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. Building ───────────────────────────────────────────────────── */

console.log('\nbuilding');

const inst = fresh();
const built = run(inst, 'build [1 2 2 3 3 1 3 4]').value as { vertices: number; edges: number };
check('pairs become one-way edges', built.vertices === 4 && built.edges === 4);

check('an odd list is refused', (() => {
  const r = run(fresh(), 'build [1 2 3]');
  return r.error?.code === 'BAD_ARGUMENT' && (r.error.hint ?? '').includes('1 to 2');
})());
check('a self-loop is refused, with the reason',
  (run(inst, 'link 1 1').error?.hint ?? '').includes('own component'));
check('a repeated edge is refused',
  run(inst, 'link 1 2').error?.code === 'PRECONDITION_FAILED');
check('an unknown source is refused, and says what exists',
  (run(inst, 'reach 42').error?.hint ?? '').includes('vertices: 1, 2, 3, 4'));

check('direction is not symmetric', (() => {
  // The whole reason this plugin exists: 1->2 must not imply 2->1.
  const p = fresh();
  run(p, 'build [1 2]');
  const forward = run(p, 'reach 1').value as { reached: number };
  const backward = run(p, 'reach 2').value as { reached: number };
  return forward.reached === 2 && backward.reached === 1;
})(), 'reach 1 finds both, reach 2 finds only itself');

/* ── 3. Components and order ───────────────────────────────────────── */

console.log('\ncomponents and order');

// 1->2->3->1 is a knot; 4 hangs off it and is its own component.
const groups = run(inst, 'scc').value as
  { components: number; groups: number[][]; cycles: number; largest: number };
check('the cycle is one component', key(groups.groups) === '1.2.3|4', key(groups.groups));
check('a component larger than one vertex is reported as a cycle',
  groups.cycles === 1 && groups.largest === 3);

check('a cycle blocks any topological order, and everything it reaches', (() => {
  // 1->2->3->1 is the knot, and 4 hangs off 3. Four vertices are unplaced, not
  // three: nothing in the cycle is ever emitted, so 4 is never freed either.
  const r = run(inst, 'topo').value as { ordered: boolean; unplaced: number };
  return !r.ordered && r.unplaced === 4;
})(), 'the knot plus what it reaches');

check('an acyclic graph orders, and every edge points forward', (() => {
  const p = fresh();
  run(p, 'build [1 2 1 3 2 4 3 4 4 5]');
  const r = run(p, 'topo').value as { ordered: boolean; order: number[] };
  if (!r.ordered || r.order.length !== 5) return false;
  const at = new Map(r.order.map((v, i) => [v, i]));
  return ([[1, 2], [1, 3], [2, 4], [3, 4], [4, 5]] as const)
    .every(([a, b]) => (at.get(a) as number) < (at.get(b) as number));
})());

check('an acyclic graph has one component per vertex', (() => {
  const p = fresh();
  run(p, 'build [1 2 2 3 3 4]');
  const r = run(p, 'scc').value as { components: number; cycles: number };
  return r.components === 4 && r.cycles === 0;
})());

check('reach follows arrows forwards only', (() => {
  const p = fresh();
  run(p, 'build [1 2 2 3 4 3]');
  const r = run(p, 'reach 1').value as { order: number[]; unreachable: number };
  return r.order.join(',') === '1,2,3' && r.unreachable === 1;
})(), '4 points into the walk but cannot be got to from 1');

/* ── 4. Edges that show their direction ────────────────────────────── */

console.log('\ndirected edges');

const drawn = fresh();
run(drawn, 'build [1 2 2 3 3 1 3 4]');
const structure = drawn.getStructure();

check('every edge is marked directed', structure.edges.every((e) => e.directed === true));
check('an edge is still a link, not hierarchy',
  structure.edges.every((e) => e.kind === 'link'));
check('direction survives into the positioned scene',
  layout(structure).edges.every((e) => e.directed === true));

check('the log carries the direction, not just the picture', (() => {
  // Conformance compares log to structure; this states why it must be logged.
  const p = fresh();
  const parsed = parseCommand('build [1 2]', plugin.commands);
  if (!parsed.ok) return false;
  const r = p.execute(parsed.command);
  return r.events.some((e) => e.kind === 'PointerSet' && e.directed === true);
})());

check('a link edge is drawn straight, not curved', (() => {
  // A curve leaves and arrives vertically, which would point an arrowhead the
  // wrong way at both ends. Links are straight so the arrow means something.
  const positioned = layout(structure);
  let checked = 0;
  const ok = positioned.edges.every((e) => {
    const a = positioned.nodes.find((n) => n.node.id === e.from);
    const b = positioned.nodes.find((n) => n.node.id === e.to);
    if (a === undefined || b === undefined) return false;
    // On the boundary: one axis exactly at the half-extent, neither beyond it.
    const on = (x: number, y: number, n: typeof a): boolean => {
      const dx = Math.abs(x - n.x) - n.width / 2;
      const dy = Math.abs(y - n.y) - n.height / 2;
      return dx <= 0.01 && dy <= 0.01 && (dx >= -0.01 || dy >= -0.01);
    };
    checked += 1;
    return on(e.x1, e.y1, a) && on(e.x2, e.y2, b);
  });
  return ok && checked === 4;
})());

/* ── 5. Against a different algorithm ──────────────────────────────── */

console.log('\nproperty test vs Kosaraju');

const rng = createRng(20_260_818);
let trials = 0;
let firstFailure = '';

for (let t = 0; t < 60 && firstFailure === ''; t += 1) {
  const size = rng.nextInt(2, 10);
  const pairs: number[] = [];
  const edges: [number, number][] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rng.nextInt(1, 18); i += 1) {
    const a = rng.nextInt(1, size + 1);
    const b = rng.nextInt(1, size + 1);
    if (a === b) continue;
    if (seen.has(`${a}>${b}`)) continue;
    seen.add(`${a}>${b}`);
    pairs.push(a, b);
    edges.push([a, b]);
  }
  if (edges.length === 0) continue;

  const p = fresh();
  run(p, `build [${pairs.join(' ')}]`);
  const vertices = [...new Set(edges.flat())].sort((x, y) => x - y);
  trials += 1;

  const got = run(p, 'scc').value as { groups: number[][] };
  const want = kosaraju(vertices, edges);
  if (key(got.groups) !== key(want)) {
    firstFailure = `components differ: got ${key(got.groups)}, expected ${key(want)}`;
    break;
  }

  // A topological order exists exactly when no component holds two vertices.
  const topo = run(p, 'topo').value as { ordered: boolean; order: number[] };
  const acyclic = want.every((g) => g.length === 1);
  if (topo.ordered !== acyclic) {
    firstFailure = `topo says ordered=${topo.ordered} but the graph is ${acyclic ? '' : 'not '}acyclic`;
    break;
  }
  if (topo.ordered) {
    const at = new Map(topo.order.map((v, i) => [v, i]));
    const bad = edges.find(([a, b]) => (at.get(a) as number) >= (at.get(b) as number));
    if (bad !== undefined) {
      firstFailure = `edge ${bad[0]}->${bad[1]} points backwards in ${topo.order.join(',')}`;
      break;
    }
  }

  // Each component is exactly the vertices that reach each other both ways.
  for (const group of got.groups) {
    const root = group[0] as number;
    const forward = new Set((run(p, `reach ${root}`).value as { order: number[] }).order);
    const mutual = vertices.filter((v) =>
      forward.has(v) && new Set((run(p, `reach ${v}`).value as { order: number[] }).order).has(root));
    if (mutual.sort((a, b) => a - b).join('.') !== [...group].sort((a, b) => a - b).join('.')) {
      firstFailure = `component ${group.join('.')} is not the mutually-reachable set ${mutual.join('.')}`;
      break;
    }
  }
}

check('components agree with Kosaraju, and match mutual reachability',
  firstFailure === '',
  firstFailure === '' ? `${trials} graphs` : firstFailure);

/* ── 6. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build [1 2 2 3 3 1 3 4]', 'scc', 'topo', 'reach 4', 'build [1 2 2 3 3 4]', 'topo']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
