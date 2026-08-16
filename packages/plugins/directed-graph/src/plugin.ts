/**
 * Directed graph: strongly connected components, and topological order.
 *
 * The first structure where an edge's direction is the whole point. `from` and
 * `to` already said which way a pointer ran, but nothing drew it - an edge
 * between two vertices side by side looked the same either way round. A tree
 * never needed it, because the parent is the one higher up.
 *
 * The two commands are a pair. A topological order exists exactly when there
 * is no cycle, and `scc` finds the cycles: every component larger than one
 * vertex is a knot that ordering cannot untie.
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
import { explainDirected } from './explain.ts';

const SCHEMA_VERSION = 1;

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Read pairs as one-way edges: [1 2 2 3] means 1 to 2 and 2 to 3.',
    complexity: 'O(V + E)',
    params: [{ name: 'pairs', kind: 'int-list' }],
  },
  {
    name: 'link',
    summary: 'Add one edge, running from the first vertex to the second.',
    complexity: 'O(1)',
    params: [
      { name: 'from', kind: 'int' },
      { name: 'to', kind: 'int' },
    ],
  },
  {
    name: 'reach',
    summary: 'Everything you can get to from a vertex, following the arrows.',
    complexity: 'O(V + E)',
    params: [{ name: 'from', kind: 'int' }],
  },
  {
    name: 'scc',
    summary: 'Group vertices that can all reach each other.',
    complexity: 'O(V + E)',
    params: [],
  },
  {
    name: 'topo',
    summary: 'Order the vertices so every edge points forward, if that is possible.',
    complexity: 'O(V + E)',
    params: [],
  },
];

function err(code: OperationError['code'], message: string, hint?: string): OperationError {
  return { code, message, ...(hint === undefined ? {} : { hint }) };
}

class Instance implements PluginInstance {
  #ids = new Map<number, NodeId>();
  #labels = new Map<NodeId, number>();
  /** Edges out of each vertex, sorted by label so every run is reproducible. */
  #out = new Map<NodeId, NodeId[]>();
  #edges: { from: NodeId; to: NodeId }[] = [];
  #next = 0;

  reset(): void {
    this.#ids = new Map();
    this.#labels = new Map();
    this.#out = new Map();
    this.#edges = [];
    this.#next = 0;
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getIntList(cmd, 'pairs'));
      case 'link': return this.#link(getInt(cmd, 'from'), getInt(cmd, 'to'));
      case 'reach': return this.#reach(getInt(cmd, 'from'));
      case 'scc': return this.#scc();
      case 'topo': return this.#topo();
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
    this.#out.set(id, []);
    events.push({
      kind: 'NodeAllocated',
      node: id,
      value: label,
      label: `${label}`,
      role: 'vertex',
      slot: `v${label}`,
      origin: 0,
    });
    return id;
  }

  #join(a: NodeId, b: NodeId, events: SimEvent[]): boolean {
    const out = this.#out.get(a) as NodeId[];
    if (out.includes(b)) return false;
    out.push(b);
    out.sort((x, y) => (this.#labels.get(x) as number) - (this.#labels.get(y) as number));
    this.#edges.push({ from: a, to: b });
    events.push({
      kind: 'PointerSet',
      from: a,
      slot: `e${this.#labels.get(b)}`,
      to: b,
      pointer: 'link',
      // The one thing this plugin adds: the edge runs one way, and says so.
      directed: true,
    });
    return true;
  }

  #order(): NodeId[] {
    return [...this.#ids.keys()].sort((a, b) => a - b).map((l) => this.#ids.get(l) as NodeId);
  }

  /**
   * Tarjan's algorithm, run iteratively.
   *
   * A vertex leads a component when nothing below it in the search reaches
   * further back than the vertex itself - that is what `low === index` means.
   * Written with an explicit stack so a deep graph cannot exhaust the real one.
   */
  #tarjan(events: SimEvent[]): NodeId[][] {
    const index = new Map<NodeId, number>();
    const low = new Map<NodeId, number>();
    const onStack = new Set<NodeId>();
    const stack: NodeId[] = [];
    const components: NodeId[][] = [];
    let counter = 0;

    for (const root of this.#order()) {
      if (index.has(root)) continue;
      const work: { id: NodeId; next: number }[] = [{ id: root, next: 0 }];
      index.set(root, counter);
      low.set(root, counter);
      counter += 1;
      stack.push(root);
      onStack.add(root);
      events.push({ kind: 'NodeVisited', node: root });

      while (work.length > 0) {
        const frame = work[work.length - 1] as { id: NodeId; next: number };
        const neighbours = this.#out.get(frame.id) as NodeId[];

        if (frame.next < neighbours.length) {
          const other = neighbours[frame.next] as NodeId;
          frame.next += 1;
          if (!index.has(other)) {
            index.set(other, counter);
            low.set(other, counter);
            counter += 1;
            stack.push(other);
            onStack.add(other);
            events.push({ kind: 'NodeVisited', node: other });
            work.push({ id: other, next: 0 });
          } else if (onStack.has(other)) {
            // An edge back into the current search: the two are in one knot.
            low.set(frame.id, Math.min(low.get(frame.id) as number, index.get(other) as number));
          }
          continue;
        }

        work.pop();
        const parent = work[work.length - 1];
        if (parent !== undefined) {
          low.set(parent.id, Math.min(low.get(parent.id) as number, low.get(frame.id) as number));
        }
        if (low.get(frame.id) === index.get(frame.id)) {
          const group: NodeId[] = [];
          for (;;) {
            const popped = stack.pop() as NodeId;
            onStack.delete(popped);
            group.push(popped);
            if (popped === frame.id) break;
          }
          components.push(group);
        }
      }
    }

    return components;
  }

  /* ── Commands ────────────────────────────────────────────────────── */

  #build(pairs: readonly number[]): OperationResult {
    if (pairs.length % 2 !== 0) {
      return failed(err('BAD_ARGUMENT',
        `An edge list needs an even number of vertices; ${pairs.length} given.`,
        'each pair is one edge, so [1 2 2 3] means 1 to 2 and 2 to 3'));
    }
    this.reset();
    const events: SimEvent[] = [];
    let added = 0;
    for (let i = 0; i < pairs.length; i += 2) {
      const a = this.#vertex(pairs[i] as number, events);
      const b = this.#vertex(pairs[i + 1] as number, events);
      if (a !== b && this.#join(a, b, events)) added += 1;
    }
    events.push({ kind: 'RootsSet', roots: this.#order() });

    return {
      ok: true,
      value: { vertices: this.#ids.size, edges: added },
      events,
      statsDelta: { nodesAllocated: this.#ids.size, updates: 1 },
    };
  }

  #link(from: number, to: number): OperationResult {
    if (from === to) {
      return failed(err('PRECONDITION_FAILED', 'A vertex cannot point at itself.',
        'a self-loop is its own component, which is already true of every vertex'));
    }
    const events: SimEvent[] = [];
    const a = this.#vertex(from, events);
    const b = this.#vertex(to, events);
    if (!this.#join(a, b, events)) {
      return failed(err('PRECONDITION_FAILED', `${from} already points at ${to}.`, this.#known()));
    }
    events.push({ kind: 'RootsSet', roots: this.#order() });
    return {
      ok: true,
      value: { from, to, vertices: this.#ids.size, edges: this.#edges.length },
      events,
      statsDelta: { updates: 1, nodesAllocated: events.filter((e) => e.kind === 'NodeAllocated').length },
    };
  }

  #reach(from: number): OperationResult {
    const start = this.#ids.get(from);
    if (start === undefined) {
      return failed(err('UNKNOWN_VERSION', `There is no vertex ${from}.`, this.#known()));
    }

    const events: SimEvent[] = [];
    const seen = new Set<NodeId>([start]);
    const order: number[] = [];
    const pending = [start];
    while (pending.length > 0) {
      const id = pending.shift() as NodeId;
      order.push(this.#labels.get(id) as number);
      events.push({ kind: 'NodeVisited', node: id });
      for (const other of this.#out.get(id) as NodeId[]) {
        if (seen.has(other)) continue;
        seen.add(other);
        pending.push(other);
      }
    }

    return {
      ok: true,
      value: {
        from, order, reached: order.length,
        // Following arrows the other way is a different question entirely.
        unreachable: this.#ids.size - order.length,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: order.length },
    };
  }

  #scc(): OperationResult {
    const events: SimEvent[] = [];
    const components = this.#tarjan(events)
      .map((group) => group.map((id) => this.#labels.get(id) as number).sort((a, b) => a - b))
      .sort((a, b) => (a[0] as number) - (b[0] as number));

    const cyclic = components.filter((c) => c.length > 1);
    return {
      ok: true,
      value: {
        components: components.length,
        groups: components,
        // A component of one vertex is trivial; anything bigger is a cycle.
        cycles: cyclic.length,
        largest: components.reduce((m, c) => Math.max(m, c.length), 0),
      },
      events,
      statsDelta: { queries: 1, nodeVisits: events.length },
    };
  }

  #topo(): OperationResult {
    const events: SimEvent[] = [];
    const incoming = new Map<NodeId, number>();
    for (const id of this.#order()) incoming.set(id, 0);
    for (const e of this.#edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);

    // Kahn's algorithm: repeatedly take a vertex nothing points at any more.
    const ready = this.#order().filter((id) => incoming.get(id) === 0);
    const order: number[] = [];
    while (ready.length > 0) {
      const id = ready.shift() as NodeId;
      order.push(this.#labels.get(id) as number);
      events.push({ kind: 'NodeVisited', node: id });
      for (const other of this.#out.get(id) as NodeId[]) {
        const left = (incoming.get(other) as number) - 1;
        incoming.set(other, left);
        if (left === 0) ready.push(other);
      }
    }

    const stuck = this.#ids.size - order.length;
    return {
      ok: true,
      value: stuck === 0
        ? { ordered: true, order }
        : {
          ordered: false,
          order,
          /*
           * Not "the vertices in a cycle": a vertex downstream of one is stuck
           * too, because nothing in the cycle is ever placed to free it. The
           * honest count is everything a cycle can reach, itself included.
           */
          unplaced: stuck,
          reason: 'a topological order exists only when there is no cycle',
        },
      events,
      statsDelta: { queries: 1, nodeVisits: order.length },
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
      kind: 'link',
      directed: true,
    }));

    return { layout: 'force', nodes, edges, roots: this.#order() };
  }

  serialize(): SerializedState {
    return {
      schemaVersion: SCHEMA_VERSION,
      pluginId: 'directed-graph',
      data: {
        edges: this.#edges
          .map((e) => [this.#labels.get(e.from), this.#labels.get(e.to)])
          .sort((a, b) => (a[0] as number) - (b[0] as number) || (a[1] as number) - (b[1] as number)),
      },
    };
  }
}

export const directedGraph: AlgorithmPlugin = {
  meta: {
    id: 'directed-graph',
    name: 'Directed Graph',
    category: 'Graphs',
    summary: 'One-way edges, the knots they tie, and the order that exists when they do not.',
  },
  commands: COMMANDS,
  explain: explainDirected,
  benchmark: {
    sizes: [8, 16, 32, 64, 128, 256],
    command: 'scc',
    // A chain of vertices: every one its own component, so the walk is honest
    // about visiting all of them without any cycle shortening the work.
    setup: (n: number): readonly string[] => {
      const pairs: number[] = [];
      for (let i = 1; i < n; i += 1) pairs.push(i, i + 1);
      return [`build [${pairs.join(' ')}]`];
    },
    probes: (): readonly string[] => ['scc'],
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
