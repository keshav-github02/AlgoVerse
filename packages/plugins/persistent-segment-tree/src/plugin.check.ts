/**
 * Conformance plus property tests for the persistent segment tree.
 *
 *     node packages/plugins/persistent-segment-tree/src/plugin.check.ts
 */

import {
  Timeline, createRng, help, layout, parseCommand,
  type OperationError, type SceneState, type SimEvent,
} from '@algoverse/core';
import { ZERO_STATS, addStats, runConformance, type PluginInstance, type Statistics } from '@algoverse/plugin-sdk';
import { persistentSegmentTree as plugin } from './plugin.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

/** Folds a fresh log so an explainer can be asked what it would say. */
const replay = (events: readonly SimEvent[]): SceneState => {
  const t = new Timeline();
  t.append(events);
  return t.stateAt(t.length);
};

const fresh = (): PluginInstance => plugin.createInstance({ rng: createRng(1) });

/** Runs a console line. Returns the value, or null when the operation failed. */
function run(inst: PluginInstance, line: string): { value: unknown; error: OperationError | null } {
  const parsed = parseCommand(line, plugin.commands);
  if (!parsed.ok) return { value: null, error: parsed.error };
  const r = inst.execute(parsed.command);
  return r.ok ? { value: r.value, error: null } : { value: null, error: r.error };
}

const sumOf = (r: { value: unknown }): number => (r.value as { sum: number }).sum;

/* ── 1. Conformance kit ────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, [
  'build [3 1 4 1 5 9 2 6]',
  'update v0 3 10',
  'update v1 6 7',
  'query v1 2 5',
  'compare v0 v2',
])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. The spike's numbers, now from the real plugin ──────────────── */

console.log('\nstructural sharing');

const inst = fresh();
run(inst, 'build [3 1 4 1 5 9 2 6]');
run(inst, 'update v0 3 10');
run(inst, 'update v1 6 7');
const structure = inst.getStructure();

check('three versions produce 23 nodes, not 45', structure.nodes.length === 23,
  `${structure.nodes.length} nodes vs 45 naive (${Math.round((1 - structure.nodes.length / 45) * 100)}% saved)`);
check('every version is reachable', structure.roots.length === 3);
check('reused pointers are flagged', structure.edges.some((e) => e.reused),
  `${structure.edges.filter((e) => e.reused).length} of ${structure.edges.length} edges cross versions`);
check('slots align versions of the same range',
  new Set(structure.nodes.map((n) => n.slot)).size === 15,
  `${new Set(structure.nodes.map((n) => n.slot)).size} distinct slots for 23 nodes`);
check('compare reports 11 shared nodes',
  (run(inst, 'compare v0 v1').value as { shared: number }).shared === 11,
  JSON.stringify(run(inst, 'compare v0 v1').value));

/* ── 2b. Layout consumes the real structure ────────────────────────── */

console.log('\nlayout');

const scene = layout(structure);
check('every node is placed', scene.nodes.length === structure.nodes.length);
check('every edge is placed', scene.edges.length === structure.edges.length);
check('no two nodes overlap on a row', (() => {
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
})(), `${Math.round(scene.width)} x ${Math.round(scene.height)} px`);
check('reused pointers survive into the positioned scene',
  scene.edges.filter((e) => e.reused).length === structure.edges.filter((e) => e.reused).length);

/* ── 3. Errors are returned with useful hints ──────────────────────── */

console.log('\nerrors');

const errCases: readonly { readonly line: string; readonly code: string }[] = [
  { line: 'query v9 2 5', code: 'UNKNOWN_VERSION' },
  { line: 'update v0 99 1', code: 'INDEX_OUT_OF_RANGE' },
  { line: 'query v0 5 2', code: 'INVALID_RANGE' },
  { line: 'query v0 0 99', code: 'INVALID_RANGE' },
];
for (const c of errCases) {
  const r = run(inst, c.line);
  check(`${c.line} -> ${c.code}`, r.error?.code === c.code, r.error?.hint ?? '');
}

const unbuilt = run(fresh(), 'query v0 0 1');
check('querying before build explains itself', unbuilt.error?.code === 'UNKNOWN_VERSION',
  unbuilt.error?.hint ?? '');

/* ── 4. Property test against a naive model ────────────────────────── */

console.log('\nproperty test vs naive arrays');

const rng = createRng(20_260_808);
let trials = 0;
let queries = 0;
let firstFailure = '';

for (let t = 0; t < 60 && firstFailure === ''; t += 1) {
  const n = rng.nextInt(1, 13);
  const start = Array.from({ length: n }, () => rng.nextInt(-20, 40));
  const inst2 = fresh();
  run(inst2, `build [${start.join(' ')}]`);
  const model: number[][] = [[...start]];

  for (let op = 0; op < 10; op += 1) {
    const v = rng.nextInt(0, model.length);
    const roll = rng.next();
    if (roll < 0.35) {
      const i = rng.nextInt(0, n);
      const val = rng.nextInt(-20, 40);
      const r = run(inst2, `update v${v} ${i} ${val}`);
      if (r.error !== null) { firstFailure = `update failed: ${r.error.code}`; break; }
      const next = [...(model[v] as number[])];
      next[i] = val;
      model.push(next);
    } else if (roll < 0.6) {
      // A range add, which lands as tags and is never pushed down.
      let lo = rng.nextInt(0, n);
      let hi = rng.nextInt(0, n);
      if (lo > hi) [lo, hi] = [hi, lo];
      if (lo === hi) hi = Math.min(n, hi + 1);
      if (lo === hi) continue;
      const delta = rng.nextInt(-15, 25);
      const r = run(inst2, `apply v${v} ${lo} ${hi} ${delta}`);
      if (r.error !== null) { firstFailure = `apply failed: ${r.error.code}`; break; }
      const next = [...(model[v] as number[])];
      for (let i = lo; i < hi; i += 1) next[i] = (next[i] as number) + delta;
      model.push(next);
    } else {
      let lo = rng.nextInt(0, n);
      let hi = rng.nextInt(0, n);
      if (lo > hi) [lo, hi] = [hi, lo];
      if (lo === hi) hi = Math.min(n, hi + 1);
      if (lo === hi) continue;
      const r = run(inst2, `query v${v} ${lo} ${hi}`);
      queries += 1;
      const expected = (model[v] as number[]).slice(lo, hi).reduce((a, b) => a + b, 0);
      if (r.error !== null || sumOf(r) !== expected) {
        firstFailure = `query v${v} ${lo} ${hi} gave ${r.error?.code ?? sumOf(r)}, expected ${expected}`;
        break;
      }
    }
  }

  // Every version must still read correctly after all later writes, and
  // every way of reading it must agree with the same array.
  for (let v = 0; v < model.length && firstFailure === ''; v += 1) {
    const arr = model[v] as number[];
    for (let i = 0; i < n; i += 1) {
      const r = run(inst2, `query v${v} ${i} ${i + 1}`);
      queries += 1;
      if (r.error !== null || sumOf(r) !== (arr[i] as number)) {
        firstFailure = `v${v}[${i}] drifted: got ${r.error?.code ?? sumOf(r)}, expected ${String(arr[i])}`;
        break;
      }
    }
    if (firstFailure !== '') break;

    for (let i = 0; i < 4; i += 1) {
      let lo = rng.nextInt(0, n);
      let hi = rng.nextInt(0, n);
      if (lo > hi) [lo, hi] = [hi, lo];
      if (lo === hi) hi = Math.min(n, hi + 1);
      if (lo === hi) continue;
      const slice = arr.slice(lo, hi);
      for (const [what, expected] of [
        ['min', Math.min(...slice)],
        ['max', Math.max(...slice)],
      ] as const) {
        const r = run(inst2, `${what} v${v} ${lo} ${hi}`);
        queries += 1;
        const got = (r.value as Record<string, number> | null)?.[what];
        if (r.error !== null || got !== expected) {
          firstFailure = `${what} v${v} ${lo} ${hi} gave ${r.error?.code ?? String(got)}, expected ${expected}`;
          break;
        }
      }
      if (firstFailure !== '') break;
    }
    if (firstFailure !== '') break;

    /*
     * kth only means something when nothing is negative, which the plugin
     * refuses on rather than returning a wrong index. Where it does apply,
     * one descent must land where a running total says it should.
     */
    const total = arr.reduce((a, b) => a + b, 0);
    if (arr.every((x) => x >= 0) && total > 0) {
      const k = rng.nextInt(1, total + 1);
      const r = run(inst2, `kth v${v} ${k}`);
      queries += 1;
      let running = 0;
      let expected = -1;
      for (let i = 0; i < n; i += 1) {
        running += arr[i] as number;
        if (running >= k) { expected = i; break; }
      }
      const got = (r.value as { index: number } | null)?.index;
      if (r.error !== null || got !== expected) {
        firstFailure = `kth v${v} ${k} gave ${r.error?.code ?? String(got)}, expected ${expected}`;
        break;
      }
    }
  }
  trials += 1;
}

check('all versions agree with naive arrays', firstFailure === '',
  firstFailure === '' ? `${trials} trials, ${queries} queries` : firstFailure);

/* ── 4b. What the tags buy, and what they cost ─────────────────────── */

console.log('\nlazy tags');

check('a range add allocates by depth, not by width', (() => {
  // The point of not pushing down: covering 200 of 256 indices should touch
  // about as many nodes as covering 2 of them.
  const q = fresh();
  run(q, `build [${Array.from({ length: 256 }, () => 1).join(' ')}]`);
  const wide = run(q, 'apply v0 20 220 5').value as { allocated: number };
  const narrow = run(q, 'apply v0 20 22 5').value as { allocated: number };
  return wide.allocated < 40 && wide.allocated < narrow.allocated * 3;
})(), (() => {
  const q = fresh();
  run(q, `build [${Array.from({ length: 256 }, () => 1).join(' ')}]`);
  const wide = run(q, 'apply v0 20 220 5').value as { allocated: number };
  const narrow = run(q, 'apply v0 20 22 5').value as { allocated: number };
  return `200 indices cost ${wide.allocated} nodes, 2 indices cost ${narrow.allocated}`;
})());

check('a range add leaves earlier versions alone', (() => {
  const q = fresh();
  run(q, 'build [1 2 3 4 5 6 7 8]');
  run(q, 'apply v0 2 6 10');
  const before = run(q, 'query v0 0 8').value as { sum: number };
  const after = run(q, 'query v1 0 8').value as { sum: number };
  return before.sum === 36 && after.sum === 76;
})(), 'v0 stays 36 while v1 becomes 76');

check('a tag is visible on the node that carries it', (() => {
  // The tag has to be in the drawing, because it is the reason a node's
  // number is not its range's total.
  const q = fresh();
  run(q, 'build [1 1 1 1]');
  run(q, 'apply v0 0 2 7');
  const g = q.getStructure();
  return g.nodes.some((n) => n.role === 'tagged' && n.label.includes('+7'));
})());

check('a point write on top of a tag reads back exactly', (() => {
  // The leaf stores the value minus the tags above it, so that adding them
  // back gives what was written. Getting the sign wrong here is invisible
  // until a range add and a point write meet.
  const q = fresh();
  run(q, 'build [0 0 0 0]');
  run(q, 'apply v0 0 4 5');
  run(q, 'update v1 1 100');
  const one = run(q, 'query v2 1 2').value as { sum: number };
  const rest = run(q, 'query v2 0 1').value as { sum: number };
  return one.sum === 100 && rest.sum === 5;
})(), 'writing 100 under a +5 tag reads 100, and its neighbour stays 5');

check('kth refuses rather than guessing when a value is negative', (() => {
  const q = fresh();
  run(q, 'build [3 -1 4]');
  const r = run(q, 'kth v0 2');
  return r.error?.code === 'PRECONDITION_FAILED' && (r.error.hint ?? '').includes('at least 0');
})());

check('kth refuses a k the range never reaches', (() => {
  const q = fresh();
  run(q, 'build [1 2 3]');
  return run(q, 'kth v0 7').error?.code === 'PRECONDITION_FAILED';
})());

check('kth costs one descent, not one query per index', (() => {
  const q = fresh();
  run(q, `build [${Array.from({ length: 256 }, () => 1).join(' ')}]`);
  const r = run(q, 'kth v0 200').value as { index: number; visits: number };
  return r.index === 199 && r.visits <= 12;
})(), (() => {
  const q = fresh();
  run(q, `build [${Array.from({ length: 256 }, () => 1).join(' ')}]`);
  const r = run(q, 'kth v0 200').value as { visits: number };
  return `${r.visits} nodes visited for 256 indices`;
})());

check('min and max see through a tag', (() => {
  const q = fresh();
  run(q, 'build [5 1 9 3]');
  run(q, 'apply v0 0 4 -10');
  const lo = run(q, 'min v1 0 4').value as { min: number };
  const hi = run(q, 'max v1 0 4').value as { max: number };
  return lo.min === -9 && hi.max === -1;
})());

check('a reused node under a tag is not described as untouched', (() => {
  /*
   * Prose that reads well and says the wrong thing has slipped through here
   * before. Under a lazy tag the values below really do change - only the
   * copying is skipped - so the point-update wording would teach the opposite.
   */
  const q = fresh();
  const parsed = parseCommand('build [1 2 3 4]', plugin.commands);
  if (!parsed.ok) return false;
  q.execute(parsed.command);
  const applied = parseCommand('apply v0 0 2 5', plugin.commands);
  if (!applied.ok) return false;
  const r = q.execute(applied.command);
  const reuse = r.events.find((e) => e.kind === 'NodeReused');
  if (reuse === undefined) return false;
  const text = plugin.explain?.(reuse, { after: replay(r.events), command: applied.command, step: 1 }) ?? '';
  return text.includes('values have changed') && !text.includes('untouched');
})());

check('an empty or backwards range is refused',
  run(inst, 'apply v0 3 3 1').error?.code === 'INVALID_RANGE');

/* ── 5. Statistics accumulate ──────────────────────────────────────── */

console.log('\nstatistics');

const inst3 = fresh();
let stats: Statistics = ZERO_STATS;
for (const line of ['build [1 2 3 4 5 6 7 8]', 'update v0 0 100', 'update v1 7 -5', 'query v2 0 8']) {
  const parsed = parseCommand(line, plugin.commands);
  if (!parsed.ok) continue;
  const r = inst3.execute(parsed.command);
  stats = addStats(stats, r.statsDelta);
}
check('versions counted', stats.versions === 3, `${stats.versions}`);
check('updates counted', stats.updates === 2, `${stats.updates}`);
check('queries counted', stats.queries === 1, `${stats.queries}`);
check('allocation matches 2n-1 plus two paths', stats.nodesAllocated === 15 + 4 + 4,
  `${stats.nodesAllocated}`);
check('height is a level, not a running total', stats.height === 4, `${stats.height}`);
check('measured visits are recorded', stats.nodeVisits > 0, `${stats.nodeVisits} node visits`);

/* ── 6. What the console shows ─────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build [3 1 4 1 5 9 2 6]', 'update v0 3 10', 'query v1 2 5', 'query v0 2 5', 'compare v0 v1', 'query v9 0 1']) {
  const r = run(session, line);
  const out = r.error === null
    ? JSON.stringify(r.value)
    : `${r.error.code}: ${r.error.message}  (${r.error.hint ?? ''})`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
