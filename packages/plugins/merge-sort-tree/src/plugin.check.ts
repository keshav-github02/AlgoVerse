/**
 * Conformance, every answer against sorting a slice, and every answer again
 * against the wavelet tree - which answers the same questions and shares no
 * machinery with this at all.
 *
 *     node packages/plugins/merge-sort-tree/src/plugin.check.ts
 */

import {
  createRng, help, parseCommand,
  type NodeId, type OperationError, type StructureGraph,
} from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { waveletTree } from '@algoverse/plugin-wavelet-tree';
import { mergeSortTree as plugin } from './plugin.ts';

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

/* ── The definitions ───────────────────────────────────────────────── */

const kthOf = (v: readonly number[], lo: number, hi: number, k: number): number =>
  v.slice(lo, hi).sort((a, b) => a - b)[k - 1] as number;
const countOf = (v: readonly number[], lo: number, hi: number, x: number): number =>
  v.slice(lo, hi).filter((w) => w === x).length;
const atmostOf = (v: readonly number[], lo: number, hi: number, x: number): number =>
  v.slice(lo, hi).filter((w) => w <= x).length;

/* ── The wavelet tree, asked the same things ───────────────────────── */

/**
 * The other solution to this problem.
 *
 * The commands take the same arguments in the same order on purpose, so the
 * cross-check is a straight comparison of identical command strings rather than
 * a translation that could itself be wrong.
 */
class Wavelet {
  readonly inst: PluginInstance;

  constructor(values: readonly number[]) {
    this.inst = waveletTree.createInstance({ rng: createRng(3) });
    this.send(`build [${values.join(' ')}]`);
  }

  send(line: string): unknown {
    const parsed = parseCommand(line, waveletTree.commands);
    if (!parsed.ok) return null;
    const r = this.inst.execute(parsed.command);
    return r.ok ? r.value : null;
  }

  answer(line: string, key: string): unknown {
    const v = this.send(line) as Record<string, unknown> | null;
    return v === null ? null : v[key];
  }
}

/* ── Reading the runs off the picture ──────────────────────────────── */

/**
 * Whether every drawn node really holds its own positions, sorted.
 *
 * This is the claim the whole structure is: a node's list must be exactly the
 * values at the positions it covers, in order. A list that was merely sorted,
 * or merely the right length, would answer plausibly and wrongly.
 */
function runsProblem(g: StructureGraph, values: readonly number[]): string {
  const nodes = new Map<NodeId, { label: string; items: readonly number[]; depth: number }>();
  for (const n of g.nodes) {
    nodes.set(n.id, { label: n.label, items: n.values ?? [], depth: n.depth ?? 0 });
  }
  const kids = new Map<NodeId, NodeId[]>();
  const hasParent = new Set<NodeId>();
  for (const e of g.edges) {
    if (e.slot !== 'left' && e.slot !== 'right') return `unexpected slot "${e.slot}"`;
    if (hasParent.has(e.to)) return `node ${e.to} has two parents`;
    hasParent.add(e.to);
    kids.set(e.from, [...(kids.get(e.from) ?? []), e.to]);
  }

  const root = g.roots[0];
  if (root === undefined) return 'no root';

  /** `lo..hi` inclusive, or `lo` at a single position. */
  const spanOf = (label: string): [number, number] => {
    const parts = label.split('..');
    return parts.length === 1
      ? [Number(parts[0]), Number(parts[0])]
      : [Number(parts[0]), Number(parts[1])];
  };

  let seen = 0;
  const walk = (id: NodeId): string => {
    const node = nodes.get(id);
    if (node === undefined) return 'an edge points at nothing';
    seen += 1;
    const [lo, hi] = spanOf(node.label);
    const want = values.slice(lo, hi + 1).slice().sort((a, b) => a - b);
    if (node.items.join(' ') !== want.join(' ')) {
      return `positions ${node.label} hold [${node.items}], sorting them gives [${want}]`;
    }
    const children = kids.get(id) ?? [];
    if (lo === hi) {
      return children.length === 0 ? '' : `position ${lo} has children`;
    }
    if (children.length !== 2) return `positions ${node.label} has ${children.length} children`;
    // The two halves must cover the parent exactly, with no gap and no overlap.
    const spans = children.map((c) => spanOf(nodes.get(c)?.label ?? '')).sort((p, q) => p[0] - q[0]);
    const [first, second] = spans as [[number, number], [number, number]];
    if (first[0] !== lo || second[1] !== hi || first[1] + 1 !== second[0]) {
      return `positions ${node.label} split into ${JSON.stringify(spans)}`;
    }
    for (const c of children) {
      if ((nodes.get(c)?.depth ?? -1) !== node.depth + 1) {
        return `a child of ${node.label} is drawn at the wrong level`;
      }
      const deeper = walk(c);
      if (deeper !== '') return deeper;
    }
    return '';
  };

  const problem = walk(root);
  if (problem !== '') return problem;
  if (seen !== g.nodes.length) return `${seen} of ${g.nodes.length} nodes are in the tree`;
  return '';
}

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, [
  'build [3 1 4 1 5 9 2 6]', 'atmost 2 6 4', 'count 0 8 1', 'kth 2 6 2', 'runs',
])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. A worked example ───────────────────────────────────────────── */

console.log('\n3 1 4 1 5 9 2 6');

const values = [3, 1, 4, 1, 5, 9, 2, 6];
const inst = fresh();
const built = run(inst, `build [${values.join(' ')}]`);

check('the tree is a segment tree with a sorted run in every node', (() => {
  // Eight positions: 15 nodes, four levels, seven merges.
  return at(built, 'nodes') === 15 && at(built, 'depth') === 4 && at(built, 'merges') === 7;
})(), `15 nodes in 4 levels, ${String(at(built, 'merges'))} merges`);

check('every level holds the whole sequence, which is what it costs', (() => {
  const rows = at(run(inst, 'runs'), 'rows') as { holds: number }[];
  // Unlike the wavelet tree, nothing ever leaves: the leaves are positions, so
  // every level is a full copy and the space is n per level.
  return rows.length === 4 && rows.every((row) => row.holds === 8)
    && at(built, 'numbersHeld') === 32;
})(), 'four levels of eight, so 32 numbers for a sequence of 8');

check('the root run is the whole sequence sorted', (() => {
  const rows = at(run(inst, 'runs'), 'rows') as { runs: string[] }[];
  return rows[0]?.runs[0] === '0..7: 1 1 2 3 4 5 6 9';
})());

check('atmost agrees with filtering', (() => {
  for (const [lo, hi, x] of [[0, 8, 4], [2, 6, 4], [0, 8, 0], [0, 8, 9], [3, 4, 1]] as const) {
    if (at(run(inst, `atmost ${lo} ${hi} ${x}`), 'count') !== atmostOf(values, lo, hi, x)) {
      return false;
    }
  }
  return true;
})(), 'five ranges');

check('count finds a repeat only where it is', (() => {
  return at(run(inst, 'count 0 8 1'), 'count') === 2
    && at(run(inst, 'count 0 3 1'), 'count') === 1
    && at(run(inst, 'count 4 8 1'), 'count') === 0
    && at(run(inst, 'count 0 8 7'), 'count') === 0;
})(), '1 twice, and 7 never');

check('kth agrees with sorting the slice', (() => {
  for (let k = 1; k <= 4; k += 1) {
    if (at(run(inst, `kth 2 6 ${k}`), 'value') !== kthOf(values, 2, 6, k)) return false;
  }
  return true;
})(), 'positions 2 to 6 hold 4 1 5 9');

check('kth spends a counting query per round of a search for the value', (() => {
  /*
   * The cost this structure pays and the wavelet tree does not. Values run
   * 1..9, so the search needs about four rounds, and each round is a whole
   * O(log squared n) count.
   */
  const r = run(inst, 'kth 2 6 2');
  const one = run(inst, 'atmost 2 6 4');
  return (at(r, 'rounds') as number) >= 3
    && (at(r, 'steps') as number) > (at(one, 'steps') as number) * 2;
})(), (() => {
  const r = run(inst, 'kth 2 6 2');
  return `${String(at(r, 'rounds'))} rounds, ${String(at(r, 'steps'))} steps against `
    + `${String(at(run(inst, 'atmost 2 6 4'), 'steps'))} for one count`;
})());

check('a whole-sequence count still bisects rather than scanning', (() => {
  // The root covers everything, so exactly one node is consulted - and the
  // count inside it is a bisection of eight, not a walk of eight.
  const r = run(inst, 'atmost 0 8 4');
  return at(r, 'count') === 5 && (at(r, 'steps') as number) <= 1 + 4;
})(), 'one node, four comparisons, eight values');

/* ── 3. The picture is the runs ────────────────────────────────────── */

console.log('\nthe drawn tree against the runs it claims to hold');

check('every node holds its own positions, sorted',
  runsProblem(inst.getStructure(), values) === '',
  runsProblem(inst.getStructure(), values) || 'checked at every node');

check('a sequence of one is one node', (() => {
  const q = fresh();
  const r = run(q, 'build [5]');
  return at(r, 'nodes') === 1 && at(r, 'merges') === 0
    && at(run(q, 'kth 0 1 1'), 'value') === 5
    && runsProblem(q.getStructure(), [5]) === '';
})());

check('an odd length splits unevenly and still covers everything', (() => {
  const seq = [4, 2, 7, 1, 9];
  const q = fresh();
  run(q, `build [${seq.join(' ')}]`);
  return runsProblem(q.getStructure(), seq) === ''
    && at(run(q, 'kth 0 5 3'), 'value') === 4
    && at(run(q, 'atmost 1 4 7'), 'count') === 3;
})(), 'five positions, so one half has three and the other two');

check('negative values are no different', (() => {
  const seq = [-3, 2, -1, 0, -3, 4];
  const q = fresh();
  run(q, `build [${seq.join(' ')}]`);
  return at(run(q, 'kth 0 6 1'), 'value') === -3
    && at(run(q, 'kth 0 6 2'), 'value') === -3
    && at(run(q, 'atmost 0 6 0'), 'count') === 4
    && at(run(q, 'count 0 6 -3'), 'count') === 2
    && runsProblem(q.getStructure(), seq) === '';
})());

/* ── 4. Against the wavelet tree ───────────────────────────────────── */

console.log('\nagainst the wavelet tree');

check('the two structures agree on a worked example', (() => {
  const w = new Wavelet(values);
  for (const [lo, hi] of [[0, 8], [2, 6], [3, 4], [1, 7]] as const) {
    for (let k = 1; k <= hi - lo; k += 1) {
      if (at(run(inst, `kth ${lo} ${hi} ${k}`), 'value') !== w.answer(`kth ${lo} ${hi} ${k}`, 'value')) {
        return false;
      }
    }
    for (let x = 0; x <= 10; x += 1) {
      if (at(run(inst, `atmost ${lo} ${hi} ${x}`), 'count')
        !== w.answer(`atmost ${lo} ${hi} ${x}`, 'count')) return false;
      if (at(run(inst, `count ${lo} ${hi} ${x}`), 'count')
        !== w.answer(`count ${lo} ${hi} ${x}`, 'count')) return false;
    }
  }
  return true;
})(), 'four ranges, every rank and every value');

check('and the wavelet tree does it in fewer steps', (() => {
  /*
   * Not a correctness claim but the point of having both: the same question,
   * and one of them knows which values are present while the other only knows
   * their order.
   */
  const w = new Wavelet(values);
  const mine = at(run(inst, 'kth 0 8 4'), 'steps') as number;
  const theirs = w.answer('kth 0 8 4', 'steps') as number;
  return theirs < mine;
})(), (() => {
  const w = new Wavelet(values);
  return `${String(at(run(inst, 'kth 0 8 4'), 'steps'))} steps here, `
    + `${String(w.answer('kth 0 8 4', 'steps'))} in the wavelet tree`;
})());

/* ── 5. Refusing ───────────────────────────────────────────────────── */

console.log('\nerrors');

check('nothing can be asked before a build', (() => {
  const parsed = parseCommand('atmost 0 1 1', plugin.commands);
  if (!parsed.ok) return false;
  const r = fresh().execute(parsed.command);
  return !r.ok && r.error.code === 'PRECONDITION_FAILED';
})());
check('a range off the end is refused, and the shape is explained',
  (run(inst, 'atmost 0 9 1').error?.hint ?? '').includes('half-open'));
check('a backwards range is refused',
  run(inst, 'atmost 5 2 4').error?.code === 'BAD_ARGUMENT');
check('a rank past the end of the range is refused, with the limit', (() => {
  const r = run(inst, 'kth 2 6 5');
  return r.error?.code === 'BAD_ARGUMENT' && (r.error.hint ?? '').includes('1 to 4');
})());
check('an empty range cannot be ranked but can be counted', (() => {
  return run(inst, 'kth 3 3 1').error?.code === 'BAD_ARGUMENT'
    && at(run(inst, 'atmost 3 3 9'), 'count') === 0;
})());
check('a value too large for the search is refused, with the reason', (() => {
  const r = run(fresh(), 'build [1 99999999]');
  return r.error?.code === 'BAD_ARGUMENT' && (r.error.hint ?? '').includes('searches the range');
})());

/* ── 6. Property test ──────────────────────────────────────────────── */

console.log('\nproperty test vs sorting, and vs the wavelet tree');

const rng = createRng(20_260_905);
let trials = 0;
let queries = 0;
let firstFailure = '';

for (let t = 0; t < 50 && firstFailure === ''; t += 1) {
  const n = rng.nextInt(1, 14);
  const spread = rng.next() < 0.5 ? 4 : 40;
  const seq = Array.from({ length: n }, () => rng.nextInt(-spread, spread + 1));

  const q = fresh();
  const b = run(q, `build [${seq.join(' ')}]`);
  if (b.error !== null) { firstFailure = `build [${seq}]: ${b.error.message}`; break; }
  trials += 1;

  const problem = runsProblem(q.getStructure(), seq);
  if (problem !== '') { firstFailure = `[${seq}] ${problem}`; break; }

  const w = new Wavelet(seq);

  for (let s = 0; s < 6 && firstFailure === ''; s += 1) {
    const lo = rng.nextInt(0, n);
    const hi = rng.nextInt(lo + 1, n + 1);
    const x = rng.nextInt(-spread - 1, spread + 2);
    queries += 1;

    for (const [line, want] of [
      [`atmost ${lo} ${hi} ${x}`, atmostOf(seq, lo, hi, x)],
      [`count ${lo} ${hi} ${x}`, countOf(seq, lo, hi, x)],
    ] as const) {
      const got = at(run(q, line), 'count');
      if (got !== want) {
        firstFailure = `${line} of [${seq}] gave ${String(got)}, filtering gives ${want}`;
        break;
      }
      // And the same question of a structure split by value rather than position.
      const theirs = w.answer(line, 'count');
      if (theirs !== want) {
        firstFailure = `the wavelet tree says ${line} of [${seq}] is ${String(theirs)}, not ${want}`;
        break;
      }
    }
    if (firstFailure !== '') break;

    for (let k = 1; k <= hi - lo; k += 1) {
      const line = `kth ${lo} ${hi} ${k}`;
      const want = kthOf(seq, lo, hi, k);
      const got = at(run(q, line), 'value');
      if (got !== want) {
        firstFailure = `${line} of [${seq}] gave ${String(got)}, sorting gives ${want}`;
        break;
      }
      const theirs = w.answer(line, 'value');
      if (theirs !== want) {
        firstFailure = `the wavelet tree says ${line} of [${seq}] is ${String(theirs)}, not ${want}`;
        break;
      }
    }
  }
}

check('both structures match sorting the slice, on every range and every rank',
  firstFailure === '',
  firstFailure === '' ? `${trials} sequences, ${queries} ranges, two structures` : firstFailure);

/* ── 7. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build [3 1 4 1 5 9 2 6]', 'atmost 2 6 4', 'count 0 8 1', 'kth 2 6 2', 'runs']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
