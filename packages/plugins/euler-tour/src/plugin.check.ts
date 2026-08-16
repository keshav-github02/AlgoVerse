/**
 * Conformance, connectivity against breadth-first search, and the tour's own
 * shape recomputed from the drawing after every change.
 *
 *     node packages/plugins/euler-tour/src/plugin.check.ts
 */

import { createRng, help, parseCommand, type NodeId, type OperationError, type StructureGraph } from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { eulerTour as plugin } from './plugin.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const fresh = (): PluginInstance => plugin.createInstance({ rng: createRng(7) });

function run(inst: PluginInstance, line: string): { value: unknown; error: OperationError | null } {
  const parsed = parseCommand(line, plugin.commands);
  if (!parsed.ok) return { value: null, error: parsed.error };
  const r = inst.execute(parsed.command);
  return r.ok ? { value: r.value, error: null } : { value: null, error: r.error };
}

/**
 * Reads each tree's tour straight off the drawing: in-order through the treap
 * from each root. Nothing here asks the plugin what its tours are.
 */
function tours(g: StructureGraph): string[][] {
  const label = new Map<NodeId, string>();
  const kids = new Map<NodeId, { left: NodeId | null; right: NodeId | null }>();
  for (const n of g.nodes) {
    label.set(n.id, n.label);
    kids.set(n.id, { left: null, right: null });
  }
  for (const e of g.edges) {
    const slot = kids.get(e.from);
    if (slot === undefined) continue;
    if (e.slot === 'left') slot.left = e.to; else slot.right = e.to;
  }
  return g.roots.map((root) => {
    const out: string[] = [];
    const stack: NodeId[] = [];
    let cur: NodeId | null = root;
    while (cur !== null || stack.length > 0) {
      while (cur !== null) { stack.push(cur); cur = (kids.get(cur) as { left: NodeId | null }).left; }
      const id = stack.pop() as NodeId;
      out.push(label.get(id) as string);
      cur = (kids.get(id) as { right: NodeId | null }).right;
    }
    return out;
  });
}

/**
 * Checks one sequence really is an Euler tour of some tree, and returns the
 * tree it describes. This is the whole invariant: every rule below is a thing
 * that would stop being true if a splice were wrong by one entry.
 */
function readTour(walk: readonly string[]): { vertices: number[]; edges: string[] } | string {
  if (walk.length === 0) return 'an empty sequence is not a tree';

  // A vertex with no edges is the one case written as a bare vertex.
  if (walk.length === 1 && !(walk[0] as string).includes('→')) {
    return { vertices: [Number(walk[0])], edges: [] };
  }

  const crossings = new Set<string>();
  const vertices = new Set<number>();
  let at: number | null = null;
  let start = 0;

  for (const entry of walk) {
    const arrow = entry.indexOf('→');
    if (arrow < 0) return `a lone vertex entry (${entry}) inside a tree that has edges`;
    const from = Number(entry.slice(0, arrow));
    const to = Number(entry.slice(arrow + 1));
    if (at === null) { at = from; start = from; vertices.add(from); }
    if (from !== at) return `edge ${from}→${to} is crossed while standing at ${at}`;
    if (crossings.has(entry)) return `edge ${entry} is crossed twice in the same direction`;
    crossings.add(entry);
    vertices.add(to);
    at = to;
  }
  if (at !== start) return `the walk ends at ${at} but began at ${start}`;

  const edges: string[] = [];
  for (const crossing of crossings) {
    const arrow = crossing.indexOf('→');
    const x = crossing.slice(0, arrow);
    const y = crossing.slice(arrow + 1);
    if (!crossings.has(`${y}→${x}`)) return `${crossing} is never crossed back`;
    const key = Number(x) < Number(y) ? `${x}-${y}` : `${y}-${x}`;
    if (!edges.includes(key)) edges.push(key);
  }
  if (walk.length !== 2 * edges.length) {
    return `${walk.length} entries for ${edges.length} edges, expected ${2 * edges.length}`;
  }
  if (vertices.size !== edges.length + 1) {
    return `${vertices.size} vertices joined by ${edges.length} edges is not a tree`;
  }
  return { vertices: [...vertices].sort((x, y) => x - y), edges: edges.sort() };
}

/** Components by breadth-first search over the edge set. A different algorithm. */
function componentsOf(vertices: readonly number[], edges: readonly [number, number][]): Map<number, number> {
  const adjacency = new Map<number, number[]>();
  for (const v of vertices) adjacency.set(v, []);
  for (const [a, b] of edges) {
    (adjacency.get(a) as number[]).push(b);
    (adjacency.get(b) as number[]).push(a);
  }
  const owner = new Map<number, number>();
  let next = 0;
  for (const v of vertices) {
    if (owner.has(v)) continue;
    const id = next;
    next += 1;
    const queue = [v];
    owner.set(v, id);
    while (queue.length > 0) {
      const cur = queue.shift() as number;
      for (const other of adjacency.get(cur) as number[]) {
        if (owner.has(other)) continue;
        owner.set(other, id);
        queue.push(other);
      }
    }
  }
  return owner;
}

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, ['build [1 2 1 3 2 4 2 5]', 'link 5 6', 'cut 1 3', 'connected 4 6'])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. Building ───────────────────────────────────────────────────── */

console.log('\nbuilding');

const inst = fresh();
const built = run(inst, 'build [1 2 1 3 2 4 2 5]').value as
  { vertices: number; edges: number; trees: number; entries: number };
check('a tree of k vertices is a tour of 2(k - 1) entries',
  built.entries === 2 * (built.vertices - 1), `${built.vertices} vertices, ${built.entries} entries`);
check('one tour per tree', built.trees === 1);

check('a forest is allowed, and counted', (() => {
  const r = run(fresh(), 'build [1 2 3 4 5 6]').value as { trees: number; entries: number };
  return r.trees === 3 && r.entries === 6;
})(), 'three separate edges are three trees of two, two entries each');

check('a cycle is refused, and named', (() => {
  const r = run(fresh(), 'build [1 2 2 3 3 1]');
  return r.error?.code === 'PRECONDITION_FAILED' && r.error.message.includes('closes a cycle');
})());
check('a repeated edge is refused',
  (run(fresh(), 'build [1 2 1 2]').error?.hint ?? '').includes('at most one path'));
check('a self loop is refused',
  run(fresh(), 'build [1 1]').error?.code === 'PRECONDITION_FAILED');
check('an odd list is refused',
  run(fresh(), 'build [1 2 3]').error?.code === 'BAD_ARGUMENT');
check('an unknown vertex is refused, and says what exists',
  (run(inst, 'connected 1 42').error?.hint ?? '').includes('vertices: 1, 2, 3, 4, 5'));

/* ── 3. The tour is a real tour ────────────────────────────────────── */

console.log('\nthe tour itself');

check('the drawing spells out a walk that closes', (() => {
  const read = tours(inst.getStructure()).map(readTour);
  return read.every((r) => typeof r !== 'string');
})(), typeof tours(inst.getStructure()).map(readTour)[0] === 'string'
  ? String(tours(inst.getStructure()).map(readTour)[0]) : 'entered and left every subtree once');

check('the walk describes the tree that was asked for', (() => {
  const read = readTour(tours(inst.getStructure())[0] as string[]);
  if (typeof read === 'string') return false;
  return read.vertices.join(',') === '1,2,3,4,5'
    && read.edges.join(' ') === '1-2 1-3 2-4 2-5';
})(), 'edges recovered from the sequence, not read off the plugin');

check('every edge occurs exactly twice, once each way', (() => {
  const walk = tours(inst.getStructure())[0] as string[];
  const counts = new Map<string, number>();
  for (const e of walk) {
    if (!e.includes('→')) continue;
    counts.set(e, (counts.get(e) ?? 0) + 1);
  }
  if ([...counts.values()].some((c) => c !== 1)) return false;
  // Each direction present once means each edge present twice.
  for (const e of counts.keys()) {
    const [x, y] = e.split('→');
    if (!counts.has(`${y}→${x}`)) return false;
  }
  return counts.size === 8;
})(), '4 edges, 8 directed occurrences');

/* ── 4. Cutting and joining ────────────────────────────────────────── */

console.log('\ncutting and joining');

check('cutting an edge makes two trees', (() => {
  const p = fresh();
  run(p, 'build [1 2 1 3 2 4 2 5]');
  const r = run(p, 'cut 1 2').value as { trees: number; entries: number };
  const c = run(p, 'connected 1 4').value as { connected: boolean };
  return r.trees === 2 && !c.connected;
})());

check('the two halves are the right sizes', (() => {
  const p = fresh();
  run(p, 'build [1 2 1 3 2 4 2 5]');
  run(p, 'cut 1 2');
  const left = run(p, 'connected 1 3').value as { connected: boolean; treeSize: number };
  const right = run(p, 'connected 2 4').value as { connected: boolean; treeSize: number };
  return left.connected && left.treeSize === 2 && right.connected && right.treeSize === 3;
})(), '1-3 stays together, 2-4-5 stays together');

check('linking two trees joins them', (() => {
  const p = fresh();
  run(p, 'build [1 2 3 4]');
  const before = (run(p, 'connected 1 4').value as { connected: boolean }).connected;
  run(p, 'link 2 3');
  const after = run(p, 'connected 1 4').value as { connected: boolean; treeSize: number };
  return !before && after.connected && after.treeSize === 4;
})());

check('linking within one tree is refused', (() => {
  const p = fresh();
  run(p, 'build [1 2 2 3]');
  const r = run(p, 'link 1 3');
  return r.error?.code === 'PRECONDITION_FAILED' && (r.error.hint ?? '').includes('close a cycle');
})(), 'a tour describes a tree, and that would not be one');

check('cutting an edge that is not there is refused, and lists what is',
  (run(inst, 'cut 3 4').error?.hint ?? '').includes('1-2, 1-3, 2-4, 2-5'));

check('linking an unmentioned vertex creates it', (() => {
  const p = fresh();
  run(p, 'build [1 2]');
  run(p, 'link 2 9');
  const r = run(p, 'connected 1 9').value as { connected: boolean; treeSize: number };
  return r.connected && r.treeSize === 3;
})());

check('cut then link restores the tour', (() => {
  const p = fresh();
  run(p, 'build [1 2 1 3 2 4 2 5]');
  const before = (run(p, 'tour 1').value as { walk: string[] }).walk.length;
  run(p, 'cut 2 4');
  run(p, 'link 2 4');
  const after = run(p, 'tour 1').value as { walk: string[]; vertices: number };
  const read = readTour(after.walk);
  return after.walk.length === before && typeof read !== 'string'
    && read.edges.join(' ') === '1-2 1-3 2-4 2-5';
})(), 'the same tree, though not necessarily the same rotation');

/* ── 5. Against breadth-first search ───────────────────────────────── */

console.log('\nproperty test vs breadth-first search');

const rng = createRng(20_260_821);
let trials = 0;
let operations = 0;
let firstFailure = '';

for (let t = 0; t < 25 && firstFailure === ''; t += 1) {
  const n = rng.nextInt(2, 14);
  const p = plugin.createInstance({ rng: createRng(t + 1) });

  // Start from a random forest: each vertex may hang off an earlier one.
  const model: [number, number][] = [];
  for (let i = 2; i <= n; i += 1) {
    if (rng.next() < 0.7) model.push([rng.nextInt(1, i), i]);
  }
  const vertices = Array.from({ length: n }, (_, i) => i + 1);
  const present = new Set(model.flat());
  if (present.size === 0) continue;
  const r = run(p, `build [${model.flat().join(' ')}]`);
  if (r.error !== null) { firstFailure = `build failed: ${r.error.message}`; break; }
  trials += 1;

  for (let step = 0; step < 14 && firstFailure === ''; step += 1) {
    const live = [...present].sort((x, y) => x - y);
    const owner = componentsOf(live, model);
    const cutting = model.length > 0 && rng.next() < 0.45;

    if (cutting) {
      const i = rng.nextInt(0, model.length);
      const [a, b] = model[i] as [number, number];
      const res = run(p, `cut ${a} ${b}`);
      if (res.error !== null) { firstFailure = `cut ${a} ${b}: ${res.error.message}`; break; }
      model.splice(i, 1);
    } else {
      // Two vertices in different components, so the link is legal.
      const a = live[rng.nextInt(0, live.length)] as number;
      const other = live.filter((v) => owner.get(v) !== owner.get(a));
      if (other.length === 0) continue;
      const b = other[rng.nextInt(0, other.length)] as number;
      const res = run(p, `link ${a} ${b}`);
      if (res.error !== null) { firstFailure = `link ${a} ${b}: ${res.error.message}`; break; }
      model.push([a, b]);
    }
    operations += 1;

    // Every tour must still be a tour, and must describe what the model says.
    const g = p.getStructure();
    const read = tours(g).map(readTour);
    const broken = read.find((x) => typeof x === 'string');
    if (broken !== undefined) { firstFailure = `after ${operations} operations: ${broken as string}`; break; }

    const seen = (read as { vertices: number[]; edges: string[] }[])
      .flatMap((x) => x.edges).sort().join(' ');
    const want = model
      .map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`)).sort().join(' ');
    if (seen !== want) {
      firstFailure = `tours describe edges [${seen}], the model has [${want}]`;
      break;
    }

    // And connectivity must agree with walking the edges directly.
    const owner2 = componentsOf([...present].sort((x, y) => x - y), model);
    for (const a of present) {
      for (const b of present) {
        const got = run(p, `connected ${a} ${b}`).value as { connected: boolean; treeSize: number | null };
        const expected = owner2.get(a) === owner2.get(b);
        if (got.connected !== expected) {
          firstFailure = `connected ${a} ${b} says ${got.connected}, search says ${expected}`;
          break;
        }
        if (expected) {
          const size = [...present].filter((v) => owner2.get(v) === owner2.get(a)).length;
          if (got.treeSize !== size) {
            firstFailure = `tree holding ${a} reports ${got.treeSize} vertices, search counts ${size}`;
            break;
          }
        }
      }
      if (firstFailure !== '') break;
    }
  }
  void vertices;
}

check('tours stay valid and connectivity agrees with search',
  firstFailure === '',
  firstFailure === '' ? `${trials} forests, ${operations} links and cuts` : firstFailure);

/* ── 6. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build [1 2 1 3 2 4 2 5]', 'tour 1', 'cut 1 2', 'connected 1 4', 'link 3 4', 'connected 1 4']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
