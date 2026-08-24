/**
 * Conformance, and both answers against their own definitions - remove the
 * thing and count the pieces.
 *
 *     node packages/plugins/bridges/src/plugin.check.ts
 */

import { createRng, help, parseCommand, type OperationError } from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { bridges as plugin } from './plugin.ts';

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

const at = (r: { value: unknown }, key: string): unknown =>
  (r.value as Record<string, unknown> | null)?.[key];

type Pair = readonly [number, number];

/** How many pieces a graph falls into, by plain breadth-first search. */
function pieces(vertices: readonly number[], edges: readonly Pair[]): number {
  const adjacency = new Map<number, number[]>(vertices.map((v) => [v, []]));
  for (const [a, b] of edges) {
    adjacency.get(a)?.push(b);
    adjacency.get(b)?.push(a);
  }
  const seen = new Set<number>();
  let count = 0;
  for (const v of vertices) {
    if (seen.has(v)) continue;
    count += 1;
    const queue = [v];
    while (queue.length > 0) {
      const cur = queue.shift() as number;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const n of adjacency.get(cur) ?? []) queue.push(n);
    }
  }
  return count;
}

/**
 * The definitions, applied literally: take the thing away and see whether the
 * graph fell apart. Quadratic and impossible to misread, which is exactly what
 * a clever one-pass algorithm needs to be checked against.
 */
function bruteBridges(vertices: readonly number[], edges: readonly Pair[]): string[] {
  const before = pieces(vertices, edges);
  return edges
    .filter((_, i) => pieces(vertices, edges.filter((__, j) => j !== i)) > before)
    .map(([a, b]) => `${a}-${b}`)
    .sort();
}

function bruteCuts(vertices: readonly number[], edges: readonly Pair[]): number[] {
  const before = pieces(vertices, edges);
  return vertices.filter((v) => {
    const rest = vertices.filter((w) => w !== v);
    const kept = edges.filter(([a, b]) => a !== v && b !== v);
    return pieces(rest, kept) > before;
  });
}

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, ['build [1 2 2 3 3 1 3 4 4 5]', 'bridges', 'cuts', 'numbers'])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. A triangle with a tail ─────────────────────────────────────── */

console.log('\na triangle with a tail');

const inst = fresh();
run(inst, 'build [1 2 2 3 3 1 3 4 4 5]');

check('the cycle edges are safe and the tail edges are not', (() => {
  // 1-2, 2-3, 3-1 form a triangle; 3-4 and 4-5 hang off it in a line.
  const r = run(inst, 'bridges');
  return at(r, 'count') === 2
    && JSON.stringify(at(r, 'edges')) === JSON.stringify(['3-4', '4-5']);
})(), 'only 3-4 and 4-5, because the triangle holds itself together');

check('the vertices holding the tail on are the cut vertices', (() => {
  const r = run(inst, 'cuts');
  return JSON.stringify(at(r, 'vertices')) === JSON.stringify([3, 4]);
})(), '3 attaches the tail, 4 holds 5 on; nothing else matters');

check('a vertex can matter without its edges being bridges', (() => {
  /*
   * The distinction the equals sign makes. In two triangles joined at one
   * vertex, that vertex is critical but no single edge is.
   */
  const q = fresh();
  run(q, 'build [1 2 2 3 3 1 3 4 4 5 5 3]');
  return at(run(q, 'bridges'), 'count') === 0
    && JSON.stringify(at(run(q, 'cuts'), 'vertices')) === JSON.stringify([3]);
})(), 'two triangles sharing a vertex: no bridges, one cut vertex');

check('a cycle has neither', (() => {
  const q = fresh();
  run(q, 'build [1 2 2 3 3 4 4 1]');
  return at(run(q, 'bridges'), 'count') === 0 && at(run(q, 'cuts'), 'count') === 0;
})());

check('a line is all bridges, and every middle vertex matters', (() => {
  const q = fresh();
  run(q, 'build [1 2 2 3 3 4]');
  const b = run(q, 'bridges');
  return at(b, 'count') === 3 && at(b, 'forest') === true
    && JSON.stringify(at(run(q, 'cuts'), 'vertices')) === JSON.stringify([2, 3]);
})(), 'the ends are not cut vertices, because nothing hangs off them');

check('a single edge is a bridge with no cut vertices', (() => {
  const q = fresh();
  run(q, 'build [7 9]');
  return at(run(q, 'bridges'), 'count') === 1 && at(run(q, 'cuts'), 'count') === 0;
})(), 'losing either end leaves one vertex, which is still one piece');

check('the root of the walk is judged by its branches, not its parent', (() => {
  /*
   * Vertex 2 is the centre of a star and the walk starts at 1, so 2 is not a
   * root - but 1 is, and it has only one branch, so it must not be reported.
   */
  const q = fresh();
  run(q, 'build [1 2 2 3 2 4]');
  return JSON.stringify(at(run(q, 'cuts'), 'vertices')) === JSON.stringify([2]);
})());

check('numbers say where each subtree can climb back to', (() => {
  const q = fresh();
  run(q, 'build [1 2 2 3 3 1]');
  const rows = at(run(q, 'numbers'), 'rows') as { vertex: number; canGetBackTo: number }[];
  // Everything in a triangle can get back to the start of it.
  return rows.every((row) => row.canGetBackTo === 0);
})());

/* ── 3. Refusing ───────────────────────────────────────────────────── */

console.log('\nerrors');

check('an odd list is refused', (() => {
  const r = run(fresh(), 'build [1 2 3]');
  return r.error?.code === 'BAD_ARGUMENT' && (r.error.hint ?? '').includes('joins 1-2 and 2-3');
})());
check('a self edge is refused, with the reason',
  (run(fresh(), 'build [1 1]').error?.hint ?? '').includes('its own cycle'));
check('a repeated pair is refused, and says why it would break the walk',
  (run(fresh(), 'build [1 2 1 2]').error?.hint ?? '').includes('skips the parent by vertex'));
check('nothing can be asked before a build', (() => {
  const parsed = parseCommand('bridges', plugin.commands);
  if (!parsed.ok) return false;
  const r = fresh().execute(parsed.command);
  return !r.ok && r.error.code === 'PRECONDITION_FAILED';
})());

/* ── 4. Against removing things and counting ───────────────────────── */

console.log('\nproperty test vs removing and counting');

const rng = createRng(20_260_830);
let trials = 0;
let disconnected = 0;
let firstFailure = '';

for (let t = 0; t < 80 && firstFailure === ''; t += 1) {
  const n = rng.nextInt(2, 9);
  const edges: Pair[] = [];
  const pairs: number[] = [];
  for (let a = 1; a <= n; a += 1) {
    for (let b = a + 1; b <= n; b += 1) {
      // Sparse on purpose: dense graphs have no bridges at all, and the
      // interesting cases are the ones held together by a single thread.
      if (rng.next() > 0.32) continue;
      edges.push([a, b] as Pair);
      pairs.push(a, b);
    }
  }
  if (edges.length === 0) continue;

  const q = fresh();
  const built = run(q, `build [${pairs.join(' ')}]`);
  if (built.error !== null) { firstFailure = `build failed: ${built.error.message}`; break; }
  trials += 1;

  const present = [...new Set(edges.flat())].sort((x, y) => x - y);
  if (pieces(present, edges) > 1) disconnected += 1;

  const wantBridges = bruteBridges(present, edges);
  const gotBridges = at(run(q, 'bridges'), 'edges') as string[];
  if (JSON.stringify([...gotBridges].sort()) !== JSON.stringify(wantBridges)) {
    firstFailure = `[${pairs.join(' ')}] gave bridges [${gotBridges}], removing each gives [${wantBridges}]`;
    break;
  }

  const wantCuts = bruteCuts(present, edges);
  const gotCuts = at(run(q, 'cuts'), 'vertices') as number[];
  if (JSON.stringify(gotCuts) !== JSON.stringify(wantCuts)) {
    firstFailure = `[${pairs.join(' ')}] gave cuts [${gotCuts}], removing each gives [${wantCuts}]`;
    break;
  }

  /*
   * A relation between the two answers, checked as well as each separately:
   * a bridge's endpoint is a cut vertex unless it has nothing else attached.
   */
  const degree = new Map<number, number>(present.map((v) => [v, 0]));
  for (const [a, b] of edges) {
    degree.set(a, (degree.get(a) as number) + 1);
    degree.set(b, (degree.get(b) as number) + 1);
  }
  for (const label of gotBridges) {
    const [a, b] = label.split('-').map(Number) as [number, number];
    for (const end of [a, b]) {
      if ((degree.get(end) as number) > 1 && !gotCuts.includes(end)) {
        firstFailure = `${end} is on bridge ${label} and has other edges, but is not a cut vertex`;
        break;
      }
    }
    if (firstFailure !== '') break;
  }
}

check('both answers match removing the thing and counting the pieces',
  firstFailure === '',
  firstFailure === '' ? `${trials} graphs, ${disconnected} of them in more than one piece` : firstFailure);

/* ── 5. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build [1 2 2 3 3 1 3 4 4 5]', 'bridges', 'cuts', 'numbers']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
