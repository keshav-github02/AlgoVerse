/**
 * Merge sort tree.
 *
 * A segment tree over positions, where each node holds not a summary of its
 * block but the block itself, **sorted**. Building it is a merge sort that
 * keeps every intermediate result instead of throwing them away, which is where
 * the name comes from and is the whole idea: the work a merge sort does is
 * already a hierarchy of sorted runs, and hanging on to them turns a sort into
 * an index.
 *
 * A range of positions decomposes into O(log n) whole nodes, and inside each of
 * those a sorted list answers "how many are no larger than x" by bisection. So
 * counting costs a logarithm of nodes times a logarithm inside each -
 * **O(log² n)** - and that second logarithm is the price of not knowing, at a
 * node, anything about which values are there beyond their order.
 *
 * The wavelet tree next door answers the same questions and pays a single
 * logarithm, because splitting by value rather than by position means the
 * positions it needs are always one count away. This one is worth having beside
 * it for two reasons. It is the structure people reach for first, being a
 * segment tree with a bigger node; and the contrast is the clearest example in
 * the repo of a second logarithm coming from *where the information is kept*
 * rather than from how the algorithm is written. Every answer here is checked
 * against the wavelet tree, which shares nothing with it but the question.
 *
 * `kth` shows the same trade at its worst. Here it is a binary search over the
 * value range with a counting query inside it, so three logarithms; the wavelet
 * tree does it in one descent.
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
import { explainMergeSort } from './explain.ts';

const SCHEMA_VERSION = 1;

const MAX_VALUES = 1024;
const MAX_MAGNITUDE = 1_000_000;

interface Node {
  readonly id: NodeId;
  /** The positions this node covers, half-open. */
  readonly lo: number;
  readonly hi: number;
  /** Those positions' values, in order. */
  readonly sorted: readonly number[];
  readonly left: NodeId | null;
  readonly right: NodeId | null;
  readonly level: number;
}

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Merge sort a sequence, keeping every intermediate sorted run.',
    complexity: 'O(n log n)',
    params: [{ name: 'values', kind: 'int-list' }],
  },
  {
    name: 'atmost',
    summary: 'How many values in a half-open range of positions are no larger than a given one.',
    complexity: 'O(log² n)',
    params: [
      { name: 'lo', kind: 'int' },
      { name: 'hi', kind: 'int' },
      { name: 'value', kind: 'int' },
    ],
  },
  {
    name: 'count',
    summary: 'How many times one value occurs in a half-open range of positions.',
    complexity: 'O(log² n)',
    params: [
      { name: 'lo', kind: 'int' },
      { name: 'hi', kind: 'int' },
      { name: 'value', kind: 'int' },
    ],
  },
  {
    name: 'kth',
    summary: 'The kth smallest in a range, by searching for the value that has k below it.',
    complexity: 'O(log³ n)',
    params: [
      { name: 'lo', kind: 'int' },
      { name: 'hi', kind: 'int' },
      { name: 'k', kind: 'int' },
    ],
  },
  {
    name: 'runs',
    summary: 'Read the sorted runs out level by level, as a merge sort would have made them.',
    complexity: 'O(n log n)',
    params: [],
  },
];

function err(code: OperationError['code'], message: string, hint?: string): OperationError {
  return { code, message, ...(hint === undefined ? {} : { hint }) };
}

class Instance implements PluginInstance {
  #nodes = new Map<NodeId, Node>();
  #values: number[] = [];
  #next = 0;
  #root: NodeId | null = null;
  #merges = 0;

  reset(): void {
    this.#nodes = new Map();
    this.#values = [];
    this.#next = 0;
    this.#root = null;
    this.#merges = 0;
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getIntList(cmd, 'values'));
      case 'atmost':
        return this.#atmostCmd(getInt(cmd, 'lo'), getInt(cmd, 'hi'), getInt(cmd, 'value'));
      case 'count':
        return this.#countCmd(getInt(cmd, 'lo'), getInt(cmd, 'hi'), getInt(cmd, 'value'));
      case 'kth': return this.#kthCmd(getInt(cmd, 'lo'), getInt(cmd, 'hi'), getInt(cmd, 'k'));
      case 'runs': return this.#runs();
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

  #range(lo: number, hi: number): OperationError | null {
    const n = this.#values.length;
    if (lo < 0 || hi > n || lo > hi) {
      return err('BAD_ARGUMENT', `[${lo}, ${hi}) is not a range of a sequence of ${n}.`,
        `the range is half-open, so [0, ${n}) is all of it`);
    }
    return null;
  }

  /* ── Building ────────────────────────────────────────────────────── */

  /**
   * Two sorted runs into one, written out rather than delegated to a sort.
   *
   * The point of the structure is that this merge is the only work done, and
   * that its intermediate results are worth keeping - so it is worth seeing.
   */
  #merge(a: readonly number[], b: readonly number[]): number[] {
    const out: number[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      out.push((a[i] as number) <= (b[j] as number) ? (a[i++] as number) : (b[j++] as number));
    }
    while (i < a.length) out.push(a[i++] as number);
    while (j < b.length) out.push(b[j++] as number);
    this.#merges += 1;
    return out;
  }

  #make(lo: number, hi: number, level: number, events: SimEvent[]): NodeId {
    let left: NodeId | null = null;
    let right: NodeId | null = null;
    let sorted: number[];

    if (hi - lo === 1) {
      sorted = [this.#values[lo] as number];
    } else {
      const mid = (lo + hi) >> 1;
      left = this.#make(lo, mid, level + 1, events);
      right = this.#make(mid, hi, level + 1, events);
      sorted = this.#merge(this.#get(left).sorted, this.#get(right).sorted);
    }

    const id = this.#next as NodeId;
    this.#next += 1;
    this.#nodes.set(id, { id, lo, hi, sorted, left, right, level });
    events.push({
      kind: 'NodeAllocated',
      node: id,
      // How many positions this node covers. The sorted run itself is what the
      // node is for, and it is carried alongside.
      value: hi - lo,
      label: hi - lo === 1 ? `${lo}` : `${lo}..${hi - 1}`,
      values: [...sorted],
      role: hi - lo === 1 ? 'position' : (level === 0 ? 'root' : 'run'),
      depth: level,
      slot: `r${lo}_${hi}`,
      origin: 0,
    });
    for (const [slot, child] of [['left', left], ['right', right]] as const) {
      if (child === null) continue;
      events.push({ kind: 'PointerSet', from: id, slot, to: child, pointer: 'child' });
    }
    return id;
  }

  #build(values: readonly number[]): OperationResult {
    if (values.length === 0) {
      return failed(err('BAD_ARGUMENT', 'An empty sequence has nothing to sort.',
        'give at least one value'));
    }
    if (values.length > MAX_VALUES) {
      return failed(err('BAD_ARGUMENT', `${values.length} values is too many.`,
        `the limit is ${MAX_VALUES}`));
    }
    for (const v of values) {
      if (Math.abs(v) > MAX_MAGNITUDE) {
        return failed(err('BAD_ARGUMENT', `The value ${v} is too large.`,
          `values run to plus or minus ${MAX_MAGNITUDE}, because kth searches the range they span`));
      }
    }

    this.reset();
    this.#values = [...values];
    const events: SimEvent[] = [];
    this.#root = this.#make(0, values.length, 0, events);
    events.push({ kind: 'RootsSet', roots: [this.#root] });

    const depth = Math.max(...[...this.#nodes.values()].map((n) => n.level)) + 1;
    return {
      ok: true,
      value: {
        length: values.length,
        nodes: this.#nodes.size,
        depth,
        merges: this.#merges,
        // Every level holds the whole sequence, so the space is n per level.
        numbersHeld: [...this.#nodes.values()].reduce((sum, n) => sum + n.sorted.length, 0),
      },
      events,
      statsDelta: { nodesAllocated: this.#nodes.size, updates: 1 },
    };
  }

  /* ── Asking ──────────────────────────────────────────────────────── */

  /**
   * How many of a node's run are no larger than x, by bisection.
   *
   * Each comparison is logged as a visit to this node, because each one is the
   * node being consulted - and it is the only way the log can show the second
   * logarithm. Counting only the nodes entered would report this structure as
   * costing the same as the wavelet tree, which is exactly the thing the two
   * are here to distinguish.
   */
  #atMostIn(n: Node, x: number, events: SimEvent[]): number {
    let lo = 0;
    let hi = n.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      events.push({ kind: 'NodeVisited', node: n.id });
      if ((n.sorted[mid] as number) <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The decomposition: whole nodes are answered, partial ones are split. */
  #walk(
    id: NodeId, lo: number, hi: number, events: SimEvent[],
    answer: (n: Node) => number,
  ): number {
    const n = this.#get(id);
    if (n.hi <= lo || hi <= n.lo) return 0;
    events.push({ kind: 'NodeVisited', node: id });
    if (lo <= n.lo && n.hi <= hi) return answer(n);
    // A leaf is never partial: it covers one position, which is either in the
    // range or out of it.
    return this.#walk(n.left as NodeId, lo, hi, events, answer)
      + this.#walk(n.right as NodeId, lo, hi, events, answer);
  }

  #atmostCmd(lo: number, hi: number, value: number): OperationResult {
    const problem = this.#ready() ?? this.#range(lo, hi);
    if (problem !== null) return failed(problem);

    const events: SimEvent[] = [];
    const count = this.#walk(this.#root as NodeId, lo, hi, events,
      (n) => this.#atMostIn(n, value, events));

    return {
      ok: true,
      value: {
        range: `[${lo}, ${hi})`,
        atmost: value,
        count,
        // Nodes consulted, comparisons included: the log squared, measured.
        steps: events.length,
        of: hi - lo,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: events.length },
    };
  }

  #countCmd(lo: number, hi: number, value: number): OperationResult {
    const problem = this.#ready() ?? this.#range(lo, hi);
    if (problem !== null) return failed(problem);

    const events: SimEvent[] = [];
    // Two bisections per node rather than two traversals of the tree: the
    // number of things equal to x is where x ends minus where it begins.
    const count = this.#walk(this.#root as NodeId, lo, hi, events,
      (n) => this.#atMostIn(n, value, events) - this.#atMostIn(n, value - 1, events));

    return {
      ok: true,
      value: {
        range: `[${lo}, ${hi})`,
        of: value,
        count,
        steps: events.length,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: events.length },
    };
  }

  #kthCmd(lo: number, hi: number, k: number): OperationResult {
    const problem = this.#ready() ?? this.#range(lo, hi);
    if (problem !== null) return failed(problem);
    const width = hi - lo;
    if (k < 1 || k > width) {
      return failed(err('BAD_ARGUMENT', `There is no ${k}th smallest in ${width} values.`,
        width === 0
          ? 'the range is empty'
          : `k counts from 1, so it runs from 1 to ${width} here`));
    }

    /*
     * The smallest value x for which at least k of the range are no larger than
     * x. Binary search over the values, with a counting query inside - three
     * logarithms, where the wavelet tree spends one. Nothing here knows which
     * values are present, so the only way to find one is to ask about it.
     */
    const events: SimEvent[] = [];
    let a = Math.min(...this.#values);
    let b = Math.max(...this.#values);
    let rounds = 0;

    while (a < b) {
      const mid = Math.floor((a + b) / 2);
      rounds += 1;
      const below = this.#walk(this.#root as NodeId, lo, hi, events,
        (n) => this.#atMostIn(n, mid, events));
      if (below >= k) b = mid;
      else a = mid + 1;
    }

    return {
      ok: true,
      value: {
        range: `[${lo}, ${hi})`,
        k,
        value: a,
        // How many counting queries the search needed, each of them log squared.
        rounds,
        steps: events.length,
        of: width,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: events.length },
    };
  }

  #runs(): OperationResult {
    const byLevel = new Map<number, Node[]>();
    const problem = this.#ready();
    if (problem !== null) return failed(problem);

    for (const n of this.#nodes.values()) {
      const list = byLevel.get(n.level) ?? [];
      list.push(n);
      byLevel.set(n.level, list);
    }

    const rows = [...byLevel.entries()]
      .sort((p, q) => p[0] - q[0])
      .map(([level, list]) => ({
        level,
        // Every level is the whole sequence, cut into more runs.
        holds: list.reduce((sum, n) => sum + n.sorted.length, 0),
        runs: list
          .slice()
          .sort((p, q) => p.lo - q.lo)
          .map((n) => `${n.hi - n.lo === 1 ? n.lo : `${n.lo}..${n.hi - 1}`}: ${n.sorted.join(' ')}`),
      }));

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
        label: n.hi - n.lo === 1 ? `${n.lo}` : `${n.lo}..${n.hi - 1}`,
        value: n.hi - n.lo,
        values: [...n.sorted],
        role: n.hi - n.lo === 1 ? 'position' : (n.level === 0 ? 'root' : 'run'),
        depth: n.level,
        slot: `r${n.lo}_${n.hi}`,
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
      pluginId: 'merge-sort-tree',
      data: { values: [...this.#values] },
    };
  }
}

export const mergeSortTree: AlgorithmPlugin = {
  meta: {
    id: 'merge-sort-tree',
    name: 'Merge Sort Tree',
    category: 'Trees',
    summary: 'A segment tree whose nodes hold their block sorted, so a range count is a '
      + 'logarithm of bisections.',
  },
  commands: COMMANDS,
  explain: explainMergeSort,
  benchmark: {
    sizes: [16, 32, 64, 128, 256, 512],
    command: 'atmost',
    /** Values drawn from 1..n, matching the wavelet tree so the two compare. */
    setup: (n: number): readonly string[] => {
      let x = 20_260_904 % 2147483647;
      const values: number[] = [];
      for (let i = 0; i < n; i += 1) {
        x = (x * 48271) % 2147483647;
        values.push((x % n) + 1);
      }
      return [`build [${values.join(' ')}]`];
    },
    /**
     * Ranges that move around, so the decomposition is a different set of nodes
     * each time and no one bisection is repeated.
     */
    probes: (n: number): readonly string[] => {
      let x = 12345;
      const out: string[] = [];
      for (let i = 0; i < 2 * n; i += 1) {
        x = (x * 48271) % 2147483647;
        const lo = x % n;
        const hi = lo + 1 + ((x >> 8) % (n - lo));
        out.push(`atmost ${lo} ${hi} ${1 + ((x >> 16) % n)}`);
      }
      return out;
    },
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
