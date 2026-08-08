/**
 * Persistent binary indexed tree (Fenwick tree).
 *
 * Cell i stores the sum of `a[i - lowbit(i) + 1 .. i]`. Reading a prefix walks
 * down by clearing the low bit; writing walks up by adding it. The upward walk
 * is the parent chain, so an update copies one path and reuses everything else
 * — the same persistence trick as the segment tree, over a different shape.
 *
 * Two things here that the segment tree never needed: the forest has several
 * roots unless n is a power of two, and cells must be drawn in index order
 * rather than traversal order.
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
import { explainBit } from './explain.ts';

const SCHEMA_VERSION = 1;

const lowbit = (i: number): number => i & -i;

interface Cell {
  readonly id: NodeId;
  /** 1-based index into the Fenwick array. */
  readonly index: number;
  readonly value: number;
  readonly origin: number;
}

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Create version 0 from an array.',
    complexity: 'O(n)',
    params: [{ name: 'values', kind: 'int-list' }],
  },
  {
    name: 'add',
    summary: 'Add a delta at one index, producing a new version.',
    complexity: 'O(log n)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'index', kind: 'int' },
      { name: 'delta', kind: 'int' },
    ],
  },
  {
    name: 'prefix',
    summary: 'Sum the first k values in a version.',
    complexity: 'O(log n)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'k', kind: 'int' },
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
  /** One array per version: index -> the cell that version sees. */
  #versions: (NodeId | undefined)[][] = [];
  #size = 0;
  #next = 0;

  reset(): void {
    this.#cells = new Map();
    this.#versions = [];
    this.#size = 0;
    this.#next = 0;
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getIntList(cmd, 'values'));
      case 'add': return this.#add(getVersion(cmd, 'version'), getInt(cmd, 'index'), getInt(cmd, 'delta'));
      case 'prefix': return this.#prefix(getVersion(cmd, 'version'), getInt(cmd, 'k'));
      case 'compare': return this.#compare(getVersion(cmd, 'a'), getVersion(cmd, 'b'));
      default:
        return failed(err('PARSE_ERROR', `This plugin does not handle "${cmd.name}".`));
    }
  }

  /* ── Helpers ─────────────────────────────────────────────────────── */

  #available(): string {
    return this.#versions.length === 0
      ? 'nothing is built yet — start with build'
      : `versions available: ${this.#versions.map((_, i) => `v${i}`).join(', ')}`;
  }

  /** Cells with no parent inside the array: the forest roots. */
  #rootIndices(): number[] {
    const out: number[] = [];
    for (let i = 1; i <= this.#size; i += 1) if (i + lowbit(i) > this.#size) out.push(i);
    return out;
  }

  /** Depth grows with lowbit, so wider cells sit higher. */
  #depthOf(index: number): number {
    const widest = Math.max(...this.#rootIndices().map((i) => lowbit(i)), 1);
    return Math.log2(widest) - Math.log2(lowbit(index));
  }

  #alloc(index: number, value: number, origin: number, events: SimEvent[]): Cell {
    const id = this.#next as NodeId;
    this.#next += 1;
    const cell: Cell = { id, index, value, origin };
    this.#cells.set(id, cell);
    events.push({
      kind: 'NodeAllocated',
      node: id,
      value,
      label: `${index - lowbit(index) + 1}..${index}`,
      role: lowbit(index) === 1 ? 'leaf' : 'internal',
      depth: this.#depthOf(index),
      // One slot per index: versions of the same cell align and fan apart.
      slot: `i${index}`,
      origin,
    });
    return cell;
  }

  /** Children of cell i are the cells j < i with j + lowbit(j) === i. */
  #childIndices(i: number): number[] {
    const out: number[] = [];
    for (let step = lowbit(i) >> 1; step >= 1; step >>= 1) out.push(i - step);
    return out;
  }

  #link(parent: Cell, table: (NodeId | undefined)[], events: SimEvent[]): void {
    for (const child of this.#childIndices(parent.index)) {
      const id = table[child];
      if (id === undefined) continue;
      events.push({ kind: 'PointerSet', from: parent.id, slot: `c${child}`, to: id });
      const kid = this.#cells.get(id) as Cell;
      if (kid.origin < parent.origin) {
        events.push({ kind: 'NodeReused', node: id, by: parent.id });
      }
    }
  }

  #commit(table: (NodeId | undefined)[], version: number, events: SimEvent[]): void {
    this.#versions.push(table);
    const roots = this.#rootIndices()
      .map((i) => table[i])
      .filter((id): id is NodeId => id !== undefined);
    events.push({ kind: 'VersionCommitted', version, roots });
    events.push({ kind: 'RootsSet', roots: this.#allRoots() });
  }

  /** Every version's entry points, so the canvas shows the whole history. */
  #allRoots(): NodeId[] {
    const out: NodeId[] = [];
    for (const table of this.#versions) {
      for (const i of this.#rootIndices()) {
        const id = table[i];
        if (id !== undefined) out.push(id);
      }
    }
    return out;
  }

  /* ── Commands ────────────────────────────────────────────────────── */

  #build(values: readonly number[]): OperationResult {
    this.reset();
    this.#size = values.length;
    const events: SimEvent[] = [];
    const table: (NodeId | undefined)[] = new Array<NodeId | undefined>(this.#size + 1);

    // Cells are filled in index order so each is built from children already made.
    const sums = new Array<number>(this.#size + 1).fill(0);
    for (let i = 1; i <= this.#size; i += 1) {
      let total = values[i - 1] as number;
      for (const child of this.#childIndices(i)) total += sums[child] as number;
      sums[i] = total;
      const cell = this.#alloc(i, total, 0, events);
      table[i] = cell.id;
      this.#link(cell, table, events);
    }

    this.#commit(table, 0, events);
    return {
      ok: true,
      value: { version: 0, size: this.#size, total: this.#prefixOf(table, this.#size).sum },
      events,
      statsDelta: {
        versions: 1,
        nodesAllocated: this.#size,
        height: Math.floor(Math.log2(Math.max(1, this.#size))) + 1,
      },
    };
  }

  #add(v: number, index: number, delta: number): OperationResult {
    const previous = this.#versions[v];
    if (previous === undefined) {
      return failed(err('UNKNOWN_VERSION', `Version v${v} does not exist.`, this.#available()));
    }
    if (index < 1 || index > this.#size) {
      return failed(err('INDEX_OUT_OF_RANGE',
        `Index ${index} is outside 1..${this.#size}.`,
        'this structure is 1-indexed, like a textbook Fenwick tree'));
    }

    const events: SimEvent[] = [];
    const version = this.#versions.length;
    const table = [...previous];
    let allocated = 0;

    // Walk up the parent chain, copying each cell the write passes through.
    for (let i = index; i <= this.#size; i += lowbit(i)) {
      const old = this.#cells.get(previous[i] as NodeId) as Cell;
      events.push({ kind: 'NodeVisited', node: old.id });
      const cell = this.#alloc(i, old.value + delta, version, events);
      table[i] = cell.id;
      allocated += 1;
    }
    // Link after the whole chain exists, so a copied parent points at its
    // copied child rather than the version it replaced.
    for (let i = index; i <= this.#size; i += lowbit(i)) {
      this.#link(this.#cells.get(table[i] as NodeId) as Cell, table, events);
    }

    this.#commit(table, version, events);
    return {
      ok: true,
      value: { version, allocated, reused: this.#size - allocated },
      events,
      statsDelta: {
        versions: 1,
        updates: 1,
        nodesAllocated: allocated,
        nodesReused: this.#size - allocated,
      },
    };
  }

  #prefixOf(table: readonly (NodeId | undefined)[], k: number): { sum: number; visited: NodeId[] } {
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

  #prefix(v: number, k: number): OperationResult {
    const table = this.#versions[v];
    if (table === undefined) {
      return failed(err('UNKNOWN_VERSION', `Version v${v} does not exist.`, this.#available()));
    }
    if (k < 0 || k > this.#size) {
      return failed(err('INDEX_OUT_OF_RANGE', `Prefix ${k} is outside 0..${this.#size}.`,
        `this structure holds ${this.#size} values`));
    }

    const { sum, visited } = this.#prefixOf(table, k);
    return {
      ok: true,
      value: { sum, visits: visited.length },
      events: visited.map((id): SimEvent => ({ kind: 'NodeVisited', node: id })),
      statsDelta: { queries: 1, nodeVisits: visited.length },
    };
  }

  #compare(a: number, b: number): OperationResult {
    const ta = this.#versions[a];
    const tb = this.#versions[b];
    if (ta === undefined || tb === undefined) {
      return failed(err('UNKNOWN_VERSION',
        `Version v${ta === undefined ? a : b} does not exist.`, this.#available()));
    }
    const rootsOf = (table: readonly (NodeId | undefined)[]): NodeId[] =>
      this.#rootIndices().map((i) => table[i]).filter((id): id is NodeId => id !== undefined);

    const diff = diffRoots(this.getStructure(), rootsOf(ta), rootsOf(tb));
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
        label: `${cell.index - lowbit(cell.index) + 1}..${cell.index}`,
        value: cell.value,
        role: lowbit(cell.index) === 1 ? 'leaf' : 'internal',
        depth: this.#depthOf(cell.index),
        slot: `i${cell.index}`,
        origin: cell.origin,
        // Index order, not traversal order: cell 3 belongs between 2 and 4.
        order: cell.index,
      });
    }

    for (const table of this.#versions) {
      for (let i = 1; i <= this.#size; i += 1) {
        const parentId = table[i];
        if (parentId === undefined) continue;
        const parent = this.#cells.get(parentId) as Cell;
        for (const child of this.#childIndices(i)) {
          const childId = table[child];
          if (childId === undefined) continue;
          const kid = this.#cells.get(childId) as Cell;
          if (edges.some((e) => e.from === parentId && e.to === childId)) continue;
          edges.push({
            from: parentId,
            to: childId,
            slot: `c${child}`,
            reused: kid.origin < parent.origin,
          });
        }
      }
    }

    return { layout: 'dag', nodes, edges, roots: this.#allRoots() };
  }

  serialize(): SerializedState {
    return {
      schemaVersion: SCHEMA_VERSION,
      pluginId: 'persistent-bit',
      data: {
        size: this.#size,
        versions: this.#versions.map((table) =>
          table.slice(1).map((id) => (id === undefined ? 0 : (this.#cells.get(id) as Cell).value))),
      },
    };
  }
}

export const persistentBit: AlgorithmPlugin = {
  meta: {
    id: 'persistent-bit',
    name: 'Persistent BIT',
    category: 'Persistent structures',
    summary: 'A Fenwick tree where every update keeps the previous version readable.',
  },
  commands: COMMANDS,
  explain: explainBit,
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
