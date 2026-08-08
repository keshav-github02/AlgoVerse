/**
 * Persistent segment tree.
 *
 * Every update copies the O(log n) root-to-leaf path and reuses the rest of
 * the previous version, so all earlier versions stay readable. Each operation
 * reports its result, its event log, and a statistics delta; it never touches
 * the UI and never mutates a node that already exists.
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

const SCHEMA_VERSION = 1;

interface Node {
  readonly id: NodeId;
  readonly lo: number;
  readonly hi: number;
  readonly value: number;
  readonly left: NodeId | null;
  readonly right: NodeId | null;
  readonly origin: number;
  readonly depth: number;
}

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Create version 0 from an array.',
    complexity: 'O(n)',
    params: [{ name: 'values', kind: 'int-list' }],
  },
  {
    name: 'update',
    summary: 'Write one index, producing a new version.',
    complexity: 'O(log n)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'index', kind: 'int' },
      { name: 'value', kind: 'int' },
    ],
  },
  {
    name: 'query',
    summary: 'Sum a half-open range in a version.',
    complexity: 'O(log n)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'lo', kind: 'int' },
      { name: 'hi', kind: 'int' },
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
  #nodes = new Map<NodeId, Node>();
  #roots: NodeId[] = [];
  #size = 0;
  #next = 0;

  reset(): void {
    this.#nodes = new Map();
    this.#roots = [];
    this.#size = 0;
    this.#next = 0;
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getIntList(cmd, 'values'));
      case 'update': return this.#update(getVersion(cmd, 'version'), getInt(cmd, 'index'), getInt(cmd, 'value'));
      case 'query': return this.#query(getVersion(cmd, 'version'), getInt(cmd, 'lo'), getInt(cmd, 'hi'));
      case 'compare': return this.#compare(getVersion(cmd, 'a'), getVersion(cmd, 'b'));
      default:
        return failed(err('PARSE_ERROR', `This plugin does not handle "${cmd.name}".`));
    }
  }

  /* ── Helpers ─────────────────────────────────────────────────────── */

  #versions(): string {
    return this.#roots.length === 0
      ? 'nothing is built yet — start with build'
      : `versions available: ${this.#roots.map((_, i) => `v${i}`).join(', ')}`;
  }

  #root(v: number): Node | OperationError {
    const id = this.#roots[v];
    if (id === undefined) {
      return err('UNKNOWN_VERSION', `Version v${v} does not exist.`, this.#versions());
    }
    return this.#nodes.get(id) as Node;
  }

  #span(lo: number, hi: number): string {
    return hi - lo === 1 ? `i${lo}` : `[${lo},${hi})`;
  }

  /**
   * Nodes covering the same range at the same depth share a slot, so the
   * layout engine aligns versions and fans them apart.
   */
  #slot(lo: number, hi: number, depth: number): string {
    return `${depth}:${lo}:${hi}`;
  }

  #alloc(
    lo: number, hi: number, value: number, left: NodeId | null, right: NodeId | null,
    origin: number, depth: number, events: SimEvent[],
  ): Node {
    const id = this.#next as NodeId;
    this.#next += 1;
    const node: Node = { id, lo, hi, value, left, right, origin, depth };
    this.#nodes.set(id, node);
    events.push({
      kind: 'NodeAllocated',
      node: id,
      value,
      label: this.#span(lo, hi),
      role: hi - lo === 1 ? 'leaf' : 'internal',
      depth,
      slot: this.#slot(lo, hi, depth),
      origin,
    });
    if (left !== null) events.push({ kind: 'PointerSet', from: id, slot: 'left', to: left });
    if (right !== null) events.push({ kind: 'PointerSet', from: id, slot: 'right', to: right });
    return node;
  }

  /* ── Commands ────────────────────────────────────────────────────── */

  #build(values: readonly number[]): OperationResult {
    this.reset();
    const events: SimEvent[] = [];
    const build = (lo: number, hi: number, depth: number): Node => {
      if (hi - lo === 1) {
        return this.#alloc(lo, hi, values[lo] as number, null, null, 0, depth, events);
      }
      const mid = (lo + hi) >> 1;
      const l = build(lo, mid, depth + 1);
      const r = build(mid, hi, depth + 1);
      return this.#alloc(lo, hi, l.value + r.value, l.id, r.id, 0, depth, events);
    };

    const root = build(0, values.length, 0);
    this.#size = values.length;
    this.#roots.push(root.id);
    events.push({ kind: 'VersionCommitted', version: 0, root: root.id });
    events.push({ kind: 'RootsSet', roots: [...this.#roots] });

    return {
      ok: true,
      value: { version: 0, sum: root.value, size: this.#size },
      events,
      statsDelta: {
        versions: 1,
        nodesAllocated: this.#nodes.size,
        height: Math.ceil(Math.log2(Math.max(1, values.length))) + 1,
      },
    };
  }

  #update(v: number, index: number, value: number): OperationResult {
    const root = this.#root(v);
    if (!('id' in root)) return failed(root);
    if (index < 0 || index >= this.#size) {
      return failed(err('INDEX_OUT_OF_RANGE',
        `Index ${index} is outside 0..${this.#size - 1}.`, `this structure holds ${this.#size} values`));
    }

    const events: SimEvent[] = [];
    const version = this.#roots.length;
    let allocated = 0;
    let reused = 0;

    const copy = (node: Node): Node => {
      events.push({ kind: 'NodeVisited', node: node.id });
      if (node.hi - node.lo === 1) {
        allocated += 1;
        return this.#alloc(node.lo, node.hi, value, null, null, version, node.depth, events);
      }
      const mid = (node.lo + node.hi) >> 1;
      const goLeft = index < mid;
      const l = goLeft ? copy(this.#nodes.get(node.left as NodeId) as Node) : (this.#nodes.get(node.left as NodeId) as Node);
      const r = goLeft ? (this.#nodes.get(node.right as NodeId) as Node) : copy(this.#nodes.get(node.right as NodeId) as Node);
      allocated += 1;
      const made = this.#alloc(node.lo, node.hi, l.value + r.value, l.id, r.id, version, node.depth, events);
      reused += 1;
      events.push({ kind: 'NodeReused', node: goLeft ? r.id : l.id, by: made.id });
      return made;
    };

    const newRoot = copy(root);
    this.#roots.push(newRoot.id);
    events.push({ kind: 'VersionCommitted', version, root: newRoot.id });
    events.push({ kind: 'RootsSet', roots: [...this.#roots] });

    return {
      ok: true,
      value: { version, sum: newRoot.value, allocated, reused },
      events,
      statsDelta: { versions: 1, updates: 1, nodesAllocated: allocated, nodesReused: reused, nodeVisits: allocated },
    };
  }

  #query(v: number, lo: number, hi: number): OperationResult {
    const root = this.#root(v);
    if (!('id' in root)) return failed(root);
    if (lo < 0 || hi > this.#size || lo >= hi) {
      return failed(err('INVALID_RANGE',
        `Range [${lo},${hi}) is not a valid half-open range inside 0..${this.#size}.`,
        'lo must be less than hi, and both within the structure'));
    }

    const events: SimEvent[] = [];
    let visits = 0;
    const walk = (node: Node): number => {
      visits += 1;
      events.push({ kind: 'NodeVisited', node: node.id });
      if (hi <= node.lo || node.hi <= lo) return 0;
      if (lo <= node.lo && node.hi <= hi) return node.value;
      return (
        walk(this.#nodes.get(node.left as NodeId) as Node) +
        walk(this.#nodes.get(node.right as NodeId) as Node)
      );
    };

    const sum = walk(root);
    return {
      ok: true,
      value: { sum, visits },
      events,
      statsDelta: { queries: 1, nodeVisits: visits },
    };
  }

  #compare(a: number, b: number): OperationResult {
    const ra = this.#root(a);
    if (!('id' in ra)) return failed(ra);
    const rb = this.#root(b);
    if (!('id' in rb)) return failed(rb);

    // Reachability is structural, so it lives in core rather than being
    // re-implemented per plugin — and the diff view uses the same function.
    const diff = diffRoots(this.getStructure(), ra.id, rb.id);
    const shared = diff.shared;
    return {
      ok: true,
      value: {
        shared: shared.length,
        onlyInA: diff.onlyA.length,
        onlyInB: diff.onlyB.length,
        sharedPercent: Math.round(diff.sharedRatio * 100),
      },
      events: shared.map((id): SimEvent => ({ kind: 'NodeVisited', node: id })),
      statsDelta: { queries: 1, nodeVisits: shared.length },
    };
  }

  /* ── Views ───────────────────────────────────────────────────────── */

  getStructure(): StructureGraph {
    const nodes: StructureNode[] = [];
    const edges: StructureEdge[] = [];
    for (const n of this.#nodes.values()) {
      nodes.push({
        id: n.id,
        label: this.#span(n.lo, n.hi),
        value: n.value,
        role: n.hi - n.lo === 1 ? 'leaf' : 'internal',
        depth: n.depth,
        slot: this.#slot(n.lo, n.hi, n.depth),
        origin: n.origin,
      });
      for (const [slot, child] of [['left', n.left], ['right', n.right]] as const) {
        if (child === null) continue;
        const c = this.#nodes.get(child) as Node;
        edges.push({ from: n.id, to: child, slot, reused: c.origin < n.origin });
      }
    }
    return { layout: 'dag', nodes, edges, roots: [...this.#roots] };
  }

  serialize(): SerializedState {
    return {
      schemaVersion: SCHEMA_VERSION,
      pluginId: 'persistent-segment-tree',
      data: {
        size: this.#size,
        roots: [...this.#roots],
        nodes: [...this.#nodes.values()].map((n) => ({
          id: n.id, lo: n.lo, hi: n.hi, value: n.value,
          left: n.left, right: n.right, origin: n.origin, depth: n.depth,
        })),
      },
    };
  }
}

export const persistentSegmentTree: AlgorithmPlugin = {
  meta: {
    id: 'persistent-segment-tree',
    name: 'Persistent Segment Tree',
    category: 'Persistent structures',
    summary: 'Range sums over every historical version, with memory shared between them.',
  },
  commands: COMMANDS,
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
