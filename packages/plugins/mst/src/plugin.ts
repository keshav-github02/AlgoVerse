/**
 * Minimum spanning trees, by two different greedy strategies.
 *
 * Prim and Kruskal are in one plugin on purpose. They solve the same problem
 * from opposite directions - one grows a single tree outward, the other picks
 * cheap edges from anywhere and lets the pieces meet - and the interesting
 * thing about them is that they must arrive at the same total weight. That is
 * not a coincidence to be admired but a claim to be checked, and having both
 * here means each can check the other.
 *
 * ## Why either of them works
 *
 * Both rest on one fact, the **cut property**: take any way of splitting the
 * vertices into two sides; the cheapest edge crossing that split belongs to
 * some minimum spanning tree. Prim uses it directly - its split is always
 * "what I have reached" against "what I have not". Kruskal uses it the other
 * way round: when it considers the cheapest edge not yet examined and finds
 * the two ends in different pieces, that edge is the cheapest across the split
 * separating those pieces, so it is safe.
 *
 * Neither needs to look ahead, and neither ever takes an edge back.
 */

import {
  getIntList,
  type CommandSpec, type NodeId, type OperationError, type ParsedCommand, type SimEvent,
} from '@algoverse/core';
import {
  failed,
  type AlgorithmPlugin, type EngineContext, type OperationResult,
  type PluginInstance, type SerializedState,
  type StructureEdge, type StructureGraph, type StructureNode,
} from '@algoverse/plugin-sdk';
import { explainMst } from './explain.ts';

const SCHEMA_VERSION = 1;

interface Edge {
  readonly a: number;
  readonly b: number;
  readonly weight: number;
}

interface Reach {
  readonly cost: number;
  readonly from: number;
}

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Read triples as weighted edges: [1 2 4] joins 1-2 at a cost of 4.',
    complexity: 'O(V + E)',
    params: [{ name: 'triples', kind: 'int-list' }],
  },
  {
    name: 'prim',
    summary: 'Grow one tree outward, always taking the cheapest edge leaving it.',
    complexity: 'O(n²)',
    params: [],
  },
  {
    name: 'kruskal',
    summary: 'Take edges cheapest first, keeping any that joins two separate pieces.',
    complexity: 'O(E log E)',
    params: [],
  },
  {
    name: 'agree',
    summary: 'Run both and check they reached the same total.',
    complexity: 'O(n²)',
    params: [],
  },
];

function err(code: OperationError['code'], message: string, hint?: string): OperationError {
  return { code, message, ...(hint === undefined ? {} : { hint }) };
}

const name = (e: Edge): string => `${e.a}-${e.b}`;

class Instance implements PluginInstance {
  #ids = new Map<number, NodeId>();
  #edges: Edge[] = [];
  #adjacent = new Map<number, { to: number; weight: number }[]>();
  #next = 0;

  reset(): void {
    this.#ids = new Map();
    this.#edges = [];
    this.#adjacent = new Map();
    this.#next = 0;
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getIntList(cmd, 'triples'));
      case 'prim': return this.#primResult();
      case 'kruskal': return this.#kruskalResult();
      case 'agree': return this.#agree();
      default:
        return failed(err('PARSE_ERROR', `This plugin does not handle "${cmd.name}".`));
    }
  }

  /* ── Helpers ─────────────────────────────────────────────────────── */

  #ready(): OperationError | null {
    return this.#ids.size === 0
      ? err('PRECONDITION_FAILED', 'No graph has been built yet.',
        'start with build, as in: build [1 2 4 2 3 1 1 3 9]')
      : null;
  }

  #vertices(): number[] {
    return [...this.#ids.keys()].sort((a, b) => a - b);
  }

  #id(v: number): NodeId {
    return this.#ids.get(v) as NodeId;
  }

  #neighbours(v: number): { to: number; weight: number }[] {
    return this.#adjacent.get(v) ?? [];
  }

  /** How many pieces the graph falls into, so a forest can be reported honestly. */
  #pieces(): number {
    const seen = new Set<number>();
    let count = 0;
    for (const v of this.#vertices()) {
      if (seen.has(v)) continue;
      count += 1;
      const stack = [v];
      while (stack.length > 0) {
        const cur = stack.pop() as number;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const n of this.#neighbours(cur)) stack.push(n.to);
      }
    }
    return count;
  }

  /* ── Prim ────────────────────────────────────────────────────────── */

  /**
   * One tree at a time, grown from the lowest label.
   *
   * `reach[v]` is the least it would cost to attach v to what has been reached
   * so far. Each round takes the smallest of those, which is the cheapest edge
   * crossing the split between reached and unreached - safe by the cut
   * property - and then updates the neighbours of whatever was added.
   *
   * Scanning for that smallest entry is what makes this quadratic, and it is
   * also what is counted: every entry looked at is one visit.
   */
  #prim(events: SimEvent[]): { chosen: Edge[]; scanned: number } {
    const vertices = this.#vertices();
    const inTree = new Set<number>();
    const reach = new Map<number, Reach>();
    const chosen: Edge[] = [];
    let scanned = 0;

    const relax = (from: number): void => {
      for (const n of this.#neighbours(from)) {
        if (inTree.has(n.to)) continue;
        const current = reach.get(n.to);
        if (current === undefined || n.weight < current.cost) {
          reach.set(n.to, { cost: n.weight, from });
        }
      }
    };

    // A disconnected graph gets one tree per piece, which is a forest.
    for (const start of vertices) {
      if (inTree.has(start)) continue;
      inTree.add(start);
      reach.delete(start);
      events.push({ kind: 'NodeVisited', node: this.#id(start) });
      relax(start);

      for (;;) {
        let pick: number | null = null;
        let best: Reach | null = null;
        for (const v of vertices) {
          if (inTree.has(v)) continue;
          const entry = reach.get(v);
          if (entry === undefined) continue;
          scanned += 1;
          events.push({ kind: 'NodeVisited', node: this.#id(v) });
          // Ties break on the lower label, so the answer is reproducible.
          if (best === null || entry.cost < best.cost) { best = entry; pick = v; }
        }
        if (pick === null || best === null) break;

        inTree.add(pick);
        reach.delete(pick);
        chosen.push({
          a: Math.min(best.from, pick),
          b: Math.max(best.from, pick),
          weight: best.cost,
        });
        relax(pick);
      }
    }

    return { chosen, scanned };
  }

  /* ── Kruskal ─────────────────────────────────────────────────────── */

  /**
   * Cheapest edge first, kept when its ends are in different pieces.
   *
   * The pieces are tracked by union-find. Nothing here knows or cares which
   * tree an edge is joining, only whether the two ends are already joined -
   * which is why the edges can be taken in whatever order the sort produces.
   */
  #kruskal(events: SimEvent[]): { chosen: Edge[]; examined: number; rejected: number } {
    const parent = new Map<number, number>();
    for (const v of this.#vertices()) parent.set(v, v);

    const find = (v: number): number => {
      let root = v;
      while ((parent.get(root) as number) !== root) root = parent.get(root) as number;
      // Flattened on the way back, so asking again is cheaper.
      let cur = v;
      while ((parent.get(cur) as number) !== cur) {
        const up = parent.get(cur) as number;
        parent.set(cur, root);
        cur = up;
      }
      return root;
    };

    const sorted = [...this.#edges].sort((x, y) => x.weight - y.weight || x.a - y.a || x.b - y.b);
    const chosen: Edge[] = [];
    let rejected = 0;

    for (const e of sorted) {
      events.push({ kind: 'NodeVisited', node: this.#id(e.a) });
      events.push({ kind: 'NodeVisited', node: this.#id(e.b) });
      const ra = find(e.a);
      const rb = find(e.b);
      if (ra === rb) { rejected += 1; continue; }
      parent.set(ra, rb);
      chosen.push(e);
    }

    return { chosen, examined: sorted.length, rejected };
  }

  /* ── Commands ────────────────────────────────────────────────────── */

  #build(triples: readonly number[]): OperationResult {
    if (triples.length === 0 || triples.length % 3 !== 0) {
      return failed(err('BAD_ARGUMENT',
        `A weighted edge list needs a multiple of three values; ${triples.length} given.`,
        'each triple is one edge, so [1 2 4] joins 1-2 at a cost of 4'));
    }

    this.reset();
    const events: SimEvent[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < triples.length; i += 3) {
      const a = triples[i] as number;
      const b = triples[i + 1] as number;
      const weight = triples[i + 2] as number;

      if (a === b) {
        this.reset();
        return failed(err('PRECONDITION_FAILED', `Vertex ${a} cannot be joined to itself.`,
          'a spanning tree has no loops, so a self edge could never be part of one'));
      }
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (seen.has(key)) {
        this.reset();
        return failed(err('PRECONDITION_FAILED', `The edge ${a}-${b} is given twice.`,
          'keep the cheaper one; a second edge between the same pair can never help'));
      }
      seen.add(key);

      for (const v of [a, b]) {
        if (this.#ids.has(v)) continue;
        const id = this.#next as NodeId;
        this.#next += 1;
        this.#ids.set(v, id);
        this.#adjacent.set(v, []);
        events.push({
          kind: 'NodeAllocated',
          node: id,
          value: v,
          label: `${v}`,
          role: 'vertex',
          slot: `v${v}`,
          origin: 0,
        });
      }

      this.#neighbours(a).push({ to: b, weight });
      this.#neighbours(b).push({ to: a, weight });
      this.#edges.push({ a: Math.min(a, b), b: Math.max(a, b), weight });
      events.push({
        kind: 'PointerSet',
        from: this.#id(a),
        slot: `e${b}`,
        to: this.#id(b),
        pointer: 'link',
        weight,
      });
    }

    // Sorted so that both algorithms see the same graph in the same order.
    for (const list of this.#adjacent.values()) {
      list.sort((x, y) => x.weight - y.weight || x.to - y.to);
    }
    events.push({ kind: 'RootsSet', roots: this.#vertices().map((v) => this.#id(v)) });

    return {
      ok: true,
      value: { vertices: this.#ids.size, edges: this.#edges.length, pieces: this.#pieces() },
      events,
      statsDelta: { nodesAllocated: this.#ids.size, updates: 1 },
    };
  }

  #report(
    chosen: readonly Edge[], events: SimEvent[], extra: Record<string, unknown>,
  ): OperationResult {
    const pieces = this.#pieces();
    return {
      ok: true,
      value: {
        total: chosen.reduce((sum, e) => sum + e.weight, 0),
        edges: chosen.map((e) => `${name(e)} (${e.weight})`),
        kept: chosen.length,
        // n - 1 edges for a connected graph, one fewer for each extra piece.
        spanning: chosen.length === this.#ids.size - pieces,
        pieces,
        ...extra,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: events.length },
    };
  }

  #primResult(): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);
    const events: SimEvent[] = [];
    const { chosen, scanned } = this.#prim(events);
    return this.#report(chosen, events, { scanned });
  }

  #kruskalResult(): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);
    const events: SimEvent[] = [];
    const { chosen, examined, rejected } = this.#kruskal(events);
    return this.#report(chosen, events, { examined, rejected });
  }

  #agree(): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);

    /*
     * The two are allowed to disagree about *which* edges whenever weights
     * tie - a graph can have several minimum spanning trees. What they may
     * never disagree about is the total.
     */
    const a = this.#prim([]);
    const b = this.#kruskal([]);
    const totalA = a.chosen.reduce((s, e) => s + e.weight, 0);
    const totalB = b.chosen.reduce((s, e) => s + e.weight, 0);
    const same = a.chosen.map(name).sort().join(' ') === b.chosen.map(name).sort().join(' ');

    return {
      ok: true,
      value: {
        prim: totalA,
        kruskal: totalB,
        agree: totalA === totalB,
        sameEdges: same,
        note: same
          ? 'the same edges, in this graph'
          : 'different edges of the same total, which ties allow',
      },
      events: [],
      statsDelta: { queries: 1 },
    };
  }

  /* ── Views ───────────────────────────────────────────────────────── */

  getStructure(): StructureGraph {
    const nodes: StructureNode[] = this.#vertices().map((v) => ({
      id: this.#id(v),
      label: `${v}`,
      value: v,
      role: 'vertex',
      slot: `v${v}`,
      origin: 0,
    }));
    const edges: StructureEdge[] = this.#edges.map((e) => ({
      from: this.#id(e.a),
      to: this.#id(e.b),
      slot: `e${e.b}`,
      reused: false,
      kind: 'link',
      weight: e.weight,
    }));

    return { layout: 'force', nodes, edges, roots: this.#vertices().map((v) => this.#id(v)) };
  }

  serialize(): SerializedState {
    return {
      schemaVersion: SCHEMA_VERSION,
      pluginId: 'mst',
      data: { edges: this.#edges.map((e) => [e.a, e.b, e.weight]) },
    };
  }
}

export const mst: AlgorithmPlugin = {
  meta: {
    id: 'mst',
    name: 'Minimum Spanning Tree',
    category: 'Graphs',
    summary: 'Two greedy strategies for the cheapest way to hold a graph together.',
  },
  commands: COMMANDS,
  explain: explainMst,
  benchmark: {
    sizes: [8, 16, 32, 64, 128, 256],
    command: 'prim',
    /**
     * A cycle plus a chord from the first vertex to every other, so the graph
     * is dense enough that scanning for the cheapest frontier entry - the part
     * that makes Prim quadratic - is what dominates.
     */
    setup: (n: number): readonly string[] => {
      const triples: number[] = [];
      for (let i = 1; i < n; i += 1) triples.push(i, i + 1, ((i * 7) % 19) + 1);
      for (let i = 3; i <= n; i += 1) triples.push(1, i, ((i * 11) % 23) + 5);
      return [`build [${triples.join(' ')}]`];
    },
    probes: (): readonly string[] => ['prim'],
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
