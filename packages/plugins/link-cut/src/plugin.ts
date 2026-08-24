/**
 * Link-cut tree.
 *
 * Heavy-light decomposition answers path queries on a tree that never changes,
 * by cutting it into chains once. Euler tour tree survives the tree changing,
 * but only answers questions about *subtrees* and about connectivity - its
 * sequence is built so that a subtree is one contiguous block, and a path is
 * nothing in particular. This does both: paths, on a forest being cut apart
 * and joined back together.
 *
 * The idea is heavy-light made dynamic. The forest is cut into **preferred
 * paths**, each held in a splay tree keyed by depth, so that the in-order walk
 * of a splay tree reads a path from its shallowest vertex to its deepest. Where
 * heavy-light chooses its chains once by subtree size, this chooses them by
 * what was asked about last - and that turns out to be enough, because
 * `access(v)` makes the path from the root down to v preferred, and the number
 * of times a path can stop being preferred is bounded by the number of times
 * one was made preferred.
 *
 * Splay trees are joined by **path-parent** pointers: from the root of a splay
 * tree to the represented parent of that path's shallowest vertex. Those are
 * the only edges that leave a preferred path, and following them is how
 * `access` climbs. Every operation here is `access` and then something cheap:
 *
 *   - after `access(v)`, v's splay tree holds exactly the root-to-v path, so a
 *     path aggregate is one read at the splay root;
 *   - the leftmost node of that tree is the root of v's tree;
 *   - `access(u)` then `access(v)` lands its last path-parent jump on the
 *     lowest common ancestor, because that is where v's climb meets the path
 *     that u just made preferred.
 *
 * What is drawn here is the splay forest - what the structure *is* - rather
 * than the forest it represents, which is what it *means*. Solid edges are
 * splay children, so a preferred path is a connected component of them; the
 * straight ones are path-parents. The represented forest can be read back off
 * the picture, and a check does exactly that, because a drawing that cannot be
 * turned back into the tree it stands for is not a drawing of it.
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
import { explainLinkCut } from './explain.ts';

const SCHEMA_VERSION = 1;

const MAX_VERTICES = 2048;

/** A vertex of the represented forest, and a node of one splay tree. */
interface Node {
  readonly id: NodeId;
  readonly vertex: number;
  left: NodeId | null;
  right: NodeId | null;
  /** Splay parent, or null when this node is the root of its splay tree. */
  parent: NodeId | null;
  /**
   * The represented parent of this path's shallowest vertex. Meaningful only
   * on a splay root, and it belongs to the *tree* rather than to the node - so
   * it travels to whoever becomes the root when the tree is rotated.
   */
  pathParent: NodeId | null;
  /* Aggregates over this splay subtree, which is a piece of one path. */
  size: number;
  sum: number;
  max: number;
}

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Read pairs as child then parent: [2 1 3 1] hangs 2 and 3 under 1.',
    complexity: 'O(n log n)',
    params: [{ name: 'pairs', kind: 'int-list' }],
  },
  {
    name: 'link',
    summary: 'Hang one tree under a vertex of another. The first must be a root.',
    complexity: 'O(log n)',
    params: [
      { name: 'a', kind: 'int' },
      { name: 'b', kind: 'int' },
    ],
  },
  {
    name: 'cut',
    summary: 'Remove the edge between two vertices, splitting one tree into two.',
    complexity: 'O(log n)',
    params: [
      { name: 'a', kind: 'int' },
      { name: 'b', kind: 'int' },
    ],
  },
  {
    name: 'root',
    summary: 'The root of the tree holding a vertex.',
    complexity: 'O(log n)',
    params: [{ name: 'a', kind: 'int' }],
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
    name: 'path',
    summary: 'Length, total and largest along the root-to-vertex path.',
    complexity: 'O(log n)',
    params: [{ name: 'a', kind: 'int' }],
  },
  {
    name: 'lca',
    summary: 'The lowest common ancestor, found by where the second climb meets the first.',
    complexity: 'O(log n)',
    params: [
      { name: 'a', kind: 'int' },
      { name: 'b', kind: 'int' },
    ],
  },
  {
    name: 'evert',
    summary: 'Make a vertex the root of its tree, reversing the path above it.',
    complexity: 'O(n)',
    params: [{ name: 'a', kind: 'int' }],
  },
];

function err(code: OperationError['code'], message: string, hint?: string): OperationError {
  return { code, message, ...(hint === undefined ? {} : { hint }) };
}

class Instance implements PluginInstance {
  #nodes = new Map<NodeId, Node>();
  #ids = new Map<number, NodeId>();
  #next = 0;
  #built = false;

  reset(): void {
    this.#nodes = new Map();
    this.#ids = new Map();
    this.#next = 0;
    this.#built = false;
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getIntList(cmd, 'pairs'));
      case 'link': return this.#linkCmd(getInt(cmd, 'a'), getInt(cmd, 'b'));
      case 'cut': return this.#cutCmd(getInt(cmd, 'a'), getInt(cmd, 'b'));
      case 'root': return this.#rootCmd(getInt(cmd, 'a'));
      case 'connected': return this.#connectedCmd(getInt(cmd, 'a'), getInt(cmd, 'b'));
      case 'path': return this.#pathCmd(getInt(cmd, 'a'));
      case 'lca': return this.#lcaCmd(getInt(cmd, 'a'), getInt(cmd, 'b'));
      case 'evert': return this.#evertCmd(getInt(cmd, 'a'));
      default:
        return failed(err('PARSE_ERROR', `This plugin does not handle "${cmd.name}".`));
    }
  }

  #ready(): OperationError | null {
    return this.#built
      ? null
      : err('PRECONDITION_FAILED', 'No forest has been built yet.',
        'start with build, as in: build [2 1 3 1]');
  }

  #get(id: NodeId): Node {
    const n = this.#nodes.get(id);
    if (n === undefined) throw new Error(`no node ${id}`);
    return n;
  }

  #known(vertex: number): OperationError | null {
    return this.#ids.has(vertex)
      ? null
      : err('BAD_ARGUMENT', `Vertex ${vertex} is not in the forest.`,
        `it has ${this.#ids.size} vertices: ${[...this.#ids.keys()].sort((a, b) => a - b).join(' ')}`);
  }

  #idOf(vertex: number): NodeId {
    return this.#ids.get(vertex) as NodeId;
  }

  /* ── Pointers, and saying so ─────────────────────────────────────── */

  /*
   * Every pointer that is drawn is set through one of these three, so that no
   * rearrangement can happen without the log recording it. The field is
   * assigned whether or not it changed - only the event is conditional -
   * because a guard that also skips the assignment is how a parent link goes
   * missing.
   */

  #setLeft(id: NodeId, child: NodeId | null, events: SimEvent[]): void {
    const n = this.#get(id);
    const changed = n.left !== child;
    n.left = child;
    if (child !== null) this.#get(child).parent = id;
    if (changed) events.push({ kind: 'PointerSet', from: id, slot: 'left', to: child });
  }

  #setRight(id: NodeId, child: NodeId | null, events: SimEvent[]): void {
    const n = this.#get(id);
    const changed = n.right !== child;
    n.right = child;
    if (child !== null) this.#get(child).parent = id;
    if (changed) events.push({ kind: 'PointerSet', from: id, slot: 'right', to: child });
  }

  #setPathParent(id: NodeId, to: NodeId | null, events: SimEvent[]): void {
    const n = this.#get(id);
    const changed = n.pathParent !== to;
    n.pathParent = to;
    if (changed) {
      events.push({ kind: 'PointerSet', from: id, slot: 'path', to, pointer: 'link', directed: true });
    }
  }

  /** Splay roots, in vertex order so the log is reproducible. */
  #roots(): NodeId[] {
    return [...this.#nodes.values()]
      .filter((n) => n.parent === null)
      .sort((a, b) => a.vertex - b.vertex)
      .map((n) => n.id);
  }

  #rootsEvent(): SimEvent {
    return { kind: 'RootsSet', roots: this.#roots() };
  }

  /* ── Splay ───────────────────────────────────────────────────────── */

  #pull(id: NodeId): void {
    const n = this.#get(id);
    const l = n.left === null ? null : this.#get(n.left);
    const r = n.right === null ? null : this.#get(n.right);
    n.size = 1 + (l?.size ?? 0) + (r?.size ?? 0);
    n.sum = n.vertex + (l?.sum ?? 0) + (r?.sum ?? 0);
    n.max = Math.max(n.vertex, l?.max ?? -Infinity, r?.max ?? -Infinity);
  }

  /**
   * One rotation, taking x above its splay parent.
   *
   * The only thing here that a plain splay tree does not have is the transfer
   * of the path-parent. It describes the splay tree, not the node holding it,
   * so when the root changes the pointer has to follow - and forgetting that
   * is how a whole preferred path silently detaches from the forest.
   */
  #rotate(x: NodeId, events: SimEvent[]): void {
    const nx = this.#get(x);
    const p = nx.parent as NodeId;
    const np = this.#get(p);
    const g = np.parent;

    if (g === null) {
      const carried = np.pathParent;
      this.#setPathParent(p, null, events);
      this.#setPathParent(x, carried, events);
    }

    if (np.left === x) {
      const inner = nx.right;
      this.#setLeft(p, inner, events);
      this.#setRight(x, p, events);
    } else {
      const inner = nx.left;
      this.#setRight(p, inner, events);
      this.#setLeft(x, p, events);
    }

    // #setLeft and #setRight have already pointed p's parent at x.
    nx.parent = g;
    if (g !== null) {
      if (this.#get(g).left === p) this.#setLeft(g, x, events);
      else this.#setRight(g, x, events);
    }

    this.#pull(p);
    this.#pull(x);
  }

  /** Bring x to the root of its splay tree, two levels at a time. */
  #splay(x: NodeId, events: SimEvent[]): void {
    for (;;) {
      const p = this.#get(x).parent;
      if (p === null) break;
      events.push({ kind: 'NodeVisited', node: x });
      const g = this.#get(p).parent;
      if (g === null) {
        this.#rotate(x, events);
        break;
      }
      // Zig-zig rotates the parent first, so the grandchild rises two levels
      // and the path it came up is halved. Rotating x twice instead would
      // leave the path as long as it was, which is the whole difference
      // between splaying and merely moving a node to the root.
      const sameSide = (this.#get(p).left === x) === (this.#get(g).left === p);
      if (sameSide) this.#rotate(p, events);
      else this.#rotate(x, events);
      this.#rotate(x, events);
    }
  }

  /** Detach whatever hangs below id on its preferred path. */
  #detachBelow(id: NodeId, events: SimEvent[]): void {
    const below = this.#get(id).right;
    if (below === null) return;
    this.#get(below).parent = null;
    this.#setPathParent(below, id, events);
    this.#setRight(id, null, events);
    this.#pull(id);
  }

  /**
   * Make the root-to-v path preferred, and v the root of its splay tree.
   *
   * Returns the last vertex whose path-parent was followed, which is where
   * this climb joined a path that was already preferred. That is the only
   * extra fact `access` knows and cannot be recovered afterwards, and it is
   * exactly what the lowest common ancestor is.
   */
  #access(v: NodeId, events: SimEvent[]): NodeId {
    this.#splay(v, events);
    this.#detachBelow(v, events);

    let last = v;
    for (;;) {
      const above = this.#get(v).pathParent;
      if (above === null) break;
      last = above;
      this.#splay(above, events);
      this.#detachBelow(above, events);
      // v's path becomes the preferred one below `above`.
      this.#setPathParent(v, null, events);
      this.#setRight(above, v, events);
      this.#pull(above);
      this.#splay(v, events);
    }
    return last;
  }

  /** The shallowest vertex of v's tree, which is its root. */
  #findRoot(v: NodeId, events: SimEvent[]): NodeId {
    this.#access(v, events);
    let cur = v;
    for (;;) {
      events.push({ kind: 'NodeVisited', node: cur });
      const left = this.#get(cur).left;
      if (left === null) break;
      cur = left;
    }
    // Splayed so that a second question about the same root is cheap, which is
    // what makes the amortised bound hold rather than merely being claimed.
    this.#splay(cur, events);
    return cur;
  }

  /** The represented parent of v, or null when v is a root. */
  #parentOf(v: NodeId, events: SimEvent[]): NodeId | null {
    this.#access(v, events);
    const left = this.#get(v).left;
    if (left === null) return null;
    let cur = left;
    for (;;) {
      events.push({ kind: 'NodeVisited', node: cur });
      const right = this.#get(cur).right;
      if (right === null) break;
      cur = right;
    }
    this.#splay(cur, events);
    return cur;
  }

  /** Take v away from its parent. v must not already be a root. */
  #cutFromParent(v: NodeId, events: SimEvent[]): void {
    this.#access(v, events);
    const above = this.#get(v).left;
    if (above === null) return;
    this.#get(above).parent = null;
    this.#setLeft(v, null, events);
    this.#pull(v);
  }

  /**
   * Reverse a whole splay tree, so its in-order reads the other way round.
   *
   * The textbook link-cut tree does this with a lazy bit on each node, pushed
   * down as the tree is walked, which makes `evert` cost the same as anything
   * else. That bit is a mutable field on a node, and the event log has no way
   * to say that a node's field changed - only that a pointer moved - so a lazy
   * bit would be invisible in the replayed picture and the drawing would show
   * a path running the wrong way. Reversing the pointers instead keeps the
   * picture honest and costs the length of the path, which is declared.
   */
  #reverse(root: NodeId, events: SimEvent[]): number {
    const stack: NodeId[] = [root];
    let touched = 0;
    while (stack.length > 0) {
      const id = stack.pop() as NodeId;
      touched += 1;
      events.push({ kind: 'NodeVisited', node: id });
      const n = this.#get(id);
      const left = n.left;
      const right = n.right;
      if (left === null && right === null) continue;
      this.#setLeft(id, right, events);
      this.#setRight(id, left, events);
      if (left !== null) stack.push(left);
      if (right !== null) stack.push(right);
    }
    return touched;
  }

  /* ── Commands ────────────────────────────────────────────────────── */

  #allocate(vertex: number, events: SimEvent[]): NodeId {
    const known = this.#ids.get(vertex);
    if (known !== undefined) return known;
    const id = this.#next as NodeId;
    this.#next += 1;
    this.#ids.set(vertex, id);
    this.#nodes.set(id, {
      id, vertex, left: null, right: null, parent: null, pathParent: null,
      size: 1, sum: vertex, max: vertex,
    });
    events.push({
      kind: 'NodeAllocated',
      node: id,
      // A vertex is worth its own number, so a path total is something that
      // can be checked by adding the vertices up by hand.
      value: vertex,
      label: `${vertex}`,
      role: 'vertex',
      slot: `v${vertex}`,
      origin: 0,
    });
    return id;
  }

  #build(pairs: readonly number[]): OperationResult {
    if (pairs.length % 2 !== 0) {
      return failed(err('BAD_ARGUMENT', `${pairs.length} numbers cannot be read as pairs.`,
        'each pair is a vertex and then its parent, so [2 1 3 1] hangs 2 and 3 under 1'));
    }

    this.reset();
    const events: SimEvent[] = [];
    const parentOf = new Map<number, number>();

    for (let i = 0; i < pairs.length; i += 2) {
      const child = pairs[i] as number;
      const parent = pairs[i + 1] as number;

      if (child === parent) {
        this.reset();
        return failed(err('BAD_ARGUMENT', `Vertex ${child} cannot be its own parent.`,
          'a tree has no edge from a vertex to itself'));
      }
      const already = parentOf.get(child);
      if (already !== undefined) {
        this.reset();
        return failed(err('BAD_ARGUMENT',
          `Vertex ${child} is given two parents, ${already} and ${parent}.`,
          'in a tree every vertex has one parent, and only a root has none'));
      }

      this.#allocate(child, events);
      this.#allocate(parent, events);
      if (this.#ids.size > MAX_VERTICES) {
        this.reset();
        return failed(err('BAD_ARGUMENT', `More than ${MAX_VERTICES} vertices is too many.`,
          `the limit is ${MAX_VERTICES}`));
      }

      const a = this.#idOf(child);
      const b = this.#idOf(parent);
      if (this.#findRoot(a, events) === this.#findRoot(b, events)) {
        this.reset();
        return failed(err('BAD_ARGUMENT',
          `Hanging ${child} under ${parent} would close a cycle.`,
          'the two are already in the same tree, and a tree has no cycles'));
      }

      parentOf.set(child, parent);
      this.#access(a, events);
      this.#setPathParent(a, b, events);
    }

    this.#built = true;
    events.push(this.#rootsEvent());

    return {
      ok: true,
      value: {
        vertices: this.#ids.size,
        edges: parentOf.size,
        trees: this.#ids.size - parentOf.size,
      },
      events,
      statsDelta: { nodesAllocated: this.#ids.size, updates: 1 },
    };
  }

  #linkCmd(a: number, b: number): OperationResult {
    const problem = this.#ready() ?? this.#known(a) ?? this.#known(b);
    if (problem !== null) return failed(problem);

    const events: SimEvent[] = [];
    const x = this.#idOf(a);
    const y = this.#idOf(b);

    if (this.#findRoot(x, events) !== x) {
      return failed(err('PRECONDITION_FAILED', `Vertex ${a} is not the root of its tree.`,
        `only a root can be hung under something; evert ${a} first if that is what you meant`));
    }
    if (this.#findRoot(y, events) === x) {
      return failed(err('PRECONDITION_FAILED',
        `Vertex ${a} is already in the same tree as ${b}.`,
        'linking them would close a cycle'));
    }

    this.#access(x, events);
    this.#setPathParent(x, y, events);
    events.push(this.#rootsEvent());

    return {
      ok: true,
      value: { child: a, parent: b, trees: this.#treeCount() },
      events,
      statsDelta: { updates: 1, nodeVisits: this.#visits(events) },
    };
  }

  #cutCmd(a: number, b: number): OperationResult {
    const problem = this.#ready() ?? this.#known(a) ?? this.#known(b);
    if (problem !== null) return failed(problem);
    if (a === b) {
      return failed(err('BAD_ARGUMENT', `There is no edge from ${a} to itself.`,
        'give the two ends of an edge'));
    }

    const events: SimEvent[] = [];
    const x = this.#idOf(a);
    const y = this.#idOf(b);

    if (this.#findRoot(x, events) !== this.#findRoot(y, events)) {
      return failed(err('PRECONDITION_FAILED', `Vertices ${a} and ${b} are in different trees.`,
        'there is no edge between them to remove'));
    }

    let removed: number | null = null;
    if (this.#parentOf(x, events) === y) {
      this.#cutFromParent(x, events);
      removed = a;
    } else if (this.#parentOf(y, events) === x) {
      this.#cutFromParent(y, events);
      removed = b;
    }
    if (removed === null) {
      return failed(err('PRECONDITION_FAILED',
        `Vertices ${a} and ${b} are in one tree but not joined directly.`,
        'cut takes the two ends of an edge, not any two vertices of a path'));
    }

    events.push(this.#rootsEvent());
    return {
      ok: true,
      value: { detached: removed, from: removed === a ? b : a, trees: this.#treeCount() },
      events,
      statsDelta: { updates: 1, nodeVisits: this.#visits(events) },
    };
  }

  #rootCmd(a: number): OperationResult {
    const problem = this.#ready() ?? this.#known(a);
    if (problem !== null) return failed(problem);

    const events: SimEvent[] = [];
    const root = this.#findRoot(this.#idOf(a), events);
    events.push(this.#rootsEvent());

    return {
      ok: true,
      value: { of: a, root: this.#get(root).vertex },
      events,
      statsDelta: { queries: 1, nodeVisits: this.#visits(events) },
    };
  }

  #connectedCmd(a: number, b: number): OperationResult {
    const problem = this.#ready() ?? this.#known(a) ?? this.#known(b);
    if (problem !== null) return failed(problem);

    const events: SimEvent[] = [];
    const ra = this.#findRoot(this.#idOf(a), events);
    const rb = this.#findRoot(this.#idOf(b), events);
    events.push(this.#rootsEvent());

    return {
      ok: true,
      value: {
        a, b,
        connected: ra === rb,
        // Which root each ended at, because "no" is more useful with a reason.
        rootOfA: this.#get(ra).vertex,
        rootOfB: this.#get(rb).vertex,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: this.#visits(events) },
    };
  }

  #pathCmd(a: number): OperationResult {
    const problem = this.#ready() ?? this.#known(a);
    if (problem !== null) return failed(problem);

    const events: SimEvent[] = [];
    const v = this.#idOf(a);
    this.#access(v, events);
    // After the access this splay tree is exactly the root-to-v path, so the
    // aggregate at its root is the aggregate of the path. That is the whole
    // reason the trees are keyed by depth.
    const n = this.#get(v);
    events.push(this.#rootsEvent());

    return {
      ok: true,
      value: {
        of: a,
        root: this.#get(this.#leftmost(v)).vertex,
        length: n.size,
        total: n.sum,
        largest: n.max,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: this.#visits(events) },
    };
  }

  #lcaCmd(a: number, b: number): OperationResult {
    const problem = this.#ready() ?? this.#known(a) ?? this.#known(b);
    if (problem !== null) return failed(problem);

    const events: SimEvent[] = [];
    const x = this.#idOf(a);
    const y = this.#idOf(b);
    if (this.#findRoot(x, events) !== this.#findRoot(y, events)) {
      return failed(err('PRECONDITION_FAILED', `Vertices ${a} and ${b} are in different trees.`,
        'there is no common ancestor without a common root'));
    }

    /*
     * Make the root-to-a path preferred, then climb from b. The climb stops
     * when it reaches a path that is already preferred, and the vertex it
     * stopped at is on the root-to-a path and is an ancestor of b - which is
     * the definition of the meeting point.
     */
    this.#access(x, events);
    const meet = this.#access(y, events);
    events.push(this.#rootsEvent());

    return {
      ok: true,
      value: { a, b, lca: this.#get(meet).vertex },
      events,
      statsDelta: { queries: 1, nodeVisits: this.#visits(events) },
    };
  }

  #evertCmd(a: number): OperationResult {
    const problem = this.#ready() ?? this.#known(a);
    if (problem !== null) return failed(problem);

    const events: SimEvent[] = [];
    const v = this.#idOf(a);
    const wasRoot = this.#findRoot(v, events) === v;
    this.#access(v, events);
    // The splay tree now holds the root-to-v path with v deepest. Reversing it
    // puts v shallowest, which is to say it makes v the root.
    const touched = this.#reverse(v, events);
    events.push(this.#rootsEvent());

    return {
      ok: true,
      value: { root: a, alreadyRoot: wasRoot, reversed: touched },
      events,
      statsDelta: { updates: 1, nodeVisits: this.#visits(events) },
    };
  }

  /* ── Reading things back ─────────────────────────────────────────── */

  #leftmost(id: NodeId): NodeId {
    let cur = id;
    for (;;) {
      const left = this.#get(cur).left;
      if (left === null) return cur;
      cur = left;
    }
  }

  /**
   * A tree per splay root with no path-parent: those are the paths that
   * contain a represented root.
   */
  #treeCount(): number {
    return [...this.#nodes.values()]
      .filter((n) => n.parent === null && n.pathParent === null).length;
  }

  /**
   * The represented forest, read out of the splay forest without touching it.
   *
   * In-order within a splay tree is the path from shallowest to deepest, so
   * each entry's parent is the one before it, and the first entry's parent is
   * what the splay root's path-parent points at. Doing this by splaying would
   * be shorter and is what `parentOf` does during an operation - but a view
   * must not rearrange what it is looking at, and rearranging it here would
   * move pointers that no event had reported.
   */
  #representedParents(): Map<number, number | null> {
    const out = new Map<number, number | null>();
    for (const root of this.#nodes.values()) {
      if (root.parent !== null) continue;
      const order: NodeId[] = [];
      const stack: { id: NodeId; expanded: boolean }[] = [{ id: root.id, expanded: false }];
      while (stack.length > 0) {
        const top = stack.pop() as { id: NodeId; expanded: boolean };
        if (top.expanded) { order.push(top.id); continue; }
        const n = this.#get(top.id);
        if (n.right !== null) stack.push({ id: n.right, expanded: false });
        stack.push({ id: top.id, expanded: true });
        if (n.left !== null) stack.push({ id: n.left, expanded: false });
      }
      order.forEach((id, i) => {
        const above = i === 0 ? root.pathParent : (order[i - 1] as NodeId);
        out.set(this.#get(id).vertex, above === null ? null : this.#get(above).vertex);
      });
    }
    return out;
  }

  #visits(events: readonly SimEvent[]): number {
    return events.filter((e) => e.kind === 'NodeVisited').length;
  }

  /* ── Views ───────────────────────────────────────────────────────── */

  getStructure(): StructureGraph {
    const nodes: StructureNode[] = [];
    const edges: StructureEdge[] = [];

    for (const n of [...this.#nodes.values()].sort((a, b) => a.vertex - b.vertex)) {
      nodes.push({
        id: n.id,
        label: `${n.vertex}`,
        value: n.vertex,
        role: 'vertex',
        slot: `v${n.vertex}`,
        origin: 0,
      });
      for (const [slot, child] of [['left', n.left], ['right', n.right]] as const) {
        if (child === null) continue;
        edges.push({ from: n.id, to: child, slot, reused: false, kind: 'child' });
      }
      if (n.pathParent !== null) {
        edges.push({
          from: n.id, to: n.pathParent, slot: 'path',
          reused: false, kind: 'link', directed: true,
        });
      }
    }

    return { layout: 'dag', nodes, edges, roots: this.#roots() };
  }

  serialize(): SerializedState {
    /*
     * The represented forest, not the splay trees. Two runs of the same
     * commands can leave the splay trees shaped differently after a rebuild
     * from this, and that is correct: the shape is a cache of what was asked
     * about, not part of what the structure holds.
     */
    const edges: number[][] = [];
    for (const [vertex, parent] of this.#representedParents()) {
      if (parent !== null) edges.push([vertex, parent]);
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      pluginId: 'link-cut',
      data: {
        vertices: [...this.#ids.keys()].sort((a, b) => a - b),
        edges: edges.sort((p, q) => (p[0] as number) - (q[0] as number)),
      },
    };
  }
}

export const linkCut: AlgorithmPlugin = {
  meta: {
    id: 'link-cut',
    name: 'Link-Cut Tree',
    category: 'Trees',
    summary: 'A forest cut into preferred paths, each a splay tree, so paths survive the '
      + 'forest changing shape.',
  },
  commands: COMMANDS,
  explain: explainLinkCut,
  benchmark: {
    sizes: [16, 32, 64, 128, 256, 512, 1024],
    command: 'path',
    /**
     * One long path, which is the shape a link-cut tree is hardest on: the
     * represented depth is n, so anything that walked it would be linear.
     */
    setup: (n: number): readonly string[] => {
      const pairs: number[] = [];
      for (let v = 2; v <= n; v += 1) pairs.push(v, v - 1);
      return [`build [${pairs.join(' ')}]`];
    },
    /**
     * Twice as many queries as vertices, at pseudo-random positions.
     *
     * A stride - `i * prime mod n` - is the obvious way to jump around, and it
     * measures the wrong thing. Over 2n queries it visits every vertex twice
     * *in the same order both times*, and a splay tree adapts to a repeating
     * sequence: that is what makes it statically optimal, and it dropped the
     * measured cost below a logarithm. The splay plugin's own benchmark was
     * wrong in the milder version of this way, sweeping in ascending order.
     *
     * So the positions come from a generator instead, seeded the same every
     * run so the measurement is still reproducible. MINSTD rather than the
     * usual larger multiplier, because 2^31 times 48271 is still an exact
     * double and the usual one is not - a generator that silently loses
     * precision collapses to one value, which reads as an operation that
     * costs nothing at all.
     */
    probes: (n: number): readonly string[] => {
      const out: string[] = [];
      let x = 12345;
      for (let i = 0; i < 2 * n; i += 1) {
        x = (x * 48271) % 2147483647;
        out.push(`path ${(x % n) + 1}`);
      }
      return out;
    },
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
