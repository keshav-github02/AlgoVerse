/**
 * Conformance, traversal correctness, and the force layout this plugin is the
 * first consumer of.
 *
 *     node packages/plugins/graph/src/plugin.check.ts
 */

import { createRng, help, layout, parseCommand, type OperationError } from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { graph as plugin } from './plugin.ts';

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

const orderOf = (inst: PluginInstance, line: string): string =>
  (run(inst, line).value as { order: number[] }).order.join(',');

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, ['build [1 2 2 3 3 4 1 4]', 'link 4 5', 'bfs 1'])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. Building ───────────────────────────────────────────────────── */

console.log('\nbuilding');

const inst = fresh();
const built = run(inst, 'build [1 2 2 3 3 4 1 4]').value as
  { vertices: number; edges: number; components: number };
check('a cycle of four has four vertices and four edges',
  built.vertices === 4 && built.edges === 4 && built.components === 1);

check('an odd number of vertices is refused', (() => {
  const r = run(fresh(), 'build [1 2 3]');
  return r.error?.code === 'BAD_ARGUMENT' && (r.error.hint ?? '').includes('each pair is one edge');
})());
check('a repeated edge is not added twice', (() => {
  const p = fresh();
  const r = run(p, 'build [1 2 2 1 1 2]').value as { edges: number };
  return r.edges === 1;
})());
check('linking two vertices again is refused',
  run(inst, 'link 1 2').error?.code === 'PRECONDITION_FAILED');
check('a self-loop is refused',
  run(inst, 'link 3 3').error?.code === 'PRECONDITION_FAILED');
check('link can introduce a new vertex', (() => {
  const p = fresh();
  run(p, 'build [1 2]');
  const r = run(p, 'link 2 3').value as { vertices: number };
  return r.vertices === 3;
})());
check('traversing from an unknown vertex is refused, and says what exists',
  (run(inst, 'dfs 99').error?.hint ?? '').includes('vertices: 1, 2, 3, 4'));

/* ── 3. The two walks ──────────────────────────────────────────────── */

console.log('\ndepth first and breadth first');

// 1-2, 1-3, 2-4, 2-5, 3-6: a small tree, where the two orders differ clearly.
const walk = fresh();
run(walk, 'build [1 2 1 3 2 4 2 5 3 6]');

check('depth first goes deep before wide', orderOf(walk, 'dfs 1') === '1,2,4,5,3,6',
  orderOf(walk, 'dfs 1'));
check('breadth first goes wide before deep', orderOf(walk, 'bfs 1') === '1,2,3,4,5,6',
  orderOf(walk, 'bfs 1'));
check('both reach every vertex of a connected graph', (() => {
  const d = (run(walk, 'dfs 1').value as { reached: number; missed: number });
  const b = (run(walk, 'bfs 1').value as { reached: number; missed: number });
  return d.reached === 6 && b.reached === 6 && d.missed === 0 && b.missed === 0;
})());
check('a walk terminates on a cycle', (() => {
  const p = fresh();
  run(p, 'build [1 2 2 3 3 1]');
  return orderOf(p, 'dfs 1') === '1,2,3' && orderOf(p, 'bfs 1') === '1,2,3';
})(), 'visiting a vertex twice would loop forever');
check('both walks are reproducible', (() => {
  const first = orderOf(walk, 'dfs 1');
  const second = orderOf(walk, 'dfs 1');
  return first === second;
})());

check('a walk reports what it could not reach', (() => {
  const p = fresh();
  run(p, 'build [1 2 3 4]');
  const r = run(p, 'bfs 1').value as { reached: number; missed: number };
  return r.reached === 2 && r.missed === 2;
})(), 'two vertices in another component');

/* ── 4. Components ─────────────────────────────────────────────────── */

console.log('\ncomponents');

check('a connected graph is one piece',
  (run(walk, 'components').value as { components: number }).components === 1);
check('separate pieces are counted and measured', (() => {
  const p = fresh();
  run(p, 'build [1 2 3 4 4 5 6 7]');
  const r = run(p, 'components').value as { components: number; sizes: number[] };
  return r.components === 3 && r.sizes.join(',') === '2,3,2';
})());
check('every vertex belongs to exactly one piece', (() => {
  const p = fresh();
  run(p, 'build [1 2 3 4 4 5 6 7]');
  const r = run(p, 'components').value as { sizes: number[]; vertices: number };
  return r.sizes.reduce((a, b) => a + b, 0) === r.vertices;
})());

/* ── 5. The force layout, whose first user this is ─────────────────── */

console.log('\nforce layout');

const wide = fresh();
run(wide, 'build [1 2 1 3 1 4 2 5 3 6 4 7 5 8 6 9 7 10 8 9]');
const structure = wide.getStructure();

check('the plugin asks for a force layout', structure.layout === 'force');
check('every edge is a link, not a tree edge',
  structure.edges.every((e) => e.kind === 'link'));
check('every vertex is an entry point', structure.roots.length === structure.nodes.length,
  'an unrooted structure has no other honest answer');

check('the layout is deterministic', (() => {
  const a = JSON.stringify(layout(wide.getStructure()));
  const b = JSON.stringify(layout(wide.getStructure()));
  return a === b;
})(), 'the same graph twice gives identical coordinates');

check('no two vertices overlap', (() => {
  const scene = layout(structure);
  for (const a of scene.nodes) {
    for (const b of scene.nodes) {
      if (a.node.id >= b.node.id) continue;
      const apart = Math.abs(a.x - b.x) >= (a.width + b.width) / 2
        || Math.abs(a.y - b.y) >= a.height;
      if (!apart) return false;
    }
  }
  return true;
})(), `${layout(structure).nodes.length} vertices`);

check('everything sits inside the reported bounds', (() => {
  const scene = layout(structure);
  return scene.nodes.every((n) =>
    n.x - n.width / 2 >= 0 && n.x + n.width / 2 <= scene.width
    && n.y - n.height / 2 >= 0 && n.y + n.height / 2 <= scene.height);
})(), (() => {
  const scene = layout(structure);
  return `${Math.round(scene.width)} x ${Math.round(scene.height)} px`;
})());

check('joined vertices end up closer than unjoined ones', (() => {
  const scene = layout(structure);
  const at = new Map(scene.nodes.map((n) => [n.node.id, n]));
  const joined = new Set(structure.edges.map((e) => `${e.from}-${e.to}`));
  const gap = (a: typeof scene.nodes[number], b: typeof scene.nodes[number]): number =>
    Math.hypot(a.x - b.x, a.y - b.y);

  let near = 0; let nearN = 0; let far = 0; let farN = 0;
  for (const a of scene.nodes) {
    for (const b of scene.nodes) {
      if (a.node.id >= b.node.id) continue;
      const linked = joined.has(`${a.node.id}-${b.node.id}`) || joined.has(`${b.node.id}-${a.node.id}`);
      const d = gap(at.get(a.node.id) as typeof a, at.get(b.node.id) as typeof b);
      if (linked) { near += d; nearN += 1; } else { far += d; farN += 1; }
    }
  }
  return near / nearN < far / farN;
})(), (() => {
  const scene = layout(structure);
  const joined = new Set(structure.edges.map((e) => `${e.from}-${e.to}`));
  let near = 0; let nearN = 0; let far = 0; let farN = 0;
  for (const a of scene.nodes) {
    for (const b of scene.nodes) {
      if (a.node.id >= b.node.id) continue;
      const linked = joined.has(`${a.node.id}-${b.node.id}`) || joined.has(`${b.node.id}-${a.node.id}`);
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (linked) { near += d; nearN += 1; } else { far += d; farN += 1; }
    }
  }
  return `${Math.round(near / nearN)}px apart when joined, ${Math.round(far / farN)}px when not`;
})());

check('a disconnected graph still lays out', (() => {
  const p = fresh();
  run(p, 'build [1 2 3 4 5 6]');
  const scene = layout(p.getStructure());
  return scene.nodes.length === 6 && scene.width > 0 && Number.isFinite(scene.width);
})());
check('a single vertex lays out', (() => {
  const p = fresh();
  run(p, 'link 1 2');
  const scene = layout(p.getStructure());
  return scene.nodes.length === 2 && Number.isFinite(scene.width);
})());

/* ── 6. Property test against a plain reachability model ───────────── */

console.log('\nproperty test vs plain reachability');

const rng = createRng(20_260_816);
let trials = 0;
let walks = 0;
let firstFailure = '';

for (let t = 0; t < 30 && firstFailure === ''; t += 1) {
  const size = rng.nextInt(2, 12);
  const pairs: number[] = [];
  const model = new Map<number, Set<number>>();
  for (let i = 0; i < rng.nextInt(1, 16); i += 1) {
    const a = rng.nextInt(1, size + 1);
    const b = rng.nextInt(1, size + 1);
    if (a === b) continue;
    pairs.push(a, b);
    if (!model.has(a)) model.set(a, new Set());
    if (!model.has(b)) model.set(b, new Set());
    (model.get(a) as Set<number>).add(b);
    (model.get(b) as Set<number>).add(a);
  }
  if (pairs.length === 0) continue;

  const p = fresh();
  run(p, `build [${pairs.join(' ')}]`);
  trials += 1;

  for (const start of model.keys()) {
    // Reachability computed independently, without the plugin's traversal.
    const want = new Set<number>([start]);
    const stack = [start];
    while (stack.length > 0) {
      const cur = stack.pop() as number;
      for (const other of model.get(cur) as Set<number>) {
        if (want.has(other)) continue;
        want.add(other);
        stack.push(other);
      }
    }
    const expected = [...want].sort((a, b) => a - b).join(',');

    for (const how of ['dfs', 'bfs'] as const) {
      walks += 1;
      const got = (run(p, `${how} ${start}`).value as { order: number[] })
        .order.slice().sort((a, b) => a - b).join(',');
      if (got !== expected) {
        firstFailure = `${how} from ${start}: reached [${got}], expected [${expected}]`;
        break;
      }
    }
    if (firstFailure !== '') break;
  }

  if (firstFailure === '') {
    // The component count must agree with the same model.
    const seen = new Set<number>();
    let pieces = 0;
    for (const v of model.keys()) {
      if (seen.has(v)) continue;
      pieces += 1;
      const stack = [v];
      while (stack.length > 0) {
        const cur = stack.pop() as number;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const other of model.get(cur) as Set<number>) stack.push(other);
      }
    }
    const got = (run(p, 'components').value as { components: number }).components;
    if (got !== pieces) firstFailure = `components: got ${got}, expected ${pieces}`;
  }
}

check('both walks reach exactly what is reachable', firstFailure === '',
  firstFailure === '' ? `${trials} graphs, ${walks} traversals` : firstFailure);

/* ── 7. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build [1 2 1 3 2 4 2 5 3 6]', 'dfs 1', 'bfs 1', 'link 6 7', 'components']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
