/**
 * Persistent range-update Fenwick tree.
 *
 * The plain Fenwick tree next door answers a range and writes one index. This
 * one writes a range and answers a prefix. **One Fenwick array cannot do both**
 * - that is the point of having two plugins rather than one command more.
 *
 * The trick is to store the array's *differences* rather than the array. A
 * range add of d over [l, r] is then two writes, +d at l and -d at r + 1, and
 * the running total of the differences up to i is the value at i. That gives
 * range updates against point reads immediately.
 *
 * Getting a range *sum* back out of it needs a second array. With
 * D[i] the difference written above,
 *
 *     sum of a[1..i] = i * (D[1] + ... + D[i]) - (E[1] + ... + E[i])
 *
 * where E carries d*(l-1) at l and -d*r at r + 1 - the correction for the fact
 * that a difference written at position l does not apply to the l-1 entries
 * before it. Two Fenwick trees, each holding one of those sums, and a prefix is
 * one multiplication apart from a pair of ordinary walks.
 *
 * What it gives up is `kth`. The other plugin descends the tree by taking the
 * widest block it can still afford, which works because each cell there holds
 * the sum of a block of the array. Here a cell holds part of a difference, and
 * a prefix is a combination of two of them - so there is no block to take, and
 * finding a position would mean a binary search over prefixes at O(log squared
 * n). It is not offered rather than offered slowly and quietly.
 */

import {
  diffRoots, getInt, getIntList, getVersion,
  type CommandSpec, type NodeId, type OperationError, type ParsedCommand, type SimEvent,
} from '@algoverse/core';
import {
  failed,
  type AlgorithmPlugin, type EngineContext, type OperationResult,
  type PluginInstance, type SerializedState,
  type StructureEdge, type StructureGraph, type StructureNode,
} from '@algoverse/plugin-sdk';
import { explainFenwickRange } from './explain.ts';

const SCHEMA_VERSION = 1;

const lowbit = (i: number): number => i & -i;

interface Cell {
  readonly id: NodeId;
  /** 1-based index into the Fenwick array. */
  readonly index: number;
  /** Which of the two arrays this cell belongs to: 0 for D, 1 for E. */
  readonly which: 0 | 1;
  readonly value: number;
  readonly origin: number;
}

/** Both arrays as one version sees them. */
interface Frame {
  readonly d: (NodeId | undefined)[];
  readonly e: (NodeId | undefined)[];
}

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Create version 0 from an array.',
    complexity: 'O(n)',
    params: [{ name: 'values', kind: 'int-list' }],
  },
  {
    name: 'apply',
    summary: 'Add a delta across an inclusive range, producing a new version.',
    complexity: 'O(log n)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'lo', kind: 'int' },
      { name: 'hi', kind: 'int' },
      { name: 'delta', kind: 'int' },
    ],
  },
  {
    name: 'add',
    summary: 'Add a delta at one index - a range of width one, and nothing special.',
    complexity: 'O(log n)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'index', kind: 'int' },
      { name: 'delta', kind: 'int' },
    ],
  },
  {
    name: 'prefix',
    summary: 'Sum the first k values, combining a walk of each array.',
    complexity: 'O(log n)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'k', kind: 'int' },
    ],
  },
  {
    name: 'range',
    summary: 'Sum an inclusive range, as the difference of two prefixes.',
    complexity: 'O(log n)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'lo', kind: 'int' },
      { name: 'hi', kind: 'int' },
    ],
  },
  {
    name: 'at',
    summary: 'Read one entry back, which the differences alone can answer.',
    complexity: 'O(log n)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'index', kind: 'int' },
    ],
  },
  {
    name: 'compare',
    summary: 'Report how much memory two versions share.',
    complexity: 'O(n)',
    params: [
      { name: 'a', kind: 'version' },
      { name: 'b', kind: 'version' },
    ],
  },
];

function err(code: OperationError['code'], message: string, hint?: string): OperationError {
  return { code, message, ...(hint === undefined ? {} : { hint }) };
}

class Instance implements PluginInstance {
  #cells = new Map<NodeId, Cell>();
  #frames: Frame[] = [];
  #size = 0;
  #next = 0;

  reset(): void {
    this.#cells = new Map();
    this.#frames = [];
    this.#size = 0;
    this.#next = 0;
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getIntList(cmd, 'values'));
      case 'apply':
        return this.#apply(getVersion(cmd, 'version'), getInt(cmd, 'lo'), getInt(cmd, 'hi'), getInt(cmd, 'delta'));
      case 'add': {
        const i = getInt(cmd, 'index');
        return this.#apply(getVersion(cmd, 'version'), i, i, getInt(cmd, 'delta'));
      }
      case 'prefix': return this.#prefix(getVersion(cmd, 'version'), getInt(cmd, 'k'));
      case 'range': return this.#range(getVersion(cmd, 'version'), getInt(cmd, 'lo'), getInt(cmd, 'hi'));
      case 'at': return this.#at(getVersion(cmd, 'version'), getInt(cmd, 'index'));
      case 'compare': return this.#compare(getVersion(cmd, 'a'), getVersion(cmd, 'b'));
      default:
        return failed(err('PARSE_ERROR', `This plugin does not handle "${cmd.name}".`));
    }
  }

  /* ── Shape ───────────────────────────────────────────────────────── */

  #available(): string {
    return this.#frames.length === 0
      ? 'nothing is built yet - start with build'
      : `versions available: ${this.#frames.map((_, i) => `v${i}`).join(', ')}`;
  }

  #childIndices(i: number): number[] {
    const out: number[] = [];
    for (let step = lowbit(i) >> 1; step >= 1; step >>= 1) out.push(i - step);
    return out;
  }

  #depthOf(index: number): number {
    return Math.floor(Math.log2(Math.max(1, this.#size))) - Math.floor(Math.log2(lowbit(index)));
  }

  #alloc(index: number, which: 0 | 1, value: number, origin: number, events: SimEvent[]): Cell {
    const id = this.#next as NodeId;
    this.#next += 1;
    const cell: Cell = { id, index, which, value, origin };
    this.#cells.set(id, cell);
    events.push({
      kind: 'NodeAllocated',
      node: id,
      value,
      label: `${which === 0 ? 'd' : 'e'} ${index - lowbit(index) + 1}..${index}`,
      role: which === 0 ? 'difference' : 'correction',
      depth: this.#depthOf(index),
      slot: `${which}:${index}`,
      origin,
      // The two arrays are the structure; colouring by which one a cell is in
      // is the difference between one picture and two side by side.
      group: which,
    });
    return cell;
  }

  #link(parent: Cell, table: readonly (NodeId | undefined)[], events: SimEvent[]): void {
    for (const child of this.#childIndices(parent.index)) {
      const id = table[child];
      if (id === undefined) continue;
      // The same name the drawing gives it, or the log describes a different picture.
      events.push({ kind: 'PointerSet', from: parent.id, slot: `c${parent.which}:${child}`, to: id });
      const kid = this.#cells.get(id) as Cell;
      if (kid.origin < parent.origin) {
        events.push({ kind: 'NodeReused', node: id, by: parent.id });
      }
    }
  }

  /** Fenwick cells for a raw array, filled in index order. */
  #forest(raw: readonly number[], which: 0 | 1, events: SimEvent[]): (NodeId | undefined)[] {
    const table: (NodeId | undefined)[] = new Array<NodeId | undefined>(this.#size + 1);
    const sums = new Array<number>(this.#size + 1).fill(0);
    for (let i = 1; i <= this.#size; i += 1) {
      let total = raw[i] as number;
      for (const child of this.#childIndices(i)) total += sums[child] as number;
      sums[i] = total;
      const cell = this.#alloc(i, which, total, 0, events);
      table[i] = cell.id;
      this.#link(cell, table, events);
    }
    return table;
  }

  #walk(table: readonly (NodeId | undefined)[], k: number): { sum: number; visited: NodeId[] } {
    let sum = 0;
    const visited: NodeId[] = [];
    for (let i = k; i > 0; i -= lowbit(i)) {
      const id = table[i];
      if (id === undefined) continue;
      visited.push(id);
      sum += (this.#cells.get(id) as Cell).value;
    }
    return { sum, visited };
  }

  /**
   * The prefix, as the two arrays together.
   *
   * `i * D(i)` would be the total if every difference applied from position 1;
   * `E(i)` takes back the part of each that starts later than that.
   */
  #prefixOf(frame: Frame, k: number): { sum: number; visited: NodeId[] } {
    if (k <= 0) return { sum: 0, visited: [] };
    const d = this.#walk(frame.d, k);
    const e = this.#walk(frame.e, k);
    return { sum: d.sum * k - e.sum, visited: [...d.visited, ...e.visited] };
  }

  #frameAt(v: number): Frame | OperationError {
    const frame = this.#frames[v];
    if (frame === undefined) {
      return err('UNKNOWN_VERSION', `Version v${v} does not exist.`, this.#available());
    }
    return frame;
  }

  #commit(frame: Frame, version: number, events: SimEvent[]): void {
    this.#frames.push(frame);
    const roots = this.#rootsOf(frame);
    events.push({ kind: 'VersionCommitted', version, roots });
    events.push({ kind: 'RootsSet', roots: this.#allRoots() });
  }

  /** A Fenwick forest has one root per set bit of n, and there are two of them. */
  #rootsOf(frame: Frame): NodeId[] {
    const roots: NodeId[] = [];
    for (const table of [frame.d, frame.e]) {
      for (let i = this.#size; i > 0; i -= lowbit(i)) {
        const id = table[i];
        if (id !== undefined) roots.push(id);
      }
    }
    return roots;
  }

  #allRoots(): NodeId[] {
    const seen = new Set<NodeId>();
    const roots: NodeId[] = [];
    for (const frame of this.#frames) {
      for (const id of this.#rootsOf(frame)) {
        if (seen.has(id)) continue;
        seen.add(id);
        roots.push(id);
      }
    }
    return roots;
  }

  /* ── Commands ────────────────────────────────────────────────────── */

  #build(values: readonly number[]): OperationResult {
    if (values.length === 0) {
      return failed(err('BAD_ARGUMENT', 'An empty array has nothing to index.',
        'try build [1 2 3 4]'));
    }
    this.reset();
    this.#size = values.length;
    const events: SimEvent[] = [];

    /*
     * Building from an array is the same as applying [i, i] with a[i] for
     * every i, which lands as the differences and their corrections. Writing
     * them out directly costs one pass rather than n range updates.
     */
    const d = new Array<number>(this.#size + 1).fill(0);
    const e = new Array<number>(this.#size + 1).fill(0);
    for (let i = 1; i <= this.#size; i += 1) {
      d[i] = (values[i - 1] as number) - (i === 1 ? 0 : (values[i - 2] as number));
      e[i] = (i - 1) * (d[i] as number);
    }

    const frame: Frame = { d: this.#forest(d, 0, events), e: this.#forest(e, 1, events) };
    this.#commit(frame, 0, events);

    return {
      ok: true,
      value: {
        version: 0, size: this.#size,
        total: this.#prefixOf(frame, this.#size).sum,
        cells: this.#cells.size,
      },
      events,
      statsDelta: {
        versions: 1,
        nodesAllocated: this.#cells.size,
        height: Math.floor(Math.log2(Math.max(1, this.#size))) + 1,
      },
    };
  }

  #apply(v: number, lo: number, hi: number, delta: number): OperationResult {
    const frame = this.#frameAt(v);
    if (!('d' in frame)) return failed(frame);
    if (lo < 1 || hi > this.#size || lo > hi) {
      return failed(err('INVALID_RANGE',
        `Range ${lo}..${hi} is not inside 1..${this.#size}.`,
        'both ends are included, and this structure is 1-indexed'));
    }

    const events: SimEvent[] = [];
    const version = this.#frames.length;
    const d = [...frame.d];
    const e = [...frame.e];
    let allocated = 0;

    /*
     * Four writes for any range, however wide. A difference of +delta starts
     * at lo and is taken back after hi; the corrections say where each of
     * those two starts, so that a prefix can undo the part that came before.
     *
     * The write at hi + 1 falls off the end when hi is the last index, and is
     * simply skipped: nothing is ever asked about a prefix beyond n.
     */
    const writes: [(NodeId | undefined)[], 0 | 1, [number, number][]][] = [
      [d, 0, [[lo, delta], [hi + 1, -delta]]],
      [e, 1, [[lo, delta * (lo - 1)], [hi + 1, -delta * hi]]],
    ];

    for (const [table, which, starts] of writes) {
      /*
       * The two writes into one array share a parent chain wherever their
       * indices meet, so the chains are merged before anything is allocated.
       * Walking them one after the other would copy a shared cell twice and
       * strand the first copy - allocated, pointed at by nothing, and part of
       * no version.
       *
       * An index whose two deltas cancel is still copied. Its value is the
       * same, but its children are not, and one cell cannot hold the pointers
       * of two different versions at once.
       */
      const net = new Map<number, number>();
      for (const [start, amount] of starts) {
        if (start > this.#size || amount === 0) continue;
        for (let i = start; i <= this.#size; i += lowbit(i)) {
          net.set(i, (net.get(i) ?? 0) + amount);
        }
      }

      const touched = [...net.keys()].sort((a, b) => a - b);
      for (const i of touched) {
        const old = this.#cells.get(table[i] as NodeId) as Cell;
        events.push({ kind: 'NodeVisited', node: old.id });
        const cell = this.#alloc(i, which, old.value + (net.get(i) as number), version, events);
        table[i] = cell.id;
        allocated += 1;
      }
      // Linked after the whole set exists, so a copy points at its copied child.
      for (const i of touched) {
        this.#link(this.#cells.get(table[i] as NodeId) as Cell, table, events);
      }
    }

    const next: Frame = { d, e };
    this.#commit(next, version, events);

    return {
      ok: true,
      value: {
        version, lo, hi, delta,
        allocated,
        // The whole reason for the second array: the cost is the same for a
        // range of one and a range of everything.
        width: hi - lo + 1,
        total: this.#prefixOf(next, this.#size).sum,
      },
      events,
      statsDelta: { versions: 1, updates: 1, nodesAllocated: allocated },
    };
  }

  #prefix(v: number, k: number): OperationResult {
    const frame = this.#frameAt(v);
    if (!('d' in frame)) return failed(frame);
    if (k < 0 || k > this.#size) {
      return failed(err('INDEX_OUT_OF_RANGE', `Prefix ${k} is outside 0..${this.#size}.`,
        `this structure holds ${this.#size} values`));
    }

    const { sum, visited } = this.#prefixOf(frame, k);
    return {
      ok: true,
      value: { sum, visits: visited.length },
      events: visited.map((id): SimEvent => ({ kind: 'NodeVisited', node: id })),
      statsDelta: { queries: 1, nodeVisits: visited.length },
    };
  }

  #range(v: number, lo: number, hi: number): OperationResult {
    const frame = this.#frameAt(v);
    if (!('d' in frame)) return failed(frame);
    if (lo < 1 || hi > this.#size || lo > hi) {
      return failed(err('INVALID_RANGE',
        `Range ${lo}..${hi} is not inside 1..${this.#size}.`,
        'both ends are included, and this structure is 1-indexed'));
    }

    const upper = this.#prefixOf(frame, hi);
    const lower = this.#prefixOf(frame, lo - 1);
    const visited = [...upper.visited, ...lower.visited];
    return {
      ok: true,
      value: { sum: upper.sum - lower.sum, visits: visited.length },
      events: visited.map((id): SimEvent => ({ kind: 'NodeVisited', node: id })),
      statsDelta: { queries: 1, nodeVisits: visited.length },
    };
  }

  #at(v: number, index: number): OperationResult {
    const frame = this.#frameAt(v);
    if (!('d' in frame)) return failed(frame);
    if (index < 1 || index > this.#size) {
      return failed(err('INDEX_OUT_OF_RANGE', `Index ${index} is outside 1..${this.#size}.`,
        'this structure is 1-indexed, like a textbook Fenwick tree'));
    }

    /*
     * One entry needs only the differences: the running total of them up to
     * this index is the value here. The corrections exist for sums, not reads.
     */
    const { sum, visited } = this.#walk(frame.d, index);
    return {
      ok: true,
      value: { index, entry: sum, visits: visited.length },
      events: visited.map((id): SimEvent => ({ kind: 'NodeVisited', node: id })),
      statsDelta: { queries: 1, nodeVisits: visited.length },
    };
  }

  #compare(a: number, b: number): OperationResult {
    const fa = this.#frameAt(a);
    if (!('d' in fa)) return failed(fa);
    const fb = this.#frameAt(b);
    if (!('d' in fb)) return failed(fb);

    const diff = diffRoots(this.getStructure(), this.#rootsOf(fa), this.#rootsOf(fb));
    return {
      ok: true,
      value: {
        shared: diff.shared.length,
        onlyInA: diff.onlyA.length,
        onlyInB: diff.onlyB.length,
        sharedPercent: Math.round(diff.sharedRatio * 100),
      },
      events: diff.shared.map((id): SimEvent => ({ kind: 'NodeVisited', node: id })),
      statsDelta: { queries: 1, nodeVisits: diff.shared.length },
    };
  }

  /* ── Views ───────────────────────────────────────────────────────── */

  getStructure(): StructureGraph {
    const nodes: StructureNode[] = [];
    const edges: StructureEdge[] = [];

    for (const cell of this.#cells.values()) {
      nodes.push({
        id: cell.id,
        label: `${cell.which === 0 ? 'd' : 'e'} ${cell.index - lowbit(cell.index) + 1}..${cell.index}`,
        value: cell.value,
        role: cell.which === 0 ? 'difference' : 'correction',
        depth: this.#depthOf(cell.index),
        slot: `${cell.which}:${cell.index}`,
        origin: cell.origin,
        order: cell.which * (this.#size + 1) + cell.index,
        group: cell.which,
      });
    }

    for (const frame of this.#frames) {
      for (const [which, table] of [[0, frame.d], [1, frame.e]] as const) {
        for (let i = 1; i <= this.#size; i += 1) {
          const parentId = table[i];
          if (parentId === undefined) continue;
          const parent = this.#cells.get(parentId) as Cell;
          for (const child of this.#childIndices(i)) {
            const childId = table[child];
            if (childId === undefined) continue;
            if (edges.some((e) => e.from === parentId && e.to === childId)) continue;
            const kid = this.#cells.get(childId) as Cell;
            edges.push({
              from: parentId,
              to: childId,
              slot: `c${which}:${child}`,
              reused: kid.origin < parent.origin,
            });
          }
        }
      }
    }

    return { layout: 'dag', nodes, edges, roots: this.#allRoots() };
  }

  serialize(): SerializedState {
    return {
      schemaVersion: SCHEMA_VERSION,
      pluginId: 'fenwick-range',
      data: {
        size: this.#size,
        versions: this.#frames.map((frame) =>
          Array.from({ length: this.#size }, (_, i) => this.#prefixOf(frame, i + 1).sum
            - this.#prefixOf(frame, i).sum)),
      },
    };
  }
}

export const fenwickRange: AlgorithmPlugin = {
  meta: {
    id: 'fenwick-range',
    name: 'Range-Update Fenwick',
    category: 'Persistent structures',
    summary: 'Two Fenwick trees over the differences, so a range of any width costs four writes.',
  },
  commands: COMMANDS,
  explain: explainFenwickRange,
  benchmark: {
    sizes: [8, 16, 32, 64, 128, 256],
    command: 'prefix',
    setup: (n: number): readonly string[] =>
      [`build [${Array.from({ length: n }, (_, i) => (i % 9) + 1).join(' ')}]`],
    // The longest walk a prefix can take is the one with every bit set.
    probes: (n: number): readonly string[] => [`prefix v0 ${n - 1}`],
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
