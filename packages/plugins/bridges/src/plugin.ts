/**
 * Bridges and cut vertices.
 *
 * Two questions with one answer: which single edge, if it broke, would split
 * the graph, and which single vertex, if it were lost, would do the same. They
 * are the same question asked of edges and of vertices, and one depth-first
 * walk settles both.
 *
 * ## What the walk knows
 *
 * A depth-first search over an undirected graph divides the edges into just two
 * kinds: the ones it descends through, and the ones that lead back to a vertex
 * it has already seen. There are no edges to a *finished* branch - if there
 * were, the search would have gone down them at the time. That is the fact
 * everything here rests on, and it is only true because the graph is
 * undirected.
 *
 * So for each vertex keep two numbers: when it was reached, and the earliest
 * arrival time reachable from its subtree, following any number of tree edges
 * down and at most one edge back up. Call the second one its **low** value.
 * Then:
 *
 *   - the edge from u down to v is a **bridge** exactly when nothing under v
 *     can get back to u or above it - `low[v] > disc[u]`. If anything could, it
 *     would form a cycle through the edge, and a cycle edge is never critical.
 *   - u is a **cut vertex** exactly when some child v cannot get *past* u -
 *     `low[v] >= disc[u]`. The difference is the equals sign: reaching u itself
 *     is enough to save the edge but not enough to save the vertex.
 *
 * The root of the search is the one exception, having no parent to be cut off
 * from: it is a cut vertex precisely when the walk had to start down into it
 * more than once.
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
import { explainBridges } from './explain.ts';

const SCHEMA_VERSION = 1;

interface Frame {
  readonly at: number;
  readonly parent: number | null;
  next: number;
  children: number;
}

interface Walk {
  readonly disc: Map<number, number>;
  readonly low: Map<number, number>;
  readonly bridges: [number, number][];
  readonly cuts: number[];
}

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Read pairs as undirected edges: [1 2 2 3] joins 1-2 and 2-3.',
    complexity: 'O(V + E)',
    params: [{ name: 'pairs', kind: 'int-list' }],
  },
  {
    name: 'bridges',
    summary: 'Edges that no cycle passes through, so losing one splits the graph.',
    complexity: 'O(V + E)',
    params: [],
  },
  {
    name: 'cuts',
    summary: 'Vertices whose loss would split the graph.',
    complexity: 'O(V + E)',
    params: [],
  },
  {
    name: 'numbers',
    summary: 'When each vertex was reached, and how far back its subtree can get.',
    complexity: 'O(V + E)',
    params: [],
  },
];

function err(code: OperationError['code'], message: string, hint?: string): OperationError {
  return { code, message, ...(hint === undefined ? {} : { hint }) };
}

class Instance implements PluginInstance {
  #ids = new Map<number, NodeId>();
  #adjacent = new Map<number, number[]>();
  #edges: [number, number][] = [];
  #next = 0;

  reset(): void {
    this.#ids = new Map();
    this.#adjacent = new Map();
    this.#edges = [];
    this.#next = 0;
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getIntList(cmd, 'pairs'));
      case 'bridges': return this.#bridges();
      case 'cuts': return this.#cuts();
      case 'numbers': return this.#numbers();
      default:
        return failed(err('PARSE_ERROR', `This plugin does not handle "${cmd.name}".`));
    }
  }

  /* ── Helpers ─────────────────────────────────────────────────────── */

  #ready(): OperationError | null {
    return this.#ids.size === 0
      ? err('PRECONDITION_FAILED', 'No graph has been built yet.',
        'start with build, as in: build [1 2 2 3 3 1 3 4]')
      : null;
  }

  #vertices(): number[] {
    return [...this.#ids.keys()].sort((a, b) => a - b);
  }

  #id(v: number): NodeId {
    return this.#ids.get(v) as NodeId;
  }

  #neighbours(v: number): number[] {
    return this.#adjacent.get(v) ?? [];
  }

  /* ── The walk ────────────────────────────────────────────────────── */

  /**
   * One depth-first pass, iterative.
   *
   * Iterative because a graph read from input can be a straight line, and a
   * line long enough to be interesting is long enough to exhaust the call
   * stack - the same reason every other walk in this repository is written
   * this way.
   *
   * The parent is skipped by *vertex*, which is only correct because `build`
   * refuses a repeated pair. With two edges between the same vertices, one of
   * them is a genuine way back and skipping both would invent a bridge.
   */
  #walk(events: SimEvent[]): Walk {
    const disc = new Map<number, number>();
    const low = new Map<number, number>();
    const bridges: [number, number][] = [];
    const cuts = new Set<number>();
    let timer = 0;

    for (const root of this.#vertices()) {
      if (disc.has(root)) continue;
      disc.set(root, timer);
      low.set(root, timer);
      timer += 1;
      events.push({ kind: 'NodeVisited', node: this.#id(root) });
      const stack: Frame[] = [{ at: root, parent: null, next: 0, children: 0 }];

      while (stack.length > 0) {
        const frame = stack[stack.length - 1] as Frame;
        const neighbours = this.#neighbours(frame.at);

        if (frame.next < neighbours.length) {
          const other = neighbours[frame.next] as number;
          frame.next += 1;
          if (other === frame.parent) continue;

          if (!disc.has(other)) {
            disc.set(other, timer);
            low.set(other, timer);
            timer += 1;
            frame.children += 1;
            events.push({ kind: 'NodeVisited', node: this.#id(other) });
            stack.push({ at: other, parent: frame.at, next: 0, children: 0 });
          } else {
            // An edge back to something already reached: the subtree can climb
            // to wherever that was, but no further in one step.
            low.set(frame.at, Math.min(low.get(frame.at) as number, disc.get(other) as number));
          }
          continue;
        }

        stack.pop();
        const above = stack[stack.length - 1];
        if (above === undefined) {
          // The root has no parent to be separated from, so the only way it
          // matters is by holding two otherwise unconnected branches together.
          if (frame.children >= 2) cuts.add(frame.at);
          continue;
        }

        const lowChild = low.get(frame.at) as number;
        low.set(above.at, Math.min(low.get(above.at) as number, lowChild));
        if (lowChild > (disc.get(above.at) as number)) {
          bridges.push([Math.min(above.at, frame.at), Math.max(above.at, frame.at)]);
        }
        // Note the >= rather than >: getting back to `above` itself saves the
        // edge, because the cycle runs through it, but not the vertex.
        if (above.parent !== null && lowChild >= (disc.get(above.at) as number)) {
          cuts.add(above.at);
        }
      }
    }

    return {
      disc, low, bridges,
      cuts: [...cuts].sort((a, b) => a - b),
    };
  }

  /* ── Commands ────────────────────────────────────────────────────── */

  #build(pairs: readonly number[]): OperationResult {
    if (pairs.length === 0 || pairs.length % 2 !== 0) {
      return failed(err('BAD_ARGUMENT',
        `An edge list needs an even number of vertices; ${pairs.length} given.`,
        'each pair is one edge, so [1 2 2 3] joins 1-2 and 2-3'));
    }

    this.reset();
    const events: SimEvent[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < pairs.length; i += 2) {
      const a = pairs[i] as number;
      const b = pairs[i + 1] as number;
      if (a === b) {
        this.reset();
        return failed(err('PRECONDITION_FAILED', `Vertex ${a} cannot be joined to itself.`,
          'a self edge is its own cycle, so it could never be a bridge'));
      }
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (seen.has(key)) {
        this.reset();
        return failed(err('PRECONDITION_FAILED', `The edge ${a}-${b} is given twice.`,
          'two edges between the same pair form a cycle, and the walk here skips '
          + 'the parent by vertex - so it would report a bridge that is not one'));
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

      this.#neighbours(a).push(b);
      this.#neighbours(b).push(a);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      this.#edges.push([lo, hi]);
      /*
       * Logged low-to-high, which is how the structure reports it too. An
       * undirected edge has one identity, and if the log names it by the order
       * it happened to be typed in, the replayed picture grows an edge the
       * live one does not have.
       */
      events.push({
        kind: 'PointerSet', from: this.#id(lo), slot: `e${hi}`, to: this.#id(hi), pointer: 'link',
      });
    }

    // Sorted so the walk, and therefore every answer, is reproducible.
    for (const list of this.#adjacent.values()) list.sort((x, y) => x - y);
    events.push({ kind: 'RootsSet', roots: this.#vertices().map((v) => this.#id(v)) });

    return {
      ok: true,
      value: { vertices: this.#ids.size, edges: this.#edges.length },
      events,
      statsDelta: { nodesAllocated: this.#ids.size, updates: 1 },
    };
  }

  #bridges(): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);

    const events: SimEvent[] = [];
    const walk = this.#walk(events);
    const found = walk.bridges.slice().sort((x, y) => x[0] - y[0] || x[1] - y[1]);

    return {
      ok: true,
      value: {
        count: found.length,
        edges: found.map(([a, b]) => `${a}-${b}`),
        of: this.#edges.length,
        // Every edge a bridge means no cycles anywhere - the graph is a forest.
        forest: found.length === this.#edges.length,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: events.length },
    };
  }

  #cuts(): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);

    const events: SimEvent[] = [];
    const walk = this.#walk(events);

    return {
      ok: true,
      value: {
        count: walk.cuts.length,
        vertices: walk.cuts,
        of: this.#ids.size,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: events.length },
    };
  }

  #numbers(): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);

    const walk = this.#walk([]);
    return {
      ok: true,
      value: {
        rows: this.#vertices().map((v) => ({
          vertex: v,
          reachedAt: walk.disc.get(v) ?? null,
          canGetBackTo: walk.low.get(v) ?? null,
          // A vertex whose subtree cannot climb past its own arrival is the
          // top of something the rest of the graph reaches only through it.
          topOfItsOwn: walk.low.get(v) === walk.disc.get(v),
        })),
      },
      events: this.#vertices().map((v): SimEvent => ({ kind: 'NodeVisited', node: this.#id(v) })),
      statsDelta: { queries: 1, nodeVisits: this.#ids.size },
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
    const edges: StructureEdge[] = this.#edges.map(([a, b]) => ({
      from: this.#id(a),
      to: this.#id(b),
      slot: `e${b}`,
      reused: false,
      kind: 'link',
    }));

    return { layout: 'force', nodes, edges, roots: this.#vertices().map((v) => this.#id(v)) };
  }

  serialize(): SerializedState {
    return {
      schemaVersion: SCHEMA_VERSION,
      pluginId: 'bridges',
      data: { edges: this.#edges.map(([a, b]) => [a, b]) },
    };
  }
}

export const bridges: AlgorithmPlugin = {
  meta: {
    id: 'bridges',
    name: 'Bridges and Cut Vertices',
    category: 'Graphs',
    summary: 'The single edges and single vertices a graph cannot afford to lose.',
  },
  commands: COMMANDS,
  explain: explainBridges,
  benchmark: {
    sizes: [8, 16, 32, 64, 128, 256],
    command: 'bridges',
    /**
     * Triangles strung together in a line. Every edge inside a triangle sits
     * on a cycle and is safe; every edge joining two of them is a bridge - so
     * the answer grows with the graph rather than being all or nothing.
     */
    setup: (n: number): readonly string[] => {
      const pairs: number[] = [];
      for (let i = 1; i + 2 <= n; i += 3) {
        pairs.push(i, i + 1, i + 1, i + 2, i + 2, i);
        if (i + 3 <= n) pairs.push(i + 2, i + 3);
      }
      return [`build [${pairs.join(' ')}]`];
    },
    probes: (): readonly string[] => ['bridges'],
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
