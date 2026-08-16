/**
 * Weighted graph, and Dijkstra over it.
 *
 * The first structure whose *edges* carry data. Everything before this put its
 * information in nodes; a shortest path is decided by what the edges are worth,
 * so the weight has to survive the log, the scene, and the drawing.
 *
 * Dijkstra here selects the nearest unsettled vertex by scanning, not with a
 * heap. That is the O(V²) form, and it is deliberate: the scan is visible as
 * events, so the cost chart shows a square curve and makes the case for a heap
 * rather than asserting it.
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
import { explainShortestPath } from './explain.ts';

const SCHEMA_VERSION = 1;

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Read triples as weighted edges: [1 2 7] joins 1-2 at a cost of 7.',
    complexity: 'O(V + E)',
    params: [{ name: 'triples', kind: 'int-list' }],
  },
  {
    name: 'link',
    summary: 'Add one weighted edge.',
    complexity: 'O(1)',
    params: [
      { name: 'from', kind: 'int' },
      { name: 'to', kind: 'int' },
      { name: 'cost', kind: 'int' },
    ],
  },
  {
    name: 'dijkstra',
    summary: 'Settle every vertex in order of distance from a source.',
    complexity: 'O(V²)',
    params: [{ name: 'from', kind: 'int' }],
  },
  {
    name: 'path',
    summary: 'The cheapest route between two vertices, and what it costs.',
    complexity: 'O(V²)',
    params: [
      { name: 'from', kind: 'int' },
      { name: 'to', kind: 'int' },
    ],
  },
];

function err(code: OperationError['code'], message: string, hint?: string): OperationError {
  return { code, message, ...(hint === undefined ? {} : { hint }) };
}

interface Settled {
  readonly distance: Map<NodeId, number>;
  readonly before: Map<NodeId, NodeId>;
  readonly order: number[];
  readonly events: SimEvent[];
  readonly scans: number;
}

class Instance implements PluginInstance {
  #ids = new Map<number, NodeId>();
  #labels = new Map<NodeId, number>();
  /** Neighbour to cost, sorted by label so every run is reproducible. */
  #adjacency = new Map<NodeId, Map<NodeId, number>>();
  #edges: { from: NodeId; to: NodeId; cost: number }[] = [];
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
      case 'build': return this.#build(getIntList(cmd, 'triples'));
      case 'link': return this.#link(getInt(cmd, 'from'), getInt(cmd, 'to'), getInt(cmd, 'cost'));
      case 'dijkstra': return this.#dijkstra(getInt(cmd, 'from'));
      case 'path': return this.#path(getInt(cmd, 'from'), getInt(cmd, 'to'));
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
    this.#adjacency.set(id, new Map());
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

  #join(a: NodeId, b: NodeId, cost: number, events: SimEvent[]): boolean {
    if (a === b) return false;
    const out = this.#adjacency.get(a) as Map<NodeId, number>;
    if (out.has(b)) return false;
    out.set(b, cost);
    (this.#adjacency.get(b) as Map<NodeId, number>).set(a, cost);
    this.#edges.push({ from: a, to: b, cost });
    // The weight travels in the log: a picture that shows it and a log that
    // does not is a picture replay cannot rebuild.
    events.push({
      kind: 'PointerSet',
      from: a,
      slot: `e${this.#labels.get(b)}`,
      to: b,
      pointer: 'link',
      weight: cost,
    });
    return true;
  }

  #order(): NodeId[] {
    return [...this.#ids.keys()].sort((a, b) => a - b).map((l) => this.#ids.get(l) as NodeId);
  }

  #neighbours(id: NodeId): [NodeId, number][] {
    return [...(this.#adjacency.get(id) as Map<NodeId, number>).entries()]
      .sort((a, b) => (this.#labels.get(a[0]) as number) - (this.#labels.get(b[0]) as number));
  }

  /**
   * Settles vertices nearest first, choosing each by scanning the unsettled
   * ones. The scan is emitted as reads, so its cost is measurable rather than
   * merely claimed.
   */
  #settle(start: NodeId): Settled {
    const events: SimEvent[] = [];
    const distance = new Map<NodeId, number>([[start, 0]]);
    const before = new Map<NodeId, NodeId>();
    const done = new Set<NodeId>();
    const order: number[] = [];
    const all = this.#order();
    let scans = 0;

    for (;;) {
      let pick: NodeId | null = null;
      let best = Infinity;
      for (const id of all) {
        if (done.has(id)) continue;
        const d = distance.get(id);
        scans += 1;
        // Every vertex the scan reads is a read, including the ones it rejects.
        events.push({ kind: 'NodeVisited', node: id });
        if (d !== undefined && d < best) { best = d; pick = id; }
      }
      if (pick === null) break;

      done.add(pick);
      order.push(this.#labels.get(pick) as number);
      for (const [other, cost] of this.#neighbours(pick)) {
        if (done.has(other)) continue;
        const through = best + cost;
        const current = distance.get(other);
        if (current !== undefined && current <= through) continue;
        distance.set(other, through);
        before.set(other, pick);
      }
    }

    return { distance, before, order, events, scans };
  }

  /* ── Commands ────────────────────────────────────────────────────── */

  #build(triples: readonly number[]): OperationResult {
    if (triples.length % 3 !== 0) {
      return failed(err('BAD_ARGUMENT',
        `A weighted edge list needs a multiple of three; ${triples.length} given.`,
        'each triple is one edge, so [1 2 7] joins 1-2 at a cost of 7'));
    }
    const negative = [];
    for (let i = 2; i < triples.length; i += 3) {
      if ((triples[i] as number) < 0) negative.push(triples[i] as number);
    }
    if (negative.length > 0) {
      return failed(err('BAD_ARGUMENT',
        `Costs cannot be negative; found ${negative.join(', ')}.`,
        'Dijkstra settles a vertex once and never revisits it, which a negative edge would break'));
    }

    this.reset();
    const events: SimEvent[] = [];
    let added = 0;
    for (let i = 0; i < triples.length; i += 3) {
      const a = this.#vertex(triples[i] as number, events);
      const b = this.#vertex(triples[i + 1] as number, events);
      if (this.#join(a, b, triples[i + 2] as number, events)) added += 1;
    }
    events.push({ kind: 'RootsSet', roots: this.#order() });

    return {
      ok: true,
      value: { vertices: this.#ids.size, edges: added },
      events,
      statsDelta: { nodesAllocated: this.#ids.size, updates: 1 },
    };
  }

  #link(from: number, to: number, cost: number): OperationResult {
    if (cost < 0) {
      return failed(err('BAD_ARGUMENT', `A cost of ${cost} is negative.`,
        'Dijkstra settles a vertex once and never revisits it'));
    }
    if (from === to) {
      return failed(err('PRECONDITION_FAILED', 'A vertex cannot be joined to itself.',
        'self-loops never shorten a path'));
    }
    const events: SimEvent[] = [];
    const a = this.#vertex(from, events);
    const b = this.#vertex(to, events);
    if (!this.#join(a, b, cost, events)) {
      return failed(err('PRECONDITION_FAILED', `${from} and ${to} are already joined.`, this.#known()));
    }
    events.push({ kind: 'RootsSet', roots: this.#order() });
    return {
      ok: true,
      value: { from, to, cost, vertices: this.#ids.size, edges: this.#edges.length },
      events,
      statsDelta: { updates: 1, nodesAllocated: events.filter((e) => e.kind === 'NodeAllocated').length },
    };
  }

  #dijkstra(from: number): OperationResult {
    const start = this.#ids.get(from);
    if (start === undefined) {
      return failed(err('UNKNOWN_VERSION', `There is no vertex ${from}.`, this.#known()));
    }

    const { distance, order, events, scans } = this.#settle(start);
    const reached: Record<string, number> = {};
    for (const [id, d] of [...distance.entries()]
      .sort((a, b) => (this.#labels.get(a[0]) as number) - (this.#labels.get(b[0]) as number))) {
      reached[String(this.#labels.get(id))] = d;
    }

    return {
      ok: true,
      value: {
        from, order, distances: reached,
        settled: order.length, unreachable: this.#ids.size - order.length, scans,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: events.length },
    };
  }

  #path(from: number, to: number): OperationResult {
    const start = this.#ids.get(from);
    const goal = this.#ids.get(to);
    if (start === undefined || goal === undefined) {
      return failed(err('UNKNOWN_VERSION',
        `There is no vertex ${start === undefined ? from : to}.`, this.#known()));
    }

    const { distance, before, events } = this.#settle(start);
    const cost = distance.get(goal);
    if (cost === undefined) {
      return {
        ok: true,
        value: { from, to, reachable: false, route: [], cost: null },
        events,
        statsDelta: { queries: 1, nodeVisits: events.length },
      };
    }

    const route: number[] = [];
    for (let cursor: NodeId | undefined = goal; cursor !== undefined; cursor = before.get(cursor)) {
      route.push(this.#labels.get(cursor) as number);
    }
    route.reverse();

    return {
      ok: true,
      value: { from, to, reachable: true, route, cost, hops: route.length - 1 },
      events,
      statsDelta: { queries: 1, nodeVisits: events.length },
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
      weight: e.cost,
    }));

    return { layout: 'force', nodes, edges, roots: this.#order() };
  }

  serialize(): SerializedState {
    return {
      schemaVersion: SCHEMA_VERSION,
      pluginId: 'shortest-path',
      data: {
        edges: this.#edges
          .map((e) => [this.#labels.get(e.from), this.#labels.get(e.to), e.cost])
          .sort((a, b) => (a[0] as number) - (b[0] as number) || (a[1] as number) - (b[1] as number)),
      },
    };
  }
}

export const shortestPath: AlgorithmPlugin = {
  meta: {
    id: 'shortest-path',
    name: 'Shortest Path',
    category: 'Graphs',
    summary: 'A weighted graph, and Dijkstra settling it one nearest vertex at a time.',
  },
  commands: COMMANDS,
  explain: explainShortestPath,
  benchmark: {
    sizes: [8, 16, 32, 64],
    command: 'dijkstra',
    // Stops at 64: the scan is quadratic and every read is an event, so 128
    // would file sixteen thousand of them to measure one point.
    setup: (n: number): readonly string[] => {
      const triples: number[] = [];
      for (let i = 1; i < n; i += 1) triples.push(i, i + 1, (i % 9) + 1);
      return [`build [${triples.join(' ')}]`];
    },
    probes: (): readonly string[] => ['dijkstra 1'],
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
