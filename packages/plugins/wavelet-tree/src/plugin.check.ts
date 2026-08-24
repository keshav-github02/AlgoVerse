/**
 * Conformance, every answer against sorting a slice, and the drawn tree against
 * the partition it claims to be.
 *
 *     node packages/plugins/wavelet-tree/src/plugin.check.ts
 */

import {
  createRng, help, parseCommand,
  type NodeId, type OperationError, type StructureGraph,
} from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { waveletTree as plugin } from './plugin.ts';

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

/* ── The definitions, applied literally ────────────────────────────── */

const slice = (values: readonly number[], lo: number, hi: number): number[] =>
  values.slice(lo, hi);

/** The kth smallest, by sorting. This is what kth *means*. */
const kthOf = (values: readonly number[], lo: number, hi: number, k: number): number =>
  slice(values, lo, hi).sort((a, b) => a - b)[k - 1] as number;

const countOf = (values: readonly number[], lo: number, hi: number, x: number): number =>
  slice(values, lo, hi).filter((v) => v === x).length;

const atmostOf = (values: readonly number[], lo: number, hi: number, x: number): number =>
  slice(values, lo, hi).filter((v) => v <= x).length;

/* ── Reading the tree off the picture ──────────────────────────────── */

/**
 * Whether the drawn tree really is the sequence split by value, stably.
 *
 * Each node publishes the subsequence that reached it. The claim being checked
 * is the one everything else rests on: a child's subsequence is exactly its
 * parent's elements that fall in the child's half of the value range, **in the
 * same relative order**. If the order were not kept, every answer here would
 * still be a plausible number and all of them would be wrong.
 */
function partitionProblem(g: StructureGraph, values: readonly number[]): string {
  const nodes = new Map<NodeId, { label: string; items: readonly number[]; depth: number }>();
  for (const n of g.nodes) {
    nodes.set(n.id, { label: n.label, items: n.values ?? [], depth: n.depth ?? 0 });
  }
  const kids = new Map<NodeId, { left?: NodeId; right?: NodeId }>();
  const hasParent = new Set<NodeId>();
  for (const e of g.edges) {
    if (e.slot !== 'left' && e.slot !== 'right') return `unexpected slot "${e.slot}"`;
    if (hasParent.has(e.to)) return `node ${e.to} has two parents`;
    hasParent.add(e.to);
    const entry = kids.get(e.from) ?? {};
    if (e.slot === 'left') entry.left = e.to;
    else entry.right = e.to;
    kids.set(e.from, entry);
  }

  const root = g.roots[0];
  if (root === undefined) return 'no root';
  const rootItems = nodes.get(root)?.items ?? [];
  if (rootItems.join(' ') !== values.join(' ')) {
    return `the root holds [${rootItems}], the sequence is [${values}]`;
  }

  /** `lo..hi`, or `lo` at a leaf. */
  const spanOf = (label: string): [number, number] => {
    const parts = label.split('..');
    return parts.length === 1
      ? [Number(parts[0]), Number(parts[0])]
      : [Number(parts[0]), Number(parts[1])];
  };

  let seen = 0;
  const walk = (id: NodeId): string => {
    const node = nodes.get(id);
    if (node === undefined) return `edge points at nothing`;
    seen += 1;
    const [lo, hi] = spanOf(node.label);
    for (const v of node.items) {
      if (v < lo || v > hi) return `values ${node.label} holds ${v}`;
    }
    if (lo === hi) {
      if (kids.get(id) !== undefined) return `the leaf ${node.label} has children`;
      if (node.items.some((v) => v !== lo)) return `the leaf ${node.label} holds something else`;
      return '';
    }

    const mid = Math.floor((lo + hi) / 2);
    const wantLeft = node.items.filter((v) => v <= mid);
    const wantRight = node.items.filter((v) => v > mid);
    const entry = kids.get(id) ?? {};

    for (const [side, want, child] of [
      ['left', wantLeft, entry.left], ['right', wantRight, entry.right],
    ] as const) {
      if (want.length === 0) {
        if (child !== undefined) return `${node.label} has a ${side} child with nothing in it`;
        continue;
      }
      if (child === undefined) return `${node.label} lost ${want.length} elements to the ${side}`;
      const got = nodes.get(child)?.items ?? [];
      if (got.join(' ') !== want.join(' ')) {
        return `${node.label}'s ${side} child holds [${got}], the stable split gives [${want}]`;
      }
      if ((nodes.get(child)?.depth ?? -1) !== node.depth + 1) {
        return `${node.label}'s ${side} child is drawn at the wrong level`;
      }
      const deeper = walk(child);
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
  'build [3 1 4 1 5 9 2 6]', 'kth 0 8 3', 'count 0 8 1', 'atmost 2 6 4', 'levels',
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

check('the range of values decides the depth', (() => {
  /*
   * Values run 1..9, and halving that range takes four steps to reach a single
   * value - 1..9, 1..5, 1..3, 1..2, 1..1 - so the tree is five levels deep.
   * Nine possible values, not eight elements: the length has nothing to do
   * with it.
   */
  return at(built, 'smallest') === 1 && at(built, 'largest') === 9
    && at(built, 'depth') === 5 && at(built, 'distinctValues') === 7;
})(), `1..9 in ${String(at(built, 'depth'))} levels`);

check('elements leave the tree at leaves and never appear', (() => {
  /*
   * The tempting claim is that every level holds the whole sequence, and it is
   * false here. A leaf stops: once an element reaches the leaf for its value it
   * is not written again further down, and leaves sit at different depths
   * because 1..9 does not halve evenly. So the honest invariants are that the
   * top holds everything, no level holds more than the one above it, and the
   * leaves between them hold everything exactly once.
   */
  const rows = at(run(inst, 'levels'), 'rows') as { level: number; holds: number }[];
  if (rows.length !== 5 || rows[0]?.holds !== 8) return false;
  for (let i = 1; i < rows.length; i += 1) {
    if ((rows[i]?.holds as number) > (rows[i - 1]?.holds as number)) return false;
  }
  const g = inst.getStructure();
  const hasChild = new Set(g.edges.map((e) => e.from));
  const inLeaves = g.nodes
    .filter((n) => !hasChild.has(n.id))
    .reduce((sum, n) => sum + (n.values?.length ?? 0), 0);
  return inLeaves === 8;
})(), (() => {
  const rows = at(run(inst, 'levels'), 'rows') as { holds: number }[];
  return `levels hold ${rows.map((r) => r.holds).join(', ')}; the leaves hold all eight`;
})());

check('a value range that halves evenly puts every leaf at one depth', (() => {
  // 0..7 is eight values, so every leaf sits at level 3 and every level does
  // then hold the whole sequence - which is the case the claim above is true in.
  const seq = [0, 7, 3, 4, 1, 6];
  const q = fresh();
  run(q, `build [${seq.join(' ')}]`);
  const rows = at(run(q, 'levels'), 'rows') as { holds: number }[];
  return rows.length === 4 && rows.every((row) => row.holds === 6)
    && partitionProblem(q.getStructure(), seq) === '';
})(), 'eight possible values, four levels, six elements in each');

check('the kth smallest of the whole sequence is right', (() => {
  for (let k = 1; k <= 8; k += 1) {
    if (at(run(inst, `kth 0 8 ${k}`), 'value') !== kthOf(values, 0, 8, k)) return false;
  }
  return true;
})(), 'all eight ranks, against sorting');

check('the kth smallest of a slice is right', (() => {
  // [4 1 5 9] sorted is 1 4 5 9.
  return at(run(inst, 'kth 2 6 1'), 'value') === 1
    && at(run(inst, 'kth 2 6 2'), 'value') === 4
    && at(run(inst, 'kth 2 6 4'), 'value') === 9;
})(), 'positions 2 to 6 hold 4 1 5 9');

check('a query costs one step per level, not one per element', (() => {
  // The third smallest is 2, and reaching its leaf is one step per level.
  const r = run(inst, 'kth 0 8 3');
  return at(r, 'value') === 2 && at(r, 'steps') === at(built, 'depth') && at(r, 'of') === 8;
})(), `${String(at(built, 'depth'))} steps to answer about eight elements`);

check('a repeated value is counted in the range asked about', (() => {
  return at(run(inst, 'count 0 8 1'), 'count') === 2
    && at(run(inst, 'count 0 3 1'), 'count') === 1
    && at(run(inst, 'count 4 8 1'), 'count') === 0;
})(), '1 twice overall, once before position 3, never after 4');

check('a value that is not there at all is distinguished from one that is', (() => {
  const absent = run(inst, 'count 0 8 7');
  const present = run(inst, 'count 0 2 9');
  // 7 is in no leaf; 9 has a leaf but not in positions 0 to 2.
  return at(absent, 'count') === 0 && at(absent, 'occursAnywhere') === false
    && at(present, 'count') === 0 && at(present, 'occursAnywhere') === true;
})(), '7 is absent; 9 is elsewhere');

check('atmost counts without descending both sides', (() => {
  for (const [lo, hi, x] of [[0, 8, 4], [2, 6, 4], [0, 8, 9], [0, 8, 0], [3, 4, 1]] as const) {
    const r = run(inst, `atmost ${lo} ${hi} ${x}`);
    if (at(r, 'count') !== atmostOf(values, lo, hi, x)) return false;
    // One branch per level at most - never both sides of anything.
    if ((at(r, 'steps') as number) > (at(built, 'depth') as number)) return false;
  }
  return true;
})(), `five ranges, never more than ${String(at(built, 'depth'))} steps`);

check('atmost and kth are two views of the same fact', (() => {
  /*
   * If the kth smallest is x, then at least k elements are no larger than x and
   * fewer than k are smaller than x. Neither command is derived from the other
   * here, so their agreeing is worth asserting.
   */
  for (let k = 1; k <= 4; k += 1) {
    const x = at(run(inst, `kth 2 6 ${k}`), 'value') as number;
    if ((at(run(inst, `atmost 2 6 ${x}`), 'count') as number) < k) return false;
    if ((at(run(inst, `atmost 2 6 ${x - 1}`), 'count') as number) >= k) return false;
  }
  return true;
})());

check('an empty range answers nothing rather than guessing', (() => {
  return at(run(inst, 'count 3 3 1'), 'count') === 0
    && at(run(inst, 'atmost 3 3 9'), 'count') === 0
    && run(inst, 'kth 3 3 1').error?.code === 'BAD_ARGUMENT';
})(), 'counting an empty range is 0; ranking it is a mistake');

/* ── 3. The picture is the partition ───────────────────────────────── */

console.log('\nthe drawn tree against the split it claims to be');

check('every child holds its parent\'s elements for that half, in order',
  partitionProblem(inst.getStructure(), values) === '',
  partitionProblem(inst.getStructure(), values) || 'stable at every node');

check('a sequence of one value is one leaf', (() => {
  const q = fresh();
  const r = run(q, 'build [5]');
  return at(r, 'nodes') === 1 && at(r, 'depth') === 1
    && at(run(q, 'kth 0 1 1'), 'value') === 5
    && partitionProblem(q.getStructure(), [5]) === '';
})());

check('all the same value is still one leaf', (() => {
  const q = fresh();
  const r = run(q, 'build [7 7 7 7]');
  return at(r, 'nodes') === 1 && at(run(q, 'count 1 3 7'), 'count') === 2
    && partitionProblem(q.getStructure(), [7, 7, 7, 7]) === '';
})(), 'nothing to split, so nothing is');

check('negative values work, because only the range matters', (() => {
  const seq = [-3, 2, -1, 0, -3, 4];
  const q = fresh();
  run(q, `build [${seq.join(' ')}]`);
  return at(run(q, 'kth 0 6 1'), 'value') === -3
    && at(run(q, 'kth 0 6 2'), 'value') === -3
    && at(run(q, 'atmost 0 6 0'), 'count') === 4
    && partitionProblem(q.getStructure(), seq) === '';
})(), '-3 twice, and four values at or below zero');

/* ── 4. Refusing ───────────────────────────────────────────────────── */

console.log('\nerrors');

check('nothing can be asked before a build', (() => {
  const parsed = parseCommand('kth 0 1 1', plugin.commands);
  if (!parsed.ok) return false;
  const r = fresh().execute(parsed.command);
  return !r.ok && r.error.code === 'PRECONDITION_FAILED';
})());
check('a range off the end is refused, and the shape is explained',
  (run(inst, 'kth 0 9 1').error?.hint ?? '').includes('half-open'));
check('a backwards range is refused',
  run(inst, 'atmost 5 2 4').error?.code === 'BAD_ARGUMENT');
check('a rank past the end of the range is refused, with the limit', (() => {
  const r = run(inst, 'kth 2 6 5');
  return r.error?.code === 'BAD_ARGUMENT' && (r.error.hint ?? '').includes('1 to 4');
})());
check('a rank of zero is refused, because k counts from one',
  run(inst, 'kth 0 8 0').error?.code === 'BAD_ARGUMENT');
check('a value too large to split is refused, with the reason', (() => {
  const r = run(fresh(), 'build [1 99999999]');
  return r.error?.code === 'BAD_ARGUMENT' && (r.error.hint ?? '').includes('logarithm of the range');
})());

/* ── 5. Property test ──────────────────────────────────────────────── */

console.log('\nproperty test vs sorting the slice');

const rng = createRng(20_260_904);
let trials = 0;
let queries = 0;
let deepest = 0;
let firstFailure = '';

for (let t = 0; t < 60 && firstFailure === ''; t += 1) {
  const n = rng.nextInt(1, 14);
  // A narrow value range some of the time, so repeats and one-sided splits are
  // common, and a wide one the rest, so the tree gets deep.
  const spread = rng.next() < 0.5 ? 4 : 40;
  const seq = Array.from({ length: n }, () => rng.nextInt(-spread, spread + 1));

  const q = fresh();
  const b = run(q, `build [${seq.join(' ')}]`);
  if (b.error !== null) { firstFailure = `build [${seq}]: ${b.error.message}`; break; }
  trials += 1;
  deepest = Math.max(deepest, at(b, 'depth') as number);

  const problem = partitionProblem(q.getStructure(), seq);
  if (problem !== '') { firstFailure = `[${seq}] ${problem}`; break; }

  for (let s = 0; s < 6 && firstFailure === ''; s += 1) {
    const lo = rng.nextInt(0, n);
    const hi = rng.nextInt(lo + 1, n + 1);
    const x = rng.nextInt(-spread - 1, spread + 2);
    queries += 1;

    const width = hi - lo;
    for (let k = 1; k <= width; k += 1) {
      const got = at(run(q, `kth ${lo} ${hi} ${k}`), 'value');
      const want = kthOf(seq, lo, hi, k);
      if (got !== want) {
        firstFailure = `kth ${lo} ${hi} ${k} of [${seq}] gave ${String(got)}, sorting gives ${want}`;
        break;
      }
    }
    if (firstFailure !== '') break;

    const c = run(q, `count ${lo} ${hi} ${x}`);
    if (at(c, 'count') !== countOf(seq, lo, hi, x)) {
      firstFailure = `count ${lo} ${hi} ${x} of [${seq}] gave ${at(c, 'count')}, `
        + `filtering gives ${countOf(seq, lo, hi, x)}`;
      break;
    }
    if (at(c, 'occursAnywhere') !== seq.includes(x)) {
      firstFailure = `count says ${x} occursAnywhere is ${at(c, 'occursAnywhere')} in [${seq}]`;
      break;
    }

    const a = run(q, `atmost ${lo} ${hi} ${x}`);
    if (at(a, 'count') !== atmostOf(seq, lo, hi, x)) {
      firstFailure = `atmost ${lo} ${hi} ${x} of [${seq}] gave ${at(a, 'count')}, `
        + `filtering gives ${atmostOf(seq, lo, hi, x)}`;
      break;
    }
    // The cost is the depth and nothing else - not the width of the range.
    if ((at(a, 'steps') as number) > (at(b, 'depth') as number)) {
      firstFailure = `atmost took ${at(a, 'steps')} steps in a tree ${at(b, 'depth')} deep`;
      break;
    }
  }
}

check('every answer matches the definition, and the picture stays the partition',
  firstFailure === '',
  firstFailure === ''
    ? `${trials} sequences, ${queries} ranges, deepest tree ${deepest} levels`
    : firstFailure);

/* ── 6. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build [3 1 4 1 5 9 2 6]', 'kth 2 6 2', 'count 0 8 1', 'atmost 2 6 4', 'levels']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
