/**
 * Euler tour tree.
 *
 * Heavy-light decomposition flattens a tree so that a *path* is a few
 * contiguous ranges, and cannot survive the tree changing shape. This
 * flattens a forest so that a *subtree* is one contiguous range, and is built
 * to be cut apart and joined back together.
 *
 * The tour of a tree rooted at r is
 *
 *     tour(r) = for each child c: [r->c] tour(c) [c->r]
 *
 * so it is *edges only*: each edge appears twice, once per direction, and a
 * tree of k vertices is 2(k-1) entries. A vertex on its own has no edges, so
 * it gets one entry of its own - the only reason a vertex is ever written
 * down. Three facts make the whole structure work, and each turns an
 * operation on a tree into an operation on a sequence:
 *
 *   - Everything between the two occurrences of an edge is exactly the subtree
 *     hanging below it. So **cut** is: take out that block.
 *   - Rotating the sequence to start at an edge leaving v gives the tour of
 *     the same tree rooted at v. So **reroot** is: split and swap the halves.
 *
 *     This is why the entries are edges. Writing each vertex down as well is
 *     the obvious encoding and it does not survive rotation: a vertex has to
 *     be written where it is first reached, and rotating changes which edge
 *     reaches it first, so the old root's entry ends up somewhere the walk
 *     has already been. Edges have no such position to be wrong about.
 *   - Two vertices are in the same tree exactly when their occurrences are in
 *     the same sequence. So **connected** is: same sequence?
 *
 * The sequence is held in a treap keyed by position rather than by value, so
 * splitting and joining are O(log n) expected and the last question is
 * answered by walking to the root. An array would make every one of those a
 * copy, which would be the Euler tour technique without the tree.
 */

import {
  getInt, getIntList,
  type CommandSpec, type NodeId, type OperationError, type ParsedCommand, type Rng, type SimEvent,
} from '@algoverse/core';
import {
  failed,
  type AlgorithmPlugin, type EngineContext, type OperationResult,
  type PluginInstance, type SerializedState,
  type StructureEdge, type StructureGraph, type StructureNode,
} from '@algoverse/plugin-sdk';
import { explainEuler } from './explain.ts';

const SCHEMA_VERSION = 1;

/** One entry of the tour: an edge being crossed, or a lone vertex. */
interface Occurrence {
  readonly id: NodeId;
  readonly priority: number;
  /** Where the crossing arrives; the vertex itself, when it stands alone. */
  readonly vertex: number;
  /** Where the crossing left from, or null for a vertex with no edges. */
  readonly from: number | null;
  left: NodeId | null;
  right: NodeId | null;
  parent: NodeId | null;
  size: number;
}

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Read pairs as forest edges. Any acyclic graph will do; it need not be connected.',
    complexity: 'O(n log n)',
    params: [{ name: 'pairs', kind: 'int-list' }],
  },
  {
    name: 'link',
    summary: 'Join two trees with an edge, splicing their tours together.',
    complexity: 'O(log n)',
    params: [
      { name: 'a', kind: 'int' },
      { name: 'b', kind: 'int' },
    ],
  },
  {
    name: 'cut',
    summary: 'Remove an edge, lifting the subtree between its two occurrences out.',
    complexity: 'O(log n)',
    params: [
      { name: 'a', kind: 'int' },
      { name: 'b', kind: 'int' },
    ],
  },
  {
    name: 'connected',
    summary: 'Ask whether two vertices are in the same tree.',
    complexity: 'O(log n)',
    params: [
      { name: 'a', kind: 'int' },
      { name: 'b', kind: 'int' },
    ],
  },
  {
    name: 'tour',
    summary: 'Read out the Euler tour of the tree holding a vertex.',
    complexity: 'O(n)',
    params: [{ name: 'a', kind: 'int' }],
  },
];

function err(code: OperationError['code'], message: string, hint?: string): OperationError {
  return { code, message, ...(hint === undefined ? {} : { hint }) };
}

const edgeKey = (a: number, b: number): string => `${a}>${b}`;

class Instance implements PluginInstance {
  #rng: Rng;
  #nodes = new Map<NodeId, Occurrence>();
  /** Who each vertex is joined to. Kept so a representative is O(1) to find. */
  #adjacent = new Map<number, Set<number>>();
  /** Both occurrences of each edge, one per direction. */
  #edgeAt = new Map<string, NodeId>();
  /** An entry for a vertex with no edges, which has none of its own. */
  #aloneAt = new Map<number, NodeId>();
  /** Pointer changes for the operation in flight. */
  #pending: SimEvent[] = [];
  #next = 0;

  constructor(rng: Rng) {
    this.#rng = rng;
  }

  reset(): void {
    this.#nodes = new Map();
    this.#adjacent = new Map();
    this.#edgeAt = new Map();
    this.#aloneAt = new Map();
    this.#pending = [];
    this.#next = 0;
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getIntList(cmd, 'pairs'));
      case 'link': return this.#link(getInt(cmd, 'a'), getInt(cmd, 'b'));
      case 'cut': return this.#cut(getInt(cmd, 'a'), getInt(cmd, 'b'));
      case 'connected': return this.#connected(getInt(cmd, 'a'), getInt(cmd, 'b'));
      case 'tour': return this.#tour(getInt(cmd, 'a'));
      default:
        return failed(err('PARSE_ERROR', `This plugin does not handle "${cmd.name}".`));
    }
  }

  /* ── The treap, keyed by position ────────────────────────────────── */

  #get(id: NodeId): Occurrence {
    const n = this.#nodes.get(id);
    if (n === undefined) throw new Error(`missing occurrence ${id}`);
    return n;
  }

  #size(id: NodeId | null): number {
    return id === null ? 0 : this.#get(id).size;
  }

  /*
   * Every change to a child pointer is logged. Splitting and joining rearrange
   * the treap constantly, and a log that does not say so replays as a heap of
   * disconnected entries - the picture has to be reconstructable from the log
   * alone, not from asking the plugin afterwards.
   */
  /*
   * The parent link is always restored, and only the event is conditional.
   * Merging detaches a subtree before handing it back, so "the pointer already
   * says this" does not mean "there is nothing to do" - the child may have been
   * orphaned a moment ago and be about to be adopted by the same node again.
   */
  #setLeft(id: NodeId, child: NodeId | null): void {
    const n = this.#get(id);
    const changed = n.left !== child;
    n.left = child;
    if (child !== null) this.#get(child).parent = id;
    if (changed) this.#pending.push({ kind: 'PointerSet', from: id, slot: 'left', to: child });
  }

  #setRight(id: NodeId, child: NodeId | null): void {
    const n = this.#get(id);
    const changed = n.right !== child;
    n.right = child;
    if (child !== null) this.#get(child).parent = id;
    if (changed) this.#pending.push({ kind: 'PointerSet', from: id, slot: 'right', to: child });
  }

  #update(id: NodeId): void {
    const n = this.#get(id);
    n.size = 1 + this.#size(n.left) + this.#size(n.right);
  }

  #detach(id: NodeId | null): NodeId | null {
    if (id !== null) this.#get(id).parent = null;
    return id;
  }

  #merge(a: NodeId | null, b: NodeId | null): NodeId | null {
    if (a === null) return this.#detach(b);
    if (b === null) return this.#detach(a);
    if (this.#get(a).priority > this.#get(b).priority) {
      this.#setRight(a, this.#merge(this.#get(a).right, b));
      this.#update(a);
      return this.#detach(a);
    }
    this.#setLeft(b, this.#merge(a, this.#get(b).left));
    this.#update(b);
    return this.#detach(b);
  }

  /** First `k` entries to the left, the rest to the right. */
  #split(t: NodeId | null, k: number): [NodeId | null, NodeId | null] {
    if (t === null) return [null, null];
    const node = this.#get(t);
    const leftSize = this.#size(node.left);
    if (leftSize >= k) {
      const [l, r] = this.#split(node.left, k);
      this.#setLeft(t, r);
      this.#update(t);
      return [this.#detach(l), this.#detach(t)];
    }
    const [l, r] = this.#split(node.right, k - leftSize - 1);
    this.#setRight(t, l);
    this.#update(t);
    return [this.#detach(t), this.#detach(r)];
  }

  /** Walks to the top. This is the whole of the connectivity question. */
  #rootOf(id: NodeId, events?: SimEvent[]): NodeId {
    let cur = id;
    for (;;) {
      events?.push({ kind: 'NodeVisited', node: cur });
      const parent = this.#get(cur).parent;
      if (parent === null) return cur;
      cur = parent;
    }
  }

  /** Where an entry sits in its sequence, counted on the way up. */
  #positionOf(id: NodeId): number {
    let position = this.#size(this.#get(id).left);
    let cur = id;
    for (;;) {
      const parent = this.#get(cur).parent;
      if (parent === null) return position;
      if (this.#get(parent).right === cur) {
        position += this.#size(this.#get(parent).left) + 1;
      }
      cur = parent;
    }
  }

  #inOrder(root: NodeId | null): NodeId[] {
    const out: NodeId[] = [];
    // Iterative: a treap on a few thousand entries is shallow, but a sequence
    // built by merging in order is not guaranteed to be.
    const stack: NodeId[] = [];
    let cur = root;
    while (cur !== null || stack.length > 0) {
      while (cur !== null) { stack.push(cur); cur = this.#get(cur).left; }
      const id = stack.pop() as NodeId;
      out.push(id);
      cur = this.#get(id).right;
    }
    return out;
  }

  /**
   * An entry that stands for a vertex. Any edge leaving it will do, because
   * they are all in its tree's sequence; a vertex with no edges has the one
   * entry that exists for exactly this reason.
   *
   * Derived rather than stored: cutting an edge would otherwise leave whichever
   * vertex it represented pointing at an entry that no longer exists.
   */
  #representative(v: number): NodeId | null {
    const neighbours = this.#adjacent.get(v);
    if (neighbours !== undefined && neighbours.size > 0) {
      const first = neighbours.values().next().value as number;
      return this.#edgeAt.get(edgeKey(v, first)) ?? null;
    }
    return this.#aloneAt.get(v) ?? null;
  }

  #exists(v: number): boolean {
    return this.#representative(v) !== null;
  }

  /** Gives a vertex its own entry, now that it has no edges to stand for it. */
  #standAlone(v: number, events: SimEvent[]): void {
    if (this.#aloneAt.has(v)) return;
    this.#occurrence(v, null, events);
  }

  /** Takes that entry away again, now that an edge will stand for it. */
  #joinUp(v: number, events: SimEvent[]): void {
    const alone = this.#aloneAt.get(v);
    if (alone === undefined) return;
    this.#aloneAt.delete(v);
    this.#nodes.delete(alone);
    events.push({ kind: 'NodeDeleted', node: alone });
  }

  #roots(): NodeId[] {
    const seen = new Set<NodeId>();
    const roots: NodeId[] = [];
    for (const id of this.#nodes.keys()) {
      const root = this.#rootOf(id);
      if (seen.has(root)) continue;
      seen.add(root);
      roots.push(root);
    }
    // Ordered by their lowest vertex, so the drawing does not reshuffle when
    // an unrelated tree is touched.
    return roots.sort((x, y) => this.#lowest(x) - this.#lowest(y));
  }

  #lowest(root: NodeId): number {
    let best = Infinity;
    for (const id of this.#inOrder(root)) {
      const n = this.#get(id);
      best = Math.min(best, n.vertex, n.from ?? Infinity);
    }
    return best;
  }

  /* ── Building occurrences ────────────────────────────────────────── */

  #occurrence(vertex: number, from: number | null, events: SimEvent[]): NodeId {
    const id = this.#next as NodeId;
    this.#next += 1;
    this.#nodes.set(id, {
      id, priority: this.#rng.next(), vertex, from,
      left: null, right: null, parent: null, size: 1,
    });
    events.push({
      kind: 'NodeAllocated',
      node: id,
      value: vertex,
      label: from === null ? `${vertex}` : `${from}→${vertex}`,
      role: from === null ? 'vertex' : 'edge',
      slot: from === null ? `v${vertex}` : `e${from}>${vertex}`,
      origin: 0,
    });
    if (from === null) this.#aloneAt.set(vertex, id);
    else this.#edgeAt.set(edgeKey(from, vertex), id);
    return id;
  }

  #discard(id: NodeId, events: SimEvent[]): void {
    const n = this.#get(id);
    if (n.from !== null) this.#edgeAt.delete(edgeKey(n.from, n.vertex));
    else this.#aloneAt.delete(n.vertex);
    this.#nodes.delete(id);
    events.push({ kind: 'NodeDeleted', node: id });
  }

  /** Sequence for one tree, and the treap holding it. */
  #sequence(order: readonly { vertex: number; from: number | null }[], events: SimEvent[]): NodeId | null {
    let root: NodeId | null = null;
    for (const entry of order) {
      root = this.#merge(root, this.#occurrence(entry.vertex, entry.from, events));
    }
    return root;
  }

  /* ── Reroot, the operation everything else is built on ───────────── */

  /**
   * Rotates a tour to begin at `vertex`, which is the tour of the same tree
   * rooted there. Split at its one occurrence, and put what came before at the
   * end - the sequence is cyclic in exactly the way that makes this true.
   */
  #reroot(vertex: number): NodeId | null {
    const at = this.#representative(vertex);
    if (at === null) return null;
    const root = this.#rootOf(at);
    const [before, after] = this.#split(root, this.#positionOf(at));
    return this.#merge(after, before);
  }

  /* ── Structure derived from the tours, never stored ──────────────── */

  /** The edges of the forest, read back out of the tours. */
  #edges(): [number, number][] {
    const out: [number, number][] = [];
    for (const [v, neighbours] of this.#adjacent) {
      for (const other of neighbours) if (v < other) out.push([v, other]);
    }
    return out.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  }

  #join(a: number, b: number): void {
    (this.#adjacent.get(a) as Set<number>).add(b);
    (this.#adjacent.get(b) as Set<number>).add(a);
  }

  #part(a: number, b: number): void {
    this.#adjacent.get(a)?.delete(b);
    this.#adjacent.get(b)?.delete(a);
  }

  #ensure(v: number): void {
    if (!this.#adjacent.has(v)) this.#adjacent.set(v, new Set());
  }

  #known(): string {
    const labels = [...this.#adjacent.keys()].filter((v) => this.#exists(v)).sort((a, b) => a - b);
    return labels.length === 0
      ? 'nothing has been built yet - start with build'
      : `vertices: ${labels.join(', ')}`;
  }

  /* ── Commands ────────────────────────────────────────────────────── */

  #build(pairs: readonly number[]): OperationResult {
    if (pairs.length % 2 !== 0) {
      return failed(err('BAD_ARGUMENT',
        `An edge list needs an even number of vertices; ${pairs.length} given.`,
        'each pair is one edge, so [1 2 3 4] is two separate trees'));
    }
    this.reset();
    const events: SimEvent[] = [];
    this.#pending = events;

    const labels = [...new Set(pairs)].sort((a, b) => a - b);
    const adjacency = new Map<number, number[]>();
    for (const v of labels) adjacency.set(v, []);
    const seen = new Set<string>();
    for (let i = 0; i < pairs.length; i += 2) {
      const a = pairs[i] as number;
      const b = pairs[i + 1] as number;
      if (a === b) {
        this.reset();
        return failed(err('PRECONDITION_FAILED', `Vertex ${a} cannot be joined to itself.`,
          'a forest has no loops'));
      }
      const pair = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (seen.has(pair)) {
        this.reset();
        return failed(err('PRECONDITION_FAILED', `The edge ${a}-${b} is given twice.`,
          'a forest has at most one path between any two vertices'));
      }
      seen.add(pair);
      (adjacency.get(a) as number[]).push(b);
      (adjacency.get(b) as number[]).push(a);
      this.#ensure(a);
      this.#ensure(b);
      this.#join(a, b);
    }
    for (const list of adjacency.values()) list.sort((a, b) => a - b);

    // One tour per tree. Iterative, because a forest read from input can be a
    // straight line as easily as anything else.
    const visited = new Set<number>();
    for (const start of labels) {
      if (visited.has(start)) continue;
      const order: { vertex: number; from: number | null }[] = [];
      visited.add(start);
      const stack: { vertex: number; parent: number | null; next: number }[] =
        [{ vertex: start, parent: null, next: 0 }];

      while (stack.length > 0) {
        const frame = stack[stack.length - 1] as { vertex: number; parent: number | null; next: number };
        const neighbours = adjacency.get(frame.vertex) as number[];
        if (frame.next < neighbours.length) {
          const child = neighbours[frame.next] as number;
          frame.next += 1;
          if (visited.has(child)) {
            if (child !== frame.parent) {
              this.reset();
              return failed(err('PRECONDITION_FAILED',
                `The edge ${frame.vertex}-${child} closes a cycle.`,
                'a forest has at most one path between any two vertices'));
            }
            continue;
          }
          visited.add(child);
          order.push({ vertex: child, from: frame.vertex });
          stack.push({ vertex: child, parent: frame.vertex, next: 0 });
          continue;
        }
        stack.pop();
        if (frame.parent !== null) order.push({ vertex: frame.parent, from: frame.vertex });
      }
      // A vertex with no edges has no entry of its own from the walk above.
      if (order.length === 0) this.#standAlone(start, events);
      else this.#sequence(order, events);
    }

    const roots = this.#roots();
    events.push({ kind: 'RootsSet', roots });

    return {
      ok: true,
      value: {
        vertices: this.#adjacent.size,
        edges: seen.size,
        trees: roots.length,
        // Two entries per edge, so a tree of k vertices is 2(k - 1) of them.
        entries: this.#nodes.size,
      },
      events,
      statsDelta: { nodesAllocated: this.#nodes.size, updates: 1 },
    };
  }

  #link(a: number, b: number): OperationResult {
    if (a === b) {
      return failed(err('PRECONDITION_FAILED', `Vertex ${a} cannot be joined to itself.`,
        'a forest has no loops'));
    }
    const events: SimEvent[] = [];
    this.#pending = events;

    // A vertex nobody has mentioned yet is a tree of one.
    for (const v of [a, b]) {
      this.#ensure(v);
      if (!this.#exists(v)) this.#standAlone(v, events);
    }

    const ra = this.#rootOf(this.#representative(a) as NodeId, events);
    const rb = this.#rootOf(this.#representative(b) as NodeId, events);
    if (ra === rb) {
      return failed(err('PRECONDITION_FAILED', `${a} and ${b} are already in the same tree.`,
        'joining them would close a cycle, and a tour only describes a tree'));
    }

    // Rooted at their own ends, the two tours join with one edge each way.
    // A side that stood alone contributes nothing but the edge itself.
    const aloneA = this.#aloneAt.has(a);
    const aloneB = this.#aloneAt.has(b);
    const tourA = aloneA ? null : this.#reroot(a);
    const tourB = aloneB ? null : this.#reroot(b);
    this.#joinUp(a, events);
    this.#joinUp(b, events);
    this.#join(a, b);
    const forward = this.#occurrence(b, a, events);
    const back = this.#occurrence(a, b, events);
    this.#merge(this.#merge(this.#merge(tourA, forward), tourB), back);

    const roots = this.#roots();
    events.push({ kind: 'RootsSet', roots });
    return {
      ok: true,
      value: { a, b, trees: roots.length, entries: this.#nodes.size },
      events,
      statsDelta: { updates: 1, nodesAllocated: 2 },
    };
  }

  #cut(a: number, b: number): OperationResult {
    const forward = this.#edgeAt.get(edgeKey(a, b));
    const back = this.#edgeAt.get(edgeKey(b, a));
    if (forward === undefined || back === undefined) {
      return failed(err('PRECONDITION_FAILED', `There is no edge between ${a} and ${b}.`,
        this.#edges().length === 0 ? 'the forest has no edges'
          : `edges: ${this.#edges().map(([x, y]) => `${x}-${y}`).join(', ')}`));
    }

    const events: SimEvent[] = [];
    this.#pending = events;
    const root = this.#rootOf(forward, events);
    const first = this.#positionOf(forward);
    const second = this.#positionOf(back);
    const [lo, hi] = first < second ? [first, second] : [second, first];

    /*
     * Everything strictly between the two occurrences of an edge is the
     * subtree hanging below it - that is the property the whole structure
     * rests on. Lift that block out, drop the two edge entries, and what is
     * left rejoins into the tour of the other side.
     */
    const [before, rest] = this.#split(root, lo);
    const [, afterLo] = this.#split(rest, 1);
    const [middle, tail] = this.#split(afterLo, hi - lo - 1);
    const [, after] = this.#split(tail, 1);

    this.#discard(forward, events);
    this.#discard(back, events);
    this.#part(a, b);
    this.#merge(before, after);
    void middle;

    // A side left with no edges has no entry standing for it any more.
    for (const v of [a, b]) {
      if ((this.#adjacent.get(v) as Set<number>).size === 0) this.#standAlone(v, events);
    }

    const roots = this.#roots();
    events.push({ kind: 'RootsSet', roots });
    return {
      ok: true,
      value: { a, b, trees: roots.length, entries: this.#nodes.size },
      events,
      statsDelta: { updates: 1 },
    };
  }

  #connected(a: number, b: number): OperationResult {
    const ia = this.#representative(a);
    const ib = this.#representative(b);
    if (ia === null || ib === null) {
      return failed(err('UNKNOWN_VERSION',
        `There is no vertex ${ia === null ? a : b}.`, this.#known()));
    }

    const events: SimEvent[] = [];
    const ra = this.#rootOf(ia, events);
    const rb = this.#rootOf(ib, events);
    const same = ra === rb;

    return {
      ok: true,
      value: {
        a, b, connected: same,
        // Two entries per edge, so k vertices give 2(k - 1) - except a vertex
        // standing alone, whose single entry is the only odd case.
        treeSize: same ? (this.#size(ra) === 1 ? 1 : this.#size(ra) / 2 + 1) : null,
        steps: events.length,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: events.length },
    };
  }

  #tour(a: number): OperationResult {
    const at = this.#representative(a);
    if (at === null) {
      return failed(err('UNKNOWN_VERSION', `There is no vertex ${a}.`, this.#known()));
    }
    const root = this.#rootOf(at);
    const order = this.#inOrder(root);
    return {
      ok: true,
      value: {
        of: a,
        entries: order.length,
        vertices: order.length === 1 ? 1 : order.length / 2 + 1,
        walk: order.map((id) => {
          const n = this.#get(id);
          return n.from === null ? `${n.vertex}` : `${n.from}→${n.vertex}`;
        }),
      },
      events: order.map((id): SimEvent => ({ kind: 'NodeVisited', node: id })),
      statsDelta: { queries: 1, nodeVisits: order.length },
    };
  }

  /* ── Views ───────────────────────────────────────────────────────── */

  getStructure(): StructureGraph {
    const nodes: StructureNode[] = [];
    const edges: StructureEdge[] = [];
    const roots = this.#roots();
    const group = new Map<NodeId, number>();
    roots.forEach((root, index) => {
      for (const id of this.#inOrder(root)) group.set(id, index);
    });

    for (const n of this.#nodes.values()) {
      nodes.push({
        id: n.id,
        label: n.from === null ? `${n.vertex}` : `${n.from}→${n.vertex}`,
        value: n.vertex,
        role: n.from === null ? 'vertex' : 'edge',
        slot: n.from === null ? `v${n.vertex}` : `e${n.from}>${n.vertex}`,
        origin: 0,
        // Which tree this entry belongs to. Two vertices being the same colour
        // is exactly the question `connected` answers.
        group: group.get(n.id) ?? 0,
      });
      for (const [slot, child] of [['left', n.left], ['right', n.right]] as const) {
        if (child === null) continue;
        edges.push({ from: n.id, to: child, slot, reused: false });
      }
    }

    return { layout: 'dag', nodes, edges, roots };
  }

  serialize(): SerializedState {
    return {
      schemaVersion: SCHEMA_VERSION,
      pluginId: 'euler-tour',
      data: {
        vertices: [...this.#adjacent.keys()].filter((v) => this.#exists(v)).sort((a, b) => a - b),
        edges: this.#edges(),
      },
    };
  }
}

export const eulerTour: AlgorithmPlugin = {
  meta: {
    id: 'euler-tour',
    name: 'Euler Tour Tree',
    category: 'Advanced',
    summary: 'A forest held as sequences, so cutting and joining trees is splitting and joining text.',
  },
  commands: COMMANDS,
  explain: explainEuler,
  benchmark: {
    sizes: [8, 16, 32, 64, 128, 256],
    command: 'connected',
    // A path graph: the tour is as long as it gets for the vertex count, and
    // the two ends are as far apart in the tree as they can be. How deep their
    // entries sit in the treap has nothing to do with that distance, which is
    // the point being measured.
    setup: (n: number): readonly string[] => {
      const pairs: number[] = [];
      for (let i = 1; i < n; i += 1) pairs.push(i, i + 1);
      return [`build [${pairs.join(' ')}]`];
    },
    probes: (n: number): readonly string[] => [`connected 1 ${n}`],
  },
  createInstance: (ctx: EngineContext): PluginInstance => new Instance(ctx.rng),
};
