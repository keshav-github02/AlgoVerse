/**
 * Undirected graph, with the two traversals everything else is built on.
 *
 * The first structure here with no hierarchy at all. There is no root, no
 * parent, and no guarantee the thing is even connected - which turns out to be
 * the interesting part, because every layout and every check written so far
 * quietly assumed at least one of those.
 *
 * Nothing is persistent: a traversal reads the graph and reports where it went.
 * The version machinery simply goes unused, which is the honest thing for a
 * structure that has no history.
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
import { explainGraph } from './explain.ts';

const SCHEMA_VERSION = 1;

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Read a flat list of pairs as edges: [1 2 2 3] joins 1-2 and 2-3.',
    complexity: 'O(V + E)',
    params: [{ name: 'pairs', kind: 'int-list' }],
  },
  {
    name: 'link',
    summary: 'Add one edge between two existing or new vertices.',
    complexity: 'O(1)',
    params: [
      { name: 'from', kind: 'int' },
      { name: 'to', kind: 'int' },
    ],
  },
  {
    name: 'dfs',
    summary: 'Walk depth first from a vertex, going as deep as possible first.',
    complexity: 'O(V + E)',
    params: [{ name: 'from', kind: 'int' }],
  },
  {
    name: 'bfs',
    summary: 'Walk breadth first from a vertex, nearest vertices first.',
    complexity: 'O(V + E)',
    params: [{ name: 'from', kind: 'int' }],
  },
  {
    name: 'components',
    summary: 'Count the separate pieces the graph falls into.',
    complexity: 'O(V + E)',
    params: [],
  },
];

function err(code: OperationError['code'], message: string, hint?: string): OperationError {
  return { code, message, ...(hint === undefined ? {} : { hint }) };
}

class Instance implements PluginInstance {
  /** Vertex label to node id. Labels are the numbers the user typed. */
  #ids = new Map<number, NodeId>();
  #labels = new Map<NodeId, number>();
  /** Neighbours, kept sorted so every traversal is reproducible. */
  #adjacency = new Map<NodeId, NodeId[]>();
  #edges: { from: NodeId; to: NodeId }[] = [];
  #next = 0;

  reset(): void {
    this.#ids = new Map();
    this.#labels = new Map();
    this.#adjacency = new Map();
    this.#edges = [];
    this.#next = 0;
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getIntList(cmd, 'pairs'));
      case 'link': return this.#link(getInt(cmd, 'from'), getInt(cmd, 'to'));
      case 'dfs': return this.#traverse(getInt(cmd, 'from'), 'dfs');
      case 'bfs': return this.#traverse(getInt(cmd, 'from'), 'bfs');
      case 'components': return this.#components();
      default:
        return failed(err('PARSE_ERROR', `This plugin does not handle "${cmd.name}".`));
    }
  }

  /* ── Helpers ─────────────────────────────────────────────────────── */

  #known(): string {
    const labels = [...this.#ids.keys()].sort((a, b) => a - b);
    return labels.length === 0
      ? 'the graph is empty - start with build'
      : `vertices: ${labels.join(', ')}`;
  }

  #vertex(label: number, events: SimEvent[]): NodeId {
    const existing = this.#ids.get(label);
    if (existing !== undefined) return existing;
    const id = this.#next as NodeId;
    this.#next += 1;
    this.#ids.set(label, id);
    this.#labels.set(id, label);
    this.#adjacency.set(id, []);
    events.push({
      kind: 'NodeAllocated',
      node: id,
      value: label,
      label: `${label}`,
      // No hierarchy, so every vertex is the same kind of thing.
      role: 'vertex',
      slot: `v${label}`,
      origin: 0,
    });
    return id;
  }

  #join(a: NodeId, b: NodeId, events: SimEvent[]): boolean {
    const from = this.#adjacency.get(a) as NodeId[];
    if (from.includes(b) || a === b) return false;
    from.push(b);
    from.sort((x, y) => (this.#labels.get(x) as number) - (this.#labels.get(y) as number));
    const back = this.#adjacency.get(b) as NodeId[];
    back.push(a);
    back.sort((x, y) => (this.#labels.get(x) as number) - (this.#labels.get(y) as number));
    this.#edges.push({ from: a, to: b });
    // An undirected edge is not a parent pointing at a child, so it is a link.
    events.push({ kind: 'PointerSet', from: a, slot: `e${this.#labels.get(b)}`, to: b, pointer: 'link' });
    return true;
  }

  /** Every vertex is an entry point: an unrooted structure has no other answer. */
  #roots(): NodeId[] {
    return [...this.#ids.keys()].sort((a, b) => a - b).map((l) => this.#ids.get(l) as NodeId);
  }

  #order(): NodeId[] {
    return this.#roots();
  }

  /* ── Commands ────────────────────────────────────────────────────── */

  #build(pairs: readonly number[]): OperationResult {
    if (pairs.length % 2 !== 0) {
      return failed(err('BAD_ARGUMENT',
        `An edge list needs an even number of vertices; ${pairs.length} given.`,
        'each pair is one edge, so [1 2 2 3] joins 1-2 and 2-3'));
    }
    this.reset();
    const events: SimEvent[] = [];
    let added = 0;
    for (let i = 0; i < pairs.length; i += 2) {
      const a = this.#vertex(pairs[i] as number, events);
      const b = this.#vertex(pairs[i + 1] as number, events);
      if (this.#join(a, b, events)) added += 1;
    }
    events.push({ kind: 'RootsSet', roots: this.#roots() });

    return {
      ok: true,
      value: { vertices: this.#ids.size, edges: added, components: this.#componentCount() },
      events,
      statsDelta: { nodesAllocated: this.#ids.size, updates: 1 },
    };
  }

  #link(from: number, to: number): OperationResult {
    if (from === to) {
      return failed(err('PRECONDITION_FAILED', `A vertex cannot be joined to itself.`,
        'self-loops are not modelled here'));
    }
    const events: SimEvent[] = [];
    const a = this.#vertex(from, events);
    const b = this.#vertex(to, events);
    if (!this.#join(a, b, events)) {
      return failed(err('PRECONDITION_FAILED', `${from} and ${to} are already joined.`,
        this.#known()));
    }
    events.push({ kind: 'RootsSet', roots: this.#roots() });
    return {
      ok: true,
      value: { from, to, vertices: this.#ids.size, edges: this.#edges.length },
      events,
      statsDelta: { updates: 1, nodesAllocated: events.filter((e) => e.kind === 'NodeAllocated').length },
    };
  }

  #traverse(from: number, how: 'dfs' | 'bfs'): OperationResult {
    const start = this.#ids.get(from);
    if (start === undefined) {
      return failed(err('UNKNOWN_VERSION', `There is no vertex ${from}.`, this.#known()));
    }

    const events: SimEvent[] = [];
    const seen = new Set<NodeId>([start]);
    const order: number[] = [];
    // A stack read from the back is depth first; a queue read from the front
    // is breadth first. Nothing else about the walk differs.
    const pending: NodeId[] = [start];

    while (pending.length > 0) {
      const id = how === 'dfs' ? (pending.pop() as NodeId) : (pending.shift() as NodeId);
      order.push(this.#labels.get(id) as number);
      events.push({ kind: 'NodeVisited', node: id });

      const neighbours = this.#adjacency.get(id) as NodeId[];
      // Depth first pushes in reverse so the lowest label comes off first,
      // which makes both walks visit ties in the same order.
      const next = how === 'dfs' ? [...neighbours].reverse() : neighbours;
      for (const other of next) {
        if (seen.has(other)) continue;
        seen.add(other);
        pending.push(other);
      }
    }

    return {
      ok: true,
      value: {
        from, order, reached: order.length,
        missed: this.#ids.size - order.length,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: order.length },
    };
  }

  #componentCount(): number {
    const seen = new Set<NodeId>();
    let count = 0;
    for (const id of this.#order()) {
      if (seen.has(id)) continue;
      count += 1;
      const stack = [id];
      while (stack.length > 0) {
        const cur = stack.pop() as NodeId;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const other of this.#adjacency.get(cur) as NodeId[]) stack.push(other);
      }
    }
    return count;
  }

  #components(): OperationResult {
    const events: SimEvent[] = [];
    const seen = new Set<NodeId>();
    const sizes: number[] = [];

    for (const id of this.#order()) {
      if (seen.has(id)) continue;
      let size = 0;
      const stack = [id];
      while (stack.length > 0) {
        const cur = stack.pop() as NodeId;
        if (seen.has(cur)) continue;
        seen.add(cur);
        size += 1;
        events.push({ kind: 'NodeVisited', node: cur });
        for (const other of this.#adjacency.get(cur) as NodeId[]) stack.push(other);
      }
      sizes.push(size);
    }

    return {
      ok: true,
      value: { components: sizes.length, sizes, vertices: this.#ids.size },
      events,
      statsDelta: { queries: 1, nodeVisits: this.#ids.size },
    };
  }

  /* ── Views ───────────────────────────────────────────────────────── */

  getStructure(): StructureGraph {
    const nodes: StructureNode[] = this.#order().map((id) => ({
      id,
      label: `${this.#labels.get(id)}`,
      value: this.#labels.get(id) as number,
      role: 'vertex',
      slot: `v${this.#labels.get(id)}`,
      origin: 0,
    }));
    const edges: StructureEdge[] = this.#edges.map((e) => ({
      from: e.from,
      to: e.to,
      slot: `e${this.#labels.get(e.to)}`,
      reused: false,
      // Not hierarchy: neither end is the other's parent.
      kind: 'link',
    }));

    return { layout: 'force', nodes, edges, roots: this.#roots() };
  }

  serialize(): SerializedState {
    return {
      schemaVersion: SCHEMA_VERSION,
      pluginId: 'graph',
      data: {
        edges: this.#edges
          .map((e) => [this.#labels.get(e.from), this.#labels.get(e.to)])
          .sort((a, b) => (a[0] as number) - (b[0] as number) || (a[1] as number) - (b[1] as number)),
      },
    };
  }
}

export const graph: AlgorithmPlugin = {
  meta: {
    id: 'graph',
    name: 'Graph',
    category: 'Graphs',
    summary: 'Vertices and edges with no hierarchy, and the two ways to walk them.',
  },
  commands: COMMANDS,
  explain: explainGraph,
  benchmark: {
    sizes: [8, 16, 32, 64, 128, 256],
    command: 'bfs',
    // A path graph: n vertices in a line, so a full traversal must touch all n.
    setup: (n: number): readonly string[] => {
      const pairs: number[] = [];
      for (let i = 1; i < n; i += 1) pairs.push(i, i + 1);
      return [`build [${pairs.join(' ')}]`];
    },
    probes: (): readonly string[] => ['bfs 1'],
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
