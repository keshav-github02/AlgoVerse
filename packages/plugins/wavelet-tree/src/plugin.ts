/**
 * Wavelet tree.
 *
 * Every structure here so far splits a sequence by **position**: a segment tree
 * halves the indices, and each node holds a summary of a contiguous block. This
 * one halves the **values** instead. The root holds the whole sequence, its two
 * children hold the elements whose values fall in the lower and upper half of
 * the range, and so on down to a leaf per distinct value.
 *
 * The trick is that each split keeps the elements in their original relative
 * order. Because it does, a block of positions at a node maps to a block of
 * positions at each child, and the map is a counting question: of the first `k`
 * elements here, how many went left? So a range of positions can be carried
 * down the tree, narrowing to whichever half the answer lies in, and questions
 * that mix a range of positions with a range of values are answered in one
 * descent - the tree's depth, which is the logarithm of the value range and has
 * nothing to do with how long the range of positions is.
 *
 * That is what `kth` needs and what no segment tree can do. Asking for the
 * third smallest thing in positions 4 to 9 is not a question about any summary
 * of a contiguous block; it is a question about *which* values are there, and
 * the wavelet tree is a way of holding a sequence such that "which values" is
 * always one counting step away.
 *
 * The drawing is the textbook picture: each node shows the subsequence that
 * reached it, so the levels read as the same sequence stably partitioned finer
 * and finer. The bits usually drawn - one per element, saying which way it went
 * - are not stored separately here because they are exactly "is this value
 * above the midpoint", and having both the values and the bits on screen would
 * be showing the same fact twice.
 */

import {
  getInt, getIntList,
  type CommandSpec, type NodeId, type OperationError, type ParsedCommand, type SimEvent,
} from '@algoverse/core';
import {
  failed,
  type AlgorithmPlugin, type EngineContext, type OperationResult,
  type PluginInstance, type SerializedState,
  type StructureEdge, type StructureGraph, type StructureNode,
} from '@algoverse/plugin-sdk';
import { explainWavelet } from './explain.ts';

const SCHEMA_VERSION = 1;

const MAX_VALUES = 1024;
const MAX_MAGNITUDE = 1_000_000;

interface Node {
  readonly id: NodeId;
  /** The values this node is responsible for, inclusive. */
  readonly lo: number;
  readonly hi: number;
  /** The subsequence that reached here, in its original relative order. */
  readonly items: readonly number[];
  /**
   * `goLeft[k]` is how many of the first k items went to the left child.
   *
   * One more entry than there are items, so that a half-open block of
   * positions maps to a half-open block with no special cases at either end.
   */
  readonly goLeft: readonly number[];
  readonly left: NodeId | null;
  readonly right: NodeId | null;
  readonly level: number;
}

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Split a sequence by value, keeping the order, all the way down to single values.',
    complexity: 'O(n log n)',
    params: [{ name: 'values', kind: 'int-list' }],
  },
  {
    name: 'kth',
    summary: 'The kth smallest value in a half-open range of positions, counting from 1.',
    complexity: 'O(log n)',
    params: [
      { name: 'lo', kind: 'int' },
      { name: 'hi', kind: 'int' },
      { name: 'k', kind: 'int' },
    ],
  },
  {
    name: 'count',
    summary: 'How many times one value occurs in a half-open range of positions.',
    complexity: 'O(log n)',
    params: [
      { name: 'lo', kind: 'int' },
      { name: 'hi', kind: 'int' },
      { name: 'value', kind: 'int' },
    ],
  },
  {
    name: 'atmost',
    summary: 'How many values in a range of positions are no larger than a given one.',
    complexity: 'O(log n)',
    params: [
      { name: 'lo', kind: 'int' },
      { name: 'hi', kind: 'int' },
      { name: 'value', kind: 'int' },
    ],
  },
  {
    name: 'levels',
    summary: 'Read the tree out level by level, as the sequence split finer and finer.',
    complexity: 'O(n log n)',
    params: [],
  },
];

function err(code: OperationError['code'], message: string, hint?: string): OperationError {
  return { code, message, ...(hint === undefined ? {} : { hint }) };
}

const midOf = (lo: number, hi: number): number => Math.floor((lo + hi) / 2);

class Instance implements PluginInstance {
  #nodes = new Map<NodeId, Node>();
  #values: number[] = [];
  #next = 0;
  #root: NodeId | null = null;

  reset(): void {
    this.#nodes = new Map();
    this.#values = [];
    this.#next = 0;
    this.#root = null;
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getIntList(cmd, 'values'));
      case 'kth': return this.#kth(getInt(cmd, 'lo'), getInt(cmd, 'hi'), getInt(cmd, 'k'));
      case 'count': return this.#count(getInt(cmd, 'lo'), getInt(cmd, 'hi'), getInt(cmd, 'value'));
      case 'atmost':
        return this.#atmost(getInt(cmd, 'lo'), getInt(cmd, 'hi'), getInt(cmd, 'value'));
      case 'levels': return this.#levels();
      default:
        return failed(err('PARSE_ERROR', `This plugin does not handle "${cmd.name}".`));
    }
  }

  #ready(): OperationError | null {
    return this.#root === null
      ? err('PRECONDITION_FAILED', 'No sequence has been built yet.',
        'start with build, as in: build [3 1 4 1 5 9 2 6]')
      : null;
  }

  #get(id: NodeId): Node {
    const n = this.#nodes.get(id);
    if (n === undefined) throw new Error(`no node ${id}`);
    return n;
  }

  /** Half-open, so an empty range is `lo === hi` and needs no special case. */
  #range(lo: number, hi: number): OperationError | null {
    const n = this.#values.length;
    if (lo < 0 || hi > n || lo > hi) {
      return err('BAD_ARGUMENT', `[${lo}, ${hi}) is not a range of a sequence of ${n}.`,
        'the range is half-open, so [0, ' + String(n) + ') is all of it');
    }
    return null;
  }

  /* ── Building ────────────────────────────────────────────────────── */

  /**
   * One node per value range, built top-down.
   *
   * Nothing is allocated for a half that no element reached: an empty node
   * would be drawn, would be unreachable from any answer, and would make the
   * levels read as though the sequence had elements it does not have.
   */
  #split(lo: number, hi: number, items: readonly number[], level: number, events: SimEvent[]): NodeId {
    const mid = midOf(lo, hi);
    const leaf = lo === hi;

    const goLeft: number[] = [0];
    const leftItems: number[] = [];
    const rightItems: number[] = [];
    for (const v of items) {
      // The order elements are pushed in is the order they appear, which is
      // the whole reason a block of positions stays a block further down.
      if (!leaf && v <= mid) leftItems.push(v);
      else if (!leaf) rightItems.push(v);
      goLeft.push((goLeft[goLeft.length - 1] as number) + (!leaf && v <= mid ? 1 : 0));
    }

    const id = this.#next as NodeId;
    this.#next += 1;
    const left = leaf || leftItems.length === 0
      ? null
      : this.#split(lo, mid, leftItems, level + 1, events);
    const right = leaf || rightItems.length === 0
      ? null
      : this.#split(mid + 1, hi, rightItems, level + 1, events);

    this.#nodes.set(id, { id, lo, hi, items: [...items], goLeft, left, right, level });
    events.push({
      kind: 'NodeAllocated',
      node: id,
      // How many elements reached here. Every level adds up to the whole
      // sequence, which is the invariant the picture makes visible.
      value: items.length,
      label: leaf ? `${lo}` : `${lo}..${hi}`,
      values: [...items],
      role: leaf ? 'value' : (level === 0 ? 'root' : 'span'),
      depth: level,
      slot: `n${lo}_${hi}`,
      origin: 0,
    });
    if (left !== null) {
      events.push({ kind: 'PointerSet', from: id, slot: 'left', to: left, pointer: 'child' });
    }
    if (right !== null) {
      events.push({ kind: 'PointerSet', from: id, slot: 'right', to: right, pointer: 'child' });
    }
    return id;
  }

  #build(values: readonly number[]): OperationResult {
    if (values.length === 0) {
      return failed(err('BAD_ARGUMENT', 'An empty sequence has nothing to split.',
        'give at least one value'));
    }
    if (values.length > MAX_VALUES) {
      return failed(err('BAD_ARGUMENT', `${values.length} values is too many.`,
        `the limit is ${MAX_VALUES}`));
    }
    for (const v of values) {
      if (Math.abs(v) > MAX_MAGNITUDE) {
        return failed(err('BAD_ARGUMENT', `The value ${v} is too large.`,
          `values run to plus or minus ${MAX_MAGNITUDE}, because the depth of the tree is the `
          + 'logarithm of the range they span'));
      }
    }

    this.reset();
    this.#values = [...values];
    const events: SimEvent[] = [];
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    this.#root = this.#split(lo, hi, this.#values, 0, events);
    events.push({ kind: 'RootsSet', roots: [this.#root] });

    const depth = Math.max(...[...this.#nodes.values()].map((n) => n.level)) + 1;
    return {
      ok: true,
      value: {
        length: values.length,
        smallest: lo,
        largest: hi,
        nodes: this.#nodes.size,
        // The depth is the logarithm of the value range, not of the length.
        depth,
        distinctValues: new Set(values).size,
      },
      events,
      statsDelta: { nodesAllocated: this.#nodes.size, updates: 1 },
    };
  }

  /* ── Carrying a block of positions down ──────────────────────────── */

  /*
   * At a node, positions [a, b) of its subsequence become, at the left child,
   * [goLeft[a], goLeft[b]) - because goLeft counts how many of the first k
   * items went left, which is exactly where they land. At the right child they
   * become [a - goLeft[a], b - goLeft[b]), the same statement about the ones
   * that did not go left. Two subtractions, and the range never has to be
   * searched for.
   */

  #toLeft(n: Node, a: number, b: number): [number, number] {
    return [n.goLeft[a] as number, n.goLeft[b] as number];
  }

  #toRight(n: Node, a: number, b: number): [number, number] {
    return [a - (n.goLeft[a] as number), b - (n.goLeft[b] as number)];
  }

  #kth(lo: number, hi: number, k: number): OperationResult {
    const problem = this.#ready() ?? this.#range(lo, hi);
    if (problem !== null) return failed(problem);
    const width = hi - lo;
    if (k < 1 || k > width) {
      return failed(err('BAD_ARGUMENT', `There is no ${k}th smallest in ${width} values.`,
        width === 0
          ? 'the range is empty'
          : `k counts from 1, so it runs from 1 to ${width} here`));
    }

    const events: SimEvent[] = [];
    let cur = this.#root as NodeId;
    let a = lo;
    let b = hi;
    let want = k;
    let steps = 0;

    for (;;) {
      events.push({ kind: 'NodeVisited', node: cur });
      steps += 1;
      const n = this.#get(cur);
      if (n.lo === n.hi) break;

      const inLeft = (n.goLeft[b] as number) - (n.goLeft[a] as number);
      if (want <= inLeft) {
        // The answer is among the smaller half, and the block narrows to the
        // positions those elements landed at.
        [a, b] = this.#toLeft(n, a, b);
        cur = n.left as NodeId;
      } else {
        // Skip past every element that was smaller: they are all below the
        // answer, so the rank drops by exactly how many there were.
        want -= inLeft;
        [a, b] = this.#toRight(n, a, b);
        cur = n.right as NodeId;
      }
    }

    return {
      ok: true,
      value: {
        range: `[${lo}, ${hi})`,
        k,
        value: this.#get(cur).lo,
        // One step per level, whatever the range of positions was.
        steps,
        of: width,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: steps },
    };
  }

  #count(lo: number, hi: number, value: number): OperationResult {
    const problem = this.#ready() ?? this.#range(lo, hi);
    if (problem !== null) return failed(problem);

    const events: SimEvent[] = [];
    let cur: NodeId | null = this.#root;
    let a = lo;
    let b = hi;
    let steps = 0;

    while (cur !== null) {
      events.push({ kind: 'NodeVisited', node: cur });
      steps += 1;
      const n = this.#get(cur);
      if (value < n.lo || value > n.hi) { cur = null; break; }
      if (n.lo === n.hi) break;
      const mid = midOf(n.lo, n.hi);
      if (value <= mid) {
        [a, b] = this.#toLeft(n, a, b);
        cur = n.left;
      } else {
        [a, b] = this.#toRight(n, a, b);
        cur = n.right;
      }
    }

    // Falling off the tree means the value is in no leaf at all, so it does
    // not occur anywhere - not merely not in this range.
    const found = cur !== null;
    return {
      ok: true,
      value: {
        range: `[${lo}, ${hi})`,
        of: value,
        count: found ? b - a : 0,
        // Falling off means the value has no leaf, so it is absent from the
        // whole sequence rather than merely from this range - which is a more
        // useful thing to be told than a zero.
        occursAnywhere: found,
        steps,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: steps },
    };
  }

  #atmost(lo: number, hi: number, value: number): OperationResult {
    const problem = this.#ready() ?? this.#range(lo, hi);
    if (problem !== null) return failed(problem);

    const events: SimEvent[] = [];
    let cur: NodeId | null = this.#root;
    let a = lo;
    let b = hi;
    let total = 0;
    let steps = 0;

    /*
     * One branch per level, not two. Going right means every element that went
     * left is smaller than anything above the midpoint and so is already
     * counted; going left means nothing on the right can qualify. Either way
     * the other side is settled without being visited.
     */
    while (cur !== null) {
      events.push({ kind: 'NodeVisited', node: cur });
      steps += 1;
      const n = this.#get(cur);
      if (value < n.lo) break;
      if (value >= n.hi) { total += b - a; break; }
      const mid = midOf(n.lo, n.hi);
      const inLeft = (n.goLeft[b] as number) - (n.goLeft[a] as number);
      if (value <= mid) {
        [a, b] = this.#toLeft(n, a, b);
        cur = n.left;
      } else {
        total += inLeft;
        [a, b] = this.#toRight(n, a, b);
        cur = n.right;
      }
    }

    return {
      ok: true,
      value: {
        range: `[${lo}, ${hi})`,
        atmost: value,
        count: total,
        steps,
        of: hi - lo,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: steps },
    };
  }

  #levels(): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);

    const byLevel = new Map<number, Node[]>();
    for (const n of this.#nodes.values()) {
      const list = byLevel.get(n.level) ?? [];
      list.push(n);
      byLevel.set(n.level, list);
    }

    const rows = [...byLevel.entries()]
      .sort((p, q) => p[0] - q[0])
      .map(([level, list]) => {
        const ordered = list.slice().sort((p, q) => p.lo - q.lo);
        return {
          level,
          // Every level holds the whole sequence, cut in more places.
          holds: ordered.reduce((sum, n) => sum + n.items.length, 0),
          blocks: ordered.map((n) => `${n.lo === n.hi ? n.lo : `${n.lo}..${n.hi}`}: ${n.items.join(' ')}`),
        };
      });

    return {
      ok: true,
      value: { length: this.#values.length, levels: rows.length, rows },
      events: [...this.#nodes.values()].map((n): SimEvent => ({
        kind: 'NodeVisited', node: n.id,
      })),
      statsDelta: { queries: 1, nodeVisits: this.#nodes.size },
    };
  }

  /* ── Views ───────────────────────────────────────────────────────── */

  getStructure(): StructureGraph {
    const nodes: StructureNode[] = [];
    const edges: StructureEdge[] = [];

    for (const n of [...this.#nodes.values()].sort((a, b) => a.id - b.id)) {
      nodes.push({
        id: n.id,
        label: n.lo === n.hi ? `${n.lo}` : `${n.lo}..${n.hi}`,
        value: n.items.length,
        values: [...n.items],
        role: n.lo === n.hi ? 'value' : (n.level === 0 ? 'root' : 'span'),
        depth: n.level,
        slot: `n${n.lo}_${n.hi}`,
        origin: 0,
      });
      for (const [slot, child] of [['left', n.left], ['right', n.right]] as const) {
        if (child === null) continue;
        edges.push({ from: n.id, to: child, slot, reused: false, kind: 'child' });
      }
    }

    return {
      layout: 'dag', nodes, edges, roots: this.#root === null ? [] : [this.#root],
    };
  }

  serialize(): SerializedState {
    return {
      schemaVersion: SCHEMA_VERSION,
      pluginId: 'wavelet-tree',
      data: { values: [...this.#values] },
    };
  }
}

export const waveletTree: AlgorithmPlugin = {
  meta: {
    id: 'wavelet-tree',
    name: 'Wavelet Tree',
    category: 'Trees',
    summary: 'A sequence split by value rather than by position, so the kth smallest in any '
      + 'range is one descent.',
  },
  commands: COMMANDS,
  explain: explainWavelet,
  benchmark: {
    sizes: [16, 32, 64, 128, 256, 512],
    command: 'kth',
    /**
     * A sequence of n values drawn from 1..n, so the value range and the length
     * grow together. That matters for honesty: the cost of a query is the depth
     * of the tree, which is the logarithm of the **value range** and not of the
     * length - and declaring `O(log n)` is only true when the two coincide, as
     * they do here and in most real uses.
     */
    setup: (n: number): readonly string[] => {
      let x = 20_260_904 % 2147483647;
      const values: number[] = [];
      for (let i = 0; i < n; i += 1) {
        x = (x * 48271) % 2147483647;
        values.push((x % n) + 1);
      }
      return [`build [${values.join(' ')}]`];
    },
    /** Ranges and ranks that move around, so no one descent is repeated. */
    probes: (n: number): readonly string[] => {
      let x = 12345;
      const out: string[] = [];
      for (let i = 0; i < 2 * n; i += 1) {
        x = (x * 48271) % 2147483647;
        const lo = x % n;
        const hi = lo + 1 + ((x >> 8) % (n - lo));
        out.push(`kth ${lo} ${hi} ${1 + ((x >> 16) % (hi - lo))}`);
      }
      return out;
    },
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
