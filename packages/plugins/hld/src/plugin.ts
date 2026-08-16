/**
 * Heavy-light decomposition.
 *
 * A path between two vertices of a tree can be n vertices long, so answering
 * a question about it by walking costs O(n). This cuts the tree into chains
 * and lays them end to end in one array, so that any path is a handful of
 * contiguous ranges of that array rather than a walk.
 *
 * The rule is one line: from each vertex, the edge to its largest child is
 * heavy, and every other edge is light. Everything follows from it. Going down
 * a light edge at least halves the subtree you are in - if it did not, that
 * child would have been the largest and the edge would be heavy - so no
 * root-to-leaf path can cross more than log2(n) light edges. A path is a run
 * along a chain, a step up a light edge, a run along the next chain, and so on:
 * O(log n) ranges, each answered by a segment tree in O(log n).
 *
 * That is where the O(log² n) comes from, and it is worth saying that the
 * decomposition itself is not a data structure. It is a way of arranging the
 * vertices so that an ordinary segment tree can answer questions about paths.
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
import { explainHld } from './explain.ts';

const SCHEMA_VERSION = 1;

interface Vertex {
  readonly id: NodeId;
  readonly label: number;
  parent: NodeId | null;
  children: NodeId[];
  /** The child with the largest subtree. The edge to it is the heavy one. */
  heavy: NodeId | null;
  size: number;
  depth: number;
  /** The topmost vertex of this vertex's chain. */
  head: NodeId;
  /** Where this vertex sits in the flattened array. */
  position: number;
  chain: number;
  value: number;
}

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Read pairs as tree edges and decompose, rooting at the lowest label.',
    complexity: 'O(n)',
    params: [{ name: 'pairs', kind: 'int-list' }],
  },
  {
    name: 'set',
    summary: 'Give a vertex a value. Every vertex starts at 1.',
    complexity: 'O(log n)',
    params: [
      { name: 'vertex', kind: 'int' },
      { name: 'value', kind: 'int' },
    ],
  },
  {
    name: 'path',
    // What is declared is what the log can show: the number of contiguous
    // ranges the path breaks into. Each is then one segment tree query, so a
    // total costs O(log² n) - but that second logarithm happens inside an
    // array with no nodes to visit, so no event can honestly report it.
    summary: 'Break the path between two vertices into contiguous ranges and total them.',
    complexity: 'O(log n)',
    params: [
      { name: 'a', kind: 'int' },
      { name: 'b', kind: 'int' },
    ],
  },
  {
    name: 'lca',
    summary: 'The deepest vertex that is above both, found by climbing chains.',
    complexity: 'O(log n)',
    params: [
      { name: 'a', kind: 'int' },
      { name: 'b', kind: 'int' },
    ],
  },
  {
    name: 'chains',
    summary: 'Report the chains the tree was cut into.',
    complexity: 'O(n)',
    params: [],
  },
];

function err(code: OperationError['code'], message: string, hint?: string): OperationError {
  return { code, message, ...(hint === undefined ? {} : { hint }) };
}

class Instance implements PluginInstance {
  #ids = new Map<number, NodeId>();
  #v = new Map<NodeId, Vertex>();
  #root: NodeId | null = null;
  /** Vertex at each position of the flattened array. */
  #flat: NodeId[] = [];
  /** Sums over the flattened array. One-based, size a power of two. */
  #tree: number[] = [];
  #width = 1;
  #chainCount = 0;

  reset(): void {
    this.#ids = new Map();
    this.#v = new Map();
    this.#root = null;
    this.#flat = [];
    this.#tree = [];
    this.#width = 1;
    this.#chainCount = 0;
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getIntList(cmd, 'pairs'));
      case 'set': return this.#set(getInt(cmd, 'vertex'), getInt(cmd, 'value'));
      case 'path': return this.#path(getInt(cmd, 'a'), getInt(cmd, 'b'));
      case 'lca': return this.#lca(getInt(cmd, 'a'), getInt(cmd, 'b'));
      case 'chains': return this.#chains();
      default:
        return failed(err('PARSE_ERROR', `This plugin does not handle "${cmd.name}".`));
    }
  }

  /* ── Helpers ─────────────────────────────────────────────────────── */

  #get(id: NodeId): Vertex {
    const v = this.#v.get(id);
    if (v === undefined) throw new Error(`missing vertex ${id}`);
    return v;
  }

  #known(): string {
    const labels = [...this.#ids.keys()].sort((a, b) => a - b);
    return labels.length === 0
      ? 'nothing has been built yet - start with build'
      : `vertices: ${labels.join(', ')}`;
  }

  #lookup(label: number): NodeId | null {
    return this.#ids.get(label) ?? null;
  }

  /* ── The segment tree over the flattened order ───────────────────── */

  #buildSums(): void {
    this.#width = 1;
    while (this.#width < Math.max(1, this.#flat.length)) this.#width *= 2;
    this.#tree = new Array<number>(this.#width * 2).fill(0);
    for (let i = 0; i < this.#flat.length; i += 1) {
      this.#tree[this.#width + i] = this.#get(this.#flat[i] as NodeId).value;
    }
    for (let i = this.#width - 1; i >= 1; i -= 1) {
      this.#tree[i] = (this.#tree[i * 2] as number) + (this.#tree[i * 2 + 1] as number);
    }
  }

  #assign(position: number, value: number): void {
    let i = this.#width + position;
    this.#tree[i] = value;
    for (i = Math.floor(i / 2); i >= 1; i = Math.floor(i / 2)) {
      this.#tree[i] = (this.#tree[i * 2] as number) + (this.#tree[i * 2 + 1] as number);
    }
  }

  /** Sum over positions [from, to], inclusive. */
  #rangeSum(from: number, to: number): number {
    let total = 0;
    let l = this.#width + from;
    let r = this.#width + to + 1;
    while (l < r) {
      if ((l & 1) === 1) { total += this.#tree[l] as number; l += 1; }
      if ((r & 1) === 1) { r -= 1; total += this.#tree[r] as number; }
      l = Math.floor(l / 2);
      r = Math.floor(r / 2);
    }
    return total;
  }

  /* ── The decomposition ───────────────────────────────────────────── */

  /**
   * Sizes and heavy children, computed without recursion.
   *
   * A tree read from user input can be a straight line, and a line deep enough
   * to be interesting is deep enough to exhaust the call stack. Every walk
   * here is iterative for that reason.
   */
  #measure(root: NodeId): void {
    const order: NodeId[] = [];
    const stack = [root];
    while (stack.length > 0) {
      const id = stack.pop() as NodeId;
      order.push(id);
      for (const c of this.#get(id).children) stack.push(c);
    }
    // Children before parents, so a size is final before it is used.
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const v = this.#get(order[i] as NodeId);
      v.size = 1;
      v.heavy = null;
      let best = 0;
      for (const c of v.children) {
        const child = this.#get(c);
        v.size += child.size;
        if (child.size > best) { best = child.size; v.heavy = c; }
      }
    }
  }

  /**
   * Lays the chains out end to end.
   *
   * A chain is walked to its end before any light child is started, which is
   * what puts a whole chain in one contiguous run of the array. That is the
   * only property the path query needs.
   */
  #decompose(root: NodeId): void {
    this.#flat = [];
    this.#chainCount = 0;
    const pending: { id: NodeId; head: NodeId }[] = [{ id: root, head: root }];

    while (pending.length > 0) {
      const start = pending.pop() as { id: NodeId; head: NodeId };
      const chain = this.#chainCount;
      this.#chainCount += 1;

      let cursor: NodeId | null = start.id;
      while (cursor !== null) {
        const v = this.#get(cursor);
        v.head = start.head;
        v.chain = chain;
        v.position = this.#flat.length;
        this.#flat.push(cursor);
        // Every light child begins a chain of its own.
        for (const c of v.children) {
          if (c !== v.heavy) pending.push({ id: c, head: c });
        }
        cursor = v.heavy;
      }
    }
  }

  /* ── Commands ────────────────────────────────────────────────────── */

  #build(pairs: readonly number[]): OperationResult {
    if (pairs.length % 2 !== 0) {
      return failed(err('BAD_ARGUMENT',
        `An edge list needs an even number of vertices; ${pairs.length} given.`,
        'each pair is one edge, so [1 2 1 3] hangs 2 and 3 under 1'));
    }
    if (pairs.length === 0) {
      return failed(err('BAD_ARGUMENT', 'A tree needs at least one edge.',
        'try build [1 2 1 3 2 4]'));
    }

    this.reset();
    const events: SimEvent[] = [];

    // Vertices first, so the tree can be checked before anything is committed.
    const labels = [...new Set(pairs)].sort((a, b) => a - b);
    let next = 0;
    for (const label of labels) {
      const id = next as NodeId;
      next += 1;
      this.#ids.set(label, id);
      this.#v.set(id, {
        id, label, parent: null, children: [], heavy: null,
        size: 1, depth: 0, head: id, position: 0, chain: 0, value: 1,
      });
    }

    const adjacency = new Map<NodeId, NodeId[]>();
    for (const id of this.#v.keys()) adjacency.set(id, []);
    const seen = new Set<string>();
    for (let i = 0; i < pairs.length; i += 2) {
      const a = this.#lookup(pairs[i] as number) as NodeId;
      const b = this.#lookup(pairs[i + 1] as number) as NodeId;
      if (a === b) {
        this.reset();
        return failed(err('PRECONDITION_FAILED', `Vertex ${pairs[i]} cannot be its own parent.`,
          'a tree has no loops'));
      }
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (seen.has(key)) {
        this.reset();
        return failed(err('PRECONDITION_FAILED',
          `The edge ${pairs[i]}-${pairs[i + 1]} is given twice.`,
          'a tree has one path between any two vertices, so an edge cannot repeat'));
      }
      seen.add(key);
      (adjacency.get(a) as NodeId[]).push(b);
      (adjacency.get(b) as NodeId[]).push(a);
    }

    if (seen.size !== this.#v.size - 1) {
      const n = this.#v.size;
      this.reset();
      return failed(err('PRECONDITION_FAILED',
        `A tree on ${n} vertices has ${n - 1} edges; ${seen.size} were given.`,
        seen.size >= n ? 'this graph has a cycle' : 'this graph is not connected'));
    }

    // Root at the lowest label and hang the tree off it. Iterative, because a
    // path graph on a few thousand vertices is a perfectly ordinary input.
    const root = this.#lookup(labels[0] as number) as NodeId;
    this.#root = root;
    const visited = new Set<NodeId>([root]);
    const queue = [root];
    while (queue.length > 0) {
      const id = queue.shift() as NodeId;
      const v = this.#get(id);
      for (const other of adjacency.get(id) as NodeId[]) {
        if (visited.has(other)) continue;
        visited.add(other);
        const child = this.#get(other);
        child.parent = id;
        child.depth = v.depth + 1;
        v.children.push(other);
        queue.push(other);
      }
    }
    if (visited.size !== this.#v.size) {
      const missing = this.#v.size - visited.size;
      this.reset();
      return failed(err('PRECONDITION_FAILED',
        `${missing} vertices cannot be reached from ${labels[0]}.`,
        'this graph is not connected, so it is not a tree'));
    }
    // Sorted so the decomposition is the same every run, whatever order the
    // edges arrived in. Ties for the heavy child then break on the lowest label.
    for (const v of this.#v.values()) {
      v.children.sort((a, b) => this.#get(a).label - this.#get(b).label);
    }

    this.#measure(root);
    this.#decompose(root);
    this.#buildSums();

    for (const id of this.#flat) {
      const v = this.#get(id);
      events.push({
        kind: 'NodeAllocated',
        node: id,
        value: v.label,
        label: `${v.label}`,
        role: v.head === id ? 'chain head' : 'chain',
        depth: v.depth,
        slot: `v${v.label}`,
        origin: 0,
        // The chain, not the generation: this structure has no history, and
        // the decomposition is the only thing worth seeing in it.
        group: v.chain,
      });
    }
    for (const id of this.#flat) {
      const v = this.#get(id);
      for (const c of v.children) {
        events.push({
          kind: 'PointerSet',
          from: id,
          slot: c === v.heavy ? 'heavy' : 'light',
          to: c,
        });
      }
    }
    events.push({ kind: 'RootsSet', roots: [root] });

    const sizes = this.#chainSizes();
    return {
      ok: true,
      value: {
        vertices: this.#v.size,
        root: this.#get(root).label,
        chains: this.#chainCount,
        longestChain: Math.max(...sizes),
        depth: Math.max(...[...this.#v.values()].map((v) => v.depth)) + 1,
      },
      events,
      statsDelta: { nodesAllocated: this.#v.size, updates: 1 },
    };
  }

  #chainSizes(): number[] {
    const sizes = new Array<number>(this.#chainCount).fill(0);
    for (const v of this.#v.values()) sizes[v.chain] = (sizes[v.chain] as number) + 1;
    return sizes;
  }

  #set(label: number, value: number): OperationResult {
    const id = this.#lookup(label);
    if (id === null) return failed(err('UNKNOWN_VERSION', `There is no vertex ${label}.`, this.#known()));
    const v = this.#get(id);
    const was = v.value;
    v.value = value;
    this.#assign(v.position, value);
    return {
      ok: true,
      value: { vertex: label, was, now: value, position: v.position },
      events: [{ kind: 'NodeVisited', node: id }],
      statsDelta: { updates: 1, nodeVisits: 1 },
    };
  }

  /**
   * Climbs both vertices to a common chain, then reads the ranges.
   *
   * At each step the one whose chain starts deeper jumps to just above its
   * chain head - one light edge - so the number of jumps is the number of
   * light edges between them, which is at most 2*log2(n).
   */
  #walk(a: NodeId, b: NodeId, events: SimEvent[]): { ranges: [number, number][]; meet: NodeId } {
    const ranges: [number, number][] = [];
    let x = a;
    let y = b;

    while (this.#get(x).head !== this.#get(y).head) {
      const hx = this.#get(this.#get(x).head);
      const hy = this.#get(this.#get(y).head);
      if (hx.depth < hy.depth) { const t = x; x = y; y = t; }
      const head = this.#get(this.#get(x).head);
      ranges.push([head.position, this.#get(x).position]);
      // The two ends of the range, not everything between them. Walking the
      // range would cost what the decomposition exists to avoid: a path down
      // one chain can be n vertices long, and the point is not to touch them.
      events.push({ kind: 'NodeVisited', node: x });
      events.push({ kind: 'NodeVisited', node: head.id });
      x = head.parent as NodeId;
    }

    // Same chain now, so the rest is one contiguous run.
    const [low, high] = this.#get(x).position <= this.#get(y).position ? [x, y] : [y, x];
    ranges.push([this.#get(low).position, this.#get(high).position]);
    events.push({ kind: 'NodeVisited', node: high });
    events.push({ kind: 'NodeVisited', node: low });
    return { ranges, meet: low };
  }

  #path(a: number, b: number): OperationResult {
    const ia = this.#lookup(a);
    const ib = this.#lookup(b);
    if (ia === null || ib === null) {
      return failed(err('UNKNOWN_VERSION', `There is no vertex ${ia === null ? a : b}.`, this.#known()));
    }

    const events: SimEvent[] = [];
    const { ranges, meet } = this.#walk(ia, ib, events);
    let total = 0;
    for (const [from, to] of ranges) total += this.#rangeSum(from, to);
    const vertices = ranges.reduce((n, [from, to]) => n + (to - from + 1), 0);
    const visits = events.length;

    return {
      ok: true,
      value: {
        from: a, to: b, total, vertices,
        meetsAt: this.#get(meet).label,
        // The point of the whole decomposition: a path of any length is this
        // few contiguous pieces, and each is one segment tree query.
        ranges: ranges.length,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: visits },
    };
  }

  #lca(a: number, b: number): OperationResult {
    const ia = this.#lookup(a);
    const ib = this.#lookup(b);
    if (ia === null || ib === null) {
      return failed(err('UNKNOWN_VERSION', `There is no vertex ${ia === null ? a : b}.`, this.#known()));
    }

    const events: SimEvent[] = [];
    let x = ia;
    let y = ib;
    let jumps = 0;
    while (this.#get(x).head !== this.#get(y).head) {
      const hx = this.#get(this.#get(x).head);
      const hy = this.#get(this.#get(y).head);
      if (hx.depth < hy.depth) { const t = x; x = y; y = t; }
      const head = this.#get(this.#get(x).head);
      events.push({ kind: 'NodeVisited', node: head.id });
      jumps += 1;
      x = head.parent as NodeId;
    }
    const meet = this.#get(x).depth <= this.#get(y).depth ? x : y;
    events.push({ kind: 'NodeVisited', node: meet });

    return {
      ok: true,
      value: {
        a, b, lca: this.#get(meet).label,
        depth: this.#get(meet).depth,
        // One jump is one light edge, and there are at most log2(n) of those.
        lightEdgesCrossed: jumps,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: jumps + 1 },
    };
  }

  #chains(): OperationResult {
    if (this.#root === null) {
      return failed(err('PRECONDITION_FAILED', 'Nothing has been built yet.', this.#known()));
    }
    const groups: number[][] = Array.from({ length: this.#chainCount }, () => []);
    for (const id of this.#flat) {
      const v = this.#get(id);
      (groups[v.chain] as number[]).push(v.label);
    }
    return {
      ok: true,
      value: {
        chains: this.#chainCount,
        groups,
        longest: Math.max(...groups.map((g) => g.length)),
        // A chain of one vertex is a leaf hanging off a light edge; the tree
        // is worth decomposing exactly when most chains are longer than that.
        singletons: groups.filter((g) => g.length === 1).length,
      },
      events: this.#flat.map((id): SimEvent => ({ kind: 'NodeVisited', node: id })),
      statsDelta: { queries: 1, nodeVisits: this.#flat.length },
    };
  }

  /* ── Views ───────────────────────────────────────────────────────── */

  getStructure(): StructureGraph {
    const nodes: StructureNode[] = [];
    const edges: StructureEdge[] = [];

    for (const id of this.#flat) {
      const v = this.#get(id);
      nodes.push({
        id,
        label: `${v.label}`,
        value: v.label,
        role: v.head === id ? 'chain head' : 'chain',
        depth: v.depth,
        slot: `v${v.label}`,
        origin: 0,
        group: v.chain,
      });
      for (const c of v.children) {
        edges.push({
          from: id, to: c,
          slot: c === v.heavy ? 'heavy' : 'light',
          reused: false,
        });
      }
    }

    return {
      layout: 'dag',
      nodes,
      edges,
      roots: this.#root === null ? [] : [this.#root],
    };
  }

  serialize(): SerializedState {
    return {
      schemaVersion: SCHEMA_VERSION,
      pluginId: 'hld',
      data: {
        edges: [...this.#v.values()]
          .filter((v) => v.parent !== null)
          .map((v) => [this.#get(v.parent as NodeId).label, v.label])
          .sort((a, b) => (a[0] as number) - (b[0] as number) || (a[1] as number) - (b[1] as number)),
        values: [...this.#v.values()]
          .sort((a, b) => a.label - b.label)
          .map((v) => [v.label, v.value]),
      },
    };
  }
}

export const hld: AlgorithmPlugin = {
  meta: {
    id: 'hld',
    name: 'Heavy-Light Decomposition',
    category: 'Advanced',
    summary: 'Cut a tree into chains so that any path is a handful of contiguous ranges.',
  },
  commands: COMMANDS,
  explain: explainHld,
  benchmark: {
    sizes: [8, 16, 32, 64, 128, 256],
    command: 'path',
    /**
     * A complete binary tree. A path graph would be one single chain, which
     * makes every query a single range and hides the thing being measured; a
     * balanced tree gives the decomposition something to actually do.
     */
    setup: (n: number): readonly string[] => {
      const pairs: number[] = [];
      for (let i = 2; i <= n; i += 1) pairs.push(Math.floor(i / 2), i);
      return [`build [${pairs.join(' ')}]`];
    },
    /**
     * From the root down the all-right spine. The heavy child is the larger
     * subtree, and ties break to the left, so every step to a right child is a
     * light edge and starts a new chain - one range per level, which is the
     * quantity being measured.
     *
     * An earlier probe took a path between two leaves half the tree apart. It
     * looks like the longest path in the tree and is not the deepest in
     * *chains*: both ends sat on the same spine, so it crossed two chains at
     * every size and measured a constant.
     */
    probes: (n: number): readonly string[] =>
      [`path 1 ${2 ** Math.floor(Math.log2(n + 1)) - 1}`],
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
