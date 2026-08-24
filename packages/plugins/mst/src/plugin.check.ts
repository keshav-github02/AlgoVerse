/**
 * Conformance, the two strategies against each other, and both against every
 * possible spanning tree.
 *
 *     node packages/plugins/mst/src/plugin.check.ts
 */

import { createRng, help, parseCommand, type OperationError } from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { mst as plugin } from './plugin.ts';

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

type Triple = readonly [number, number, number];

/** Reads the reported edges back into numbers, so they can be checked. */
function chosenOf(r: { value: unknown }): Triple[] {
  const list = at(r, 'edges') as string[] | undefined;
  if (list === undefined) return [];
  return list.map((s) => {
    const m = /^(-?\d+)-(-?\d+) \((-?\d+)\)$/.exec(s);
    if (m === null) return [NaN, NaN, NaN] as Triple;
    return [Number(m[1]), Number(m[2]), Number(m[3])] as Triple;
  });
}

/** Whether a set of edges joins every vertex into one piece. */
function joinsAll(vertices: readonly number[], edges: readonly Triple[]): boolean {
  const parent = new Map<number, number>(vertices.map((v) => [v, v]));
  const find = (v: number): number => {
    let r = v;
    while ((parent.get(r) as number) !== r) r = parent.get(r) as number;
    return r;
  };
  for (const [a, b] of edges) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  return new Set(vertices.map(find)).size === 1;
}

/**
 * The cheapest spanning tree, by trying every set of the right size.
 *
 * Exponential and obviously correct, which is the only kind of reference worth
 * having for a greedy algorithm - it is exactly the "but is greedy really
 * enough" question that needs answering.
 */
function bruteForce(vertices: readonly number[], edges: readonly Triple[]): number | null {
  const need = vertices.length - 1;
  let best: number | null = null;
  const picked: Triple[] = [];
  const walk = (from: number): void => {
    if (picked.length === need) {
      if (joinsAll(vertices, picked)) {
        const total = picked.reduce((s, e) => s + e[2], 0);
        if (best === null || total < best) best = total;
      }
      return;
    }
    for (let i = from; i < edges.length; i += 1) {
      picked.push(edges[i] as Triple);
      walk(i + 1);
      picked.pop();
    }
  };
  walk(0);
  return best;
}

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, ['build [1 2 4 2 3 1 1 3 9 3 4 2]', 'prim', 'kruskal', 'agree'])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. A worked example ───────────────────────────────────────────── */

console.log('\na graph with one clear answer');

const inst = fresh();
run(inst, 'build [1 2 4 2 3 1 1 3 9 3 4 2]');

check('prim finds the cheapest tree', (() => {
  // 1-2 (4), 2-3 (1), 3-4 (2) totals 7; taking 1-3 (9) instead of 1-2 is worse.
  const r = run(inst, 'prim');
  return at(r, 'total') === 7 && at(r, 'kept') === 3 && at(r, 'spanning') === true;
})(), '4 + 1 + 2 = 7, and the 9 is left out');

check('kruskal finds the same total', at(run(inst, 'kruskal'), 'total') === 7);

check('the two agree, and say so', (() => {
  const r = run(inst, 'agree');
  return at(r, 'agree') === true && at(r, 'prim') === 7 && at(r, 'kruskal') === 7;
})());

check('kruskal reports the edges it threw away', (() => {
  const r = run(inst, 'kruskal');
  // Four edges, three kept, so exactly one was rejected for closing a cycle.
  return at(r, 'examined') === 4 && at(r, 'rejected') === 1;
})());

check('prim reports how much scanning it did', (() => {
  const r = run(inst, 'prim');
  return (at(r, 'scanned') as number) > 0;
})());

/* ── 3. Forests and refusals ───────────────────────────────────────── */

console.log('\nedges');

check('a disconnected graph gives one tree per piece', (() => {
  const q = fresh();
  run(q, 'build [1 2 5 3 4 7]');
  const p = run(q, 'prim');
  const k = run(q, 'kruskal');
  // Four vertices in two pieces: two edges, not three, and both agree.
  return at(p, 'pieces') === 2 && at(p, 'kept') === 2 && at(p, 'total') === 12
    && at(k, 'total') === 12 && at(p, 'spanning') === true;
})(), 'a forest is the honest answer, and is reported as one');

check('a single edge is its own spanning tree', (() => {
  const q = fresh();
  run(q, 'build [7 9 3]');
  return at(run(q, 'prim'), 'total') === 3 && at(run(q, 'kruskal'), 'total') === 3;
})());

check('negative weights are allowed and still handled', (() => {
  // Nothing in either algorithm needs weights to be positive - unlike
  // Dijkstra next door, which refuses them outright.
  const q = fresh();
  run(q, 'build [1 2 -5 2 3 -2 1 3 1]');
  const r = run(q, 'prim');
  return at(r, 'total') === -7 && at(run(q, 'kruskal'), 'total') === -7;
})(), 'a spanning tree must span, so it takes the cheapest even when cheap is negative');

check('a list that is not a multiple of three is refused', (() => {
  const r = run(fresh(), 'build [1 2 3 4]');
  return r.error?.code === 'BAD_ARGUMENT' && (r.error.hint ?? '').includes('cost of 4');
})());
check('a self edge is refused, with the reason',
  (run(fresh(), 'build [1 1 5]').error?.hint ?? '').includes('never be part of one'));
check('a repeated pair is refused, with the advice',
  (run(fresh(), 'build [1 2 5 1 2 3]').error?.hint ?? '').includes('keep the cheaper one'));
check('nothing can be asked before a build', (() => {
  const parsed = parseCommand('prim', plugin.commands);
  if (!parsed.ok) return false;
  const r = fresh().execute(parsed.command);
  return !r.ok && r.error.code === 'PRECONDITION_FAILED';
})());

/* ── 4. Against every possible spanning tree ───────────────────────── */

console.log('\nproperty test vs every spanning tree');

const rng = createRng(20_260_829);
let trials = 0;
let differentEdges = 0;
let firstFailure = '';

for (let t = 0; t < 60 && firstFailure === ''; t += 1) {
  const n = rng.nextInt(2, 7);

  // Every pair, kept with some probability, so both connected and
  // disconnected graphs turn up. Small weights make ties common, which is
  // where two greedy strategies are most likely to part company.
  const edges: Triple[] = [];
  const triples: number[] = [];
  for (let a = 1; a <= n; a += 1) {
    for (let b = a + 1; b <= n; b += 1) {
      if (rng.next() > 0.55) continue;
      const w = rng.nextInt(1, 6);
      edges.push([a, b, w] as Triple);
      triples.push(a, b, w);
    }
  }
  if (edges.length === 0) continue;

  const q = fresh();
  const built = run(q, `build [${triples.join(' ')}]`);
  if (built.error !== null) { firstFailure = `build failed: ${built.error.message}`; break; }
  trials += 1;

  const present = [...new Set(edges.flatMap(([a, b]) => [a, b]))].sort((x, y) => x - y);
  const primRun = run(q, 'prim');
  const kruskalRun = run(q, 'kruskal');
  const primTotal = at(primRun, 'total') as number;
  const kruskalTotal = at(kruskalRun, 'total') as number;

  // The cross-check: two strategies, one answer.
  if (primTotal !== kruskalTotal) {
    firstFailure = `prim says ${primTotal}, kruskal says ${kruskalTotal} on [${triples.join(' ')}]`;
    break;
  }
  if (at(run(q, 'agree'), 'sameEdges') === false) differentEdges += 1;

  for (const [label, result] of [['prim', primRun], ['kruskal', kruskalRun]] as const) {
    const chosen = chosenOf(result);

    // Every reported edge has to be one that actually exists.
    const missing = chosen.find(([a, b, w]) =>
      !edges.some(([x, y, z]) => x === a && y === b && z === w));
    if (missing !== undefined) {
      firstFailure = `${label} reported ${missing.join('-')}, which is not an edge of the graph`;
      break;
    }
    // And the result has to be a tree per piece: no cycles, nothing left out.
    const pieces = at(result, 'pieces') as number;
    if (chosen.length !== present.length - pieces) {
      firstFailure = `${label} kept ${chosen.length} edges for ${present.length} vertices in ${pieces} pieces`;
      break;
    }
    if (pieces === 1 && !joinsAll(present, chosen)) {
      firstFailure = `${label} left the graph in more than one piece`;
      break;
    }
  }
  if (firstFailure !== '') break;

  /*
   * And the answer is not merely consistent but minimal. Only worth doing on
   * a connected graph small enough to enumerate, which is what the sizes here
   * are chosen for.
   */
  if (present.length === n && joinsAll(present, edges)) {
    const want = bruteForce(present, edges);
    if (want !== null && want !== primTotal) {
      firstFailure = `greedy gave ${primTotal}, the cheapest of all spanning trees is ${want}`;
      break;
    }
  }
}

check('both strategies agree, and both are genuinely minimal',
  firstFailure === '',
  firstFailure === ''
    ? `${trials} graphs, ${differentEdges} where they chose different edges of equal total`
    : firstFailure);

check('ties can be settled differently without changing the total', (() => {
  /*
   * A square with every edge the same cost: several spanning trees are
   * cheapest, and the two strategies need not pick the same one. The check is
   * that they do not have to - only the total is forced.
   */
  const q = fresh();
  run(q, 'build [1 2 1 2 3 1 3 4 1 4 1 1]');
  const r = run(q, 'agree');
  return at(r, 'agree') === true && at(r, 'prim') === 3;
})(), 'four equal edges, three needed, one total');

/* ── 5. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build [1 2 4 2 3 1 1 3 9 3 4 2]', 'prim', 'kruskal', 'agree']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
