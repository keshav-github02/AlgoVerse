/**
 * Conformance, Dijkstra against a brute-force model, and the first edges that
 * carry data.
 *
 *     node packages/plugins/shortest-path/src/plugin.check.ts
 */

import { createRng, help, layout, parseCommand, type OperationError } from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { shortestPath as plugin } from './plugin.ts';

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

/** Shortest distances by repeated relaxation - a different algorithm on purpose. */
function bellmanFord(
  vertices: readonly number[],
  edges: readonly [number, number, number][],
  from: number,
): Map<number, number> {
  const dist = new Map<number, number>([[from, 0]]);
  for (let pass = 0; pass < vertices.length; pass += 1) {
    for (const [a, b, w] of edges) {
      for (const [x, y] of [[a, b], [b, a]] as const) {
        const dx = dist.get(x);
        if (dx === undefined) continue;
        const dy = dist.get(y);
        if (dy === undefined || dy > dx + w) dist.set(y, dx + w);
      }
    }
  }
  return dist;
}

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, ['build [1 2 4 2 3 1 1 3 9]', 'link 3 4 2', 'dijkstra 1'])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. Building ───────────────────────────────────────────────────── */

console.log('\nbuilding');

const inst = fresh();
const built = run(inst, 'build [1 2 4 2 3 1 1 3 9]').value as { vertices: number; edges: number };
check('triples become weighted edges', built.vertices === 3 && built.edges === 3);

check('a list that is not a multiple of three is refused', (() => {
  const r = run(fresh(), 'build [1 2 3 4]');
  return r.error?.code === 'BAD_ARGUMENT' && (r.error.hint ?? '').includes('each triple is one edge');
})());
check('a negative cost is refused, with the reason', (() => {
  const r = run(fresh(), 'build [1 2 -5]');
  return r.error?.code === 'BAD_ARGUMENT' && (r.error.hint ?? '').includes('never revisits');
})(), 'Dijkstra cannot cope with one, and says so rather than returning nonsense');
check('a negative cost is refused on link too',
  run(inst, 'link 1 9 -1').error?.code === 'BAD_ARGUMENT');
check('a repeated edge is refused',
  run(inst, 'link 1 2 3').error?.code === 'PRECONDITION_FAILED');
check('an unknown source is refused, and says what exists',
  (run(inst, 'dijkstra 42').error?.hint ?? '').includes('vertices: 1, 2, 3'));

/* ── 3. Dijkstra ───────────────────────────────────────────────────── */

console.log('\nsettling');

// 1-2 is 4, 2-3 is 1, 1-3 is 9: going through 2 costs 5, so the direct 9 loses.
const settled = run(inst, 'dijkstra 1').value as
  { order: number[]; distances: Record<string, number>; settled: number };
check('the cheaper route wins over the direct edge',
  settled.distances['3'] === 5, `1 to 3 costs ${settled.distances['3']}, not 9`);
check('vertices settle nearest first', settled.order.join(',') === '1,2,3', settled.order.join(','));
check('the source is at distance zero', settled.distances['1'] === 0);

check('an unreachable vertex is reported, not invented', (() => {
  const p = fresh();
  run(p, 'build [1 2 1 3 4 1]');
  const r = run(p, 'dijkstra 1').value as { settled: number; unreachable: number };
  return r.settled === 2 && r.unreachable === 2;
})());

check('path reports the route and its cost', (() => {
  const p = fresh();
  run(p, 'build [1 2 4 2 3 1 1 3 9]');
  const r = run(p, 'path 1 3').value as { route: number[]; cost: number; hops: number };
  return r.route.join(',') === '1,2,3' && r.cost === 5 && r.hops === 2;
})());
check('a path to an unreachable vertex says so', (() => {
  const p = fresh();
  run(p, 'build [1 2 1 3 4 1]');
  const r = run(p, 'path 1 4').value as { reachable: boolean; cost: number | null };
  return !r.reachable && r.cost === null;
})());
check('a path to itself costs nothing', (() => {
  const p = fresh();
  run(p, 'build [1 2 5]');
  const r = run(p, 'path 1 1').value as { route: number[]; cost: number };
  return r.cost === 0 && r.route.join(',') === '1';
})());

/* ── 4. Edges that carry data ──────────────────────────────────────── */

console.log('\nweighted edges');

const weighted = fresh();
run(weighted, 'build [1 2 4 2 3 1 1 3 9 3 4 2 4 5 6]');
const structure = weighted.getStructure();

check('every edge carries its cost', structure.edges.every((e) => typeof e.weight === 'number'),
  `${structure.edges.length} edges, all weighted`);
check('the weights are the ones given',
  structure.edges.map((e) => e.weight).sort((a, b) => (a ?? 0) - (b ?? 0)).join(',') === '1,2,4,6,9');
check('weights survive into the positioned scene',
  layout(structure).edges.every((e) => typeof e.weight === 'number'));
check('an edge is still a link, not hierarchy',
  structure.edges.every((e) => e.kind === 'link'));

check('the log carries the weight, not just the picture', (() => {
  // Conformance already compares log to structure; this states the reason.
  const p = fresh();
  const parsed = parseCommand('build [1 2 7]', plugin.commands);
  if (!parsed.ok) return false;
  const r = p.execute(parsed.command);
  return r.events.some((e) => e.kind === 'PointerSet' && e.weight === 7);
})());

/* ── 5. Against a different algorithm ──────────────────────────────── */

console.log('\nproperty test vs repeated relaxation');

const rng = createRng(20_260_817);
let trials = 0;
let sources = 0;
let firstFailure = '';

for (let t = 0; t < 30 && firstFailure === ''; t += 1) {
  const size = rng.nextInt(2, 9);
  const triples: number[] = [];
  const edges: [number, number, number][] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rng.nextInt(1, 14); i += 1) {
    const a = rng.nextInt(1, size + 1);
    const b = rng.nextInt(1, size + 1);
    if (a === b) continue;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const w = rng.nextInt(1, 20);
    triples.push(a, b, w);
    edges.push([a, b, w]);
  }
  if (edges.length === 0) continue;

  const p = fresh();
  run(p, `build [${triples.join(' ')}]`);
  const vertices = [...new Set(edges.flatMap(([a, b]) => [a, b]))].sort((x, y) => x - y);
  trials += 1;

  for (const from of vertices) {
    sources += 1;
    const want = bellmanFord(vertices, edges, from);
    const got = (run(p, `dijkstra ${from}`).value as { distances: Record<string, number> }).distances;

    for (const v of vertices) {
      const expected = want.get(v);
      const actual = got[String(v)];
      if (expected === undefined ? actual !== undefined : actual !== expected) {
        firstFailure = `from ${from} to ${v}: got ${actual ?? 'unreachable'}, expected ${expected ?? 'unreachable'}`;
        break;
      }
    }
    if (firstFailure !== '') break;

    // The route path reports must actually cost what it claims.
    for (const to of vertices) {
      const r = run(p, `path ${from} ${to}`).value as
        { reachable: boolean; route: number[]; cost: number | null };
      if (!r.reachable) continue;
      let walked = 0;
      for (let i = 1; i < r.route.length; i += 1) {
        const a = r.route[i - 1] as number;
        const b = r.route[i] as number;
        const edge = edges.find(([x, y]) => (x === a && y === b) || (x === b && y === a));
        if (edge === undefined) { firstFailure = `route ${a}->${b} uses an edge that does not exist`; break; }
        walked += edge[2];
      }
      if (firstFailure !== '') break;
      if (walked !== r.cost) {
        firstFailure = `route ${r.route.join('-')} claims ${r.cost} but costs ${walked}`;
        break;
      }
    }
    if (firstFailure !== '') break;
  }
}

check('distances agree with repeated relaxation, and routes cost what they claim',
  firstFailure === '',
  firstFailure === '' ? `${trials} graphs, ${sources} sources` : firstFailure);

/* ── 6. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build [1 2 4 2 3 1 1 3 9 3 4 2]', 'dijkstra 1', 'path 1 4', 'link 1 4 20', 'path 1 4']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
