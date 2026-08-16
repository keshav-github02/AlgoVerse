/**
 * Persistent red-black tree.
 *
 * The AVL tree keeps a height on every node and rotates whenever two sides
 * differ by more than one level. This one keeps a single bit - a colour - and
 * three rules:
 *
 *   1. the root is black,
 *   2. a red node has no red child,
 *   3. every path from a node down to an empty place passes the same number
 *      of black nodes.
 *
 * Rule 3 is the one that does the work. It bounds the longest path at twice
 * the shortest, so the tree is never worse than 2*log2(n+1) deep - a looser
 * bound than AVL's, bought back as fewer rotations per write.
 *
 * The rebalancing here is written the functional way, as a `balance` that
 * takes a colour and two subtrees and returns the repaired shape, rather than
 * as a walk back up through parent pointers. That is not a stylistic choice:
 * a persistent tree has no parent pointers to walk, because a node is shared
 * by every version that still contains it and so cannot know who its parent
 * is. The functional formulation needs none, which makes it the natural fit
 * rather than an awkward one.
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
import { explainRbt } from './explain.ts';

const SCHEMA_VERSION = 1;

/**
 * Red and black are the only colours a node is ever stored with. Double black
 * and negative black exist for the length of one deletion: they are how the
 * algorithm carries "this subtree is one black short" up the tree without a
 * parent pointer to carry it through. Neither is ever allocated.
 */
type Colour = 'R' | 'B' | 'BB' | 'NB';

interface Node {
  readonly id: NodeId;
  readonly key: number;
  readonly colour: 'R' | 'B';
  readonly left: NodeId | null;
  readonly right: NodeId | null;
  readonly origin: number;
}

/**
 * A subtree part-way through an operation: either a node that already exists
 * and is unchanged, a node that will have to be allocated, or nothing.
 *
 * Keeping the two apart is what makes the sharing exact. An untouched subtree
 * stays a `NodeId` and is never looked at again, so a write copies its path
 * and nothing else. It is also what stops nodes being stranded: drafts are
 * shaped first and allocated once, so a node that rebalancing discards was
 * never allocated to begin with.
 */
interface Draft {
  readonly colour: Colour;
  readonly key: number;
  readonly left: Sub;
  readonly right: Sub;
}
type Sub = NodeId | Draft | null;

/** The empty place that is one black short. Never allocated; never survives. */
const DOUBLE_EMPTY: Draft = { colour: 'BB', key: Number.NaN, left: null, right: null };

const BLACKER: Record<Colour, Colour> = { R: 'B', B: 'BB', BB: 'BB', NB: 'R' };
const REDDER: Record<Colour, Colour> = { R: 'NB', B: 'R', BB: 'B', NB: 'NB' };

const draft = (colour: Colour, left: Sub, key: number, right: Sub): Draft =>
  ({ colour, key, left, right });

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Insert keys in the order given, producing version 0.',
    complexity: 'O(n log n)',
    params: [{ name: 'keys', kind: 'int-list' }],
  },
  {
    name: 'insert',
    summary: 'Add a key, recolouring and rotating as needed, producing a new version.',
    complexity: 'O(log n)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'key', kind: 'int' },
    ],
  },
  {
    name: 'erase',
    summary: 'Remove a key, repairing the black height, producing a new version.',
    complexity: 'O(log n)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'key', kind: 'int' },
    ],
  },
  {
    name: 'find',
    summary: 'Look a key up, reporting how many nodes it had to walk.',
    complexity: 'O(log n)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'key', kind: 'int' },
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
  #roots: (NodeId | null)[] = [];
  #next = 0;
  #rebalances = 0;

  reset(): void {
    this.#nodes = new Map();
    this.#roots = [];
    this.#next = 0;
    this.#rebalances = 0;
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getIntList(cmd, 'keys'));
      case 'insert': return this.#insert(getVersion(cmd, 'version'), getInt(cmd, 'key'));
      case 'erase': return this.#erase(getVersion(cmd, 'version'), getInt(cmd, 'key'));
      case 'find': return this.#find(getVersion(cmd, 'version'), getInt(cmd, 'key'));
      case 'compare': return this.#compare(getVersion(cmd, 'a'), getVersion(cmd, 'b'));
      default:
        return failed(err('PARSE_ERROR', `This plugin does not handle "${cmd.name}".`));
    }
  }

  /* ── Reading a subtree, whether or not it exists yet ──────────────── */

  #get(id: NodeId): Node {
    const node = this.#nodes.get(id);
    if (node === undefined) throw new Error(`missing node ${id}`);
    return node;
  }

  /** An empty place counts as black: that is what makes rule 3 well defined. */
  #colour(s: Sub): Colour {
    if (s === null) return 'B';
    return typeof s === 'number' ? this.#get(s as NodeId).colour : s.colour;
  }

  #key(s: Sub): number {
    if (s === null) throw new Error('no key in an empty subtree');
    return typeof s === 'number' ? this.#get(s as NodeId).key : s.key;
  }

  #left(s: Sub): Sub {
    if (s === null) return null;
    return typeof s === 'number' ? this.#get(s as NodeId).left : s.left;
  }

  #right(s: Sub): Sub {
    if (s === null) return null;
    return typeof s === 'number' ? this.#get(s as NodeId).right : s.right;
  }

  #recolour(s: Sub, colour: Colour): Sub {
    if (s === null) return colour === 'BB' ? DOUBLE_EMPTY : null;
    if (s === DOUBLE_EMPTY) return colour === 'BB' ? DOUBLE_EMPTY : null;
    if (this.#colour(s) === colour) return s;
    return draft(colour, this.#left(s), this.#key(s), this.#right(s));
  }

  /* ── Rebalancing ─────────────────────────────────────────────────── */

  /**
   * Repairs one node, given its colour and its two subtrees.
   *
   * The first four cases are the whole of insertion: wherever a red node has
   * a red child, the three keys involved are rearranged into one black-rooted
   * shape with two red children, and the problem - if there still is one -
   * moves one level up. Which of the four it is only decides how the three
   * keys are ordered, and all four produce the same shape.
   *
   * The rest exist for deletion, where a subtree can be one black short.
   */
  #balance(c: Colour, l: Sub, k: number, r: Sub): Sub {
    const red = (s: Sub): boolean => this.#colour(s) === 'R';

    if (c === 'B' || c === 'BB') {
      // Black absorbs one level of the repair; double black absorbs two, so it
      // comes out one shade lighter and the shortfall is settled here.
      const out: Colour = c === 'B' ? 'R' : 'B';

      if (red(l) && red(this.#left(l))) {
        const inner = this.#left(l);
        this.#rebalances += 1;
        return draft(out,
          draft('B', this.#left(inner), this.#key(inner), this.#right(inner)),
          this.#key(l),
          draft('B', this.#right(l), k, r));
      }
      if (red(l) && red(this.#right(l))) {
        const inner = this.#right(l);
        this.#rebalances += 1;
        return draft(out,
          draft('B', this.#left(l), this.#key(l), this.#left(inner)),
          this.#key(inner),
          draft('B', this.#right(inner), k, r));
      }
      if (red(r) && red(this.#left(r))) {
        const inner = this.#left(r);
        this.#rebalances += 1;
        return draft(out,
          draft('B', l, k, this.#left(inner)),
          this.#key(inner),
          draft('B', this.#right(inner), this.#key(r), this.#right(r)));
      }
      if (red(r) && red(this.#right(r))) {
        const inner = this.#right(r);
        this.#rebalances += 1;
        return draft(out,
          draft('B', l, k, this.#left(r)),
          this.#key(r),
          draft('B', this.#left(inner), this.#key(inner), this.#right(inner)));
      }
    }

    /*
     * A negative black subtree is one that has been lightened past red. It can
     * only appear directly under a double black, and it is settled by pushing
     * the borrowed level back down into a fresh red node and balancing again -
     * the one place this function is not a single step.
     */
    if (c === 'BB') {
      if (this.#colour(r) === 'NB'
        && this.#colour(this.#left(r)) === 'B' && this.#colour(this.#right(r)) === 'B') {
        const inner = this.#left(r);
        this.#rebalances += 1;
        return draft('B',
          draft('B', l, k, this.#left(inner)),
          this.#key(inner),
          this.#balance('B', this.#right(inner), this.#key(r), this.#recolour(this.#right(r), 'R')));
      }
      if (this.#colour(l) === 'NB'
        && this.#colour(this.#left(l)) === 'B' && this.#colour(this.#right(l)) === 'B') {
        const inner = this.#right(l);
        this.#rebalances += 1;
        return draft('B',
          this.#balance('B', this.#recolour(this.#left(l), 'R'), this.#key(l), this.#left(inner)),
          this.#key(inner),
          draft('B', this.#right(inner), k, r));
      }
    }

    return draft(c, l, k, r);
  }

  /** Repairs a node whose child came back one black short. */
  #bubble(c: Colour, l: Sub, k: number, r: Sub): Sub {
    if (this.#colour(l) === 'BB' || this.#colour(r) === 'BB') {
      // The shortfall moves up one level: this node darkens, both sides lighten.
      return this.#balance(BLACKER[c],
        this.#recolour(l, REDDER[this.#colour(l)]), k,
        this.#recolour(r, REDDER[this.#colour(r)]));
    }
    return this.#balance(c, l, k, r);
  }

  /* ── Insert and erase, as shapes ─────────────────────────────────── */

  #insertInto(s: Sub, key: number, events: SimEvent[]): Sub {
    if (s === null) {
      // Always red: a new black node would change one path's black height and
      // break rule 3 immediately, where a red one only risks rule 2.
      return draft('R', null, key, null);
    }
    if (typeof s === 'number') events.push({ kind: 'NodeVisited', node: s as NodeId });
    const k = this.#key(s);
    if (key === k) return s;
    return key < k
      ? this.#balance(this.#colour(s), this.#insertInto(this.#left(s), key, events), k, this.#right(s))
      : this.#balance(this.#colour(s), this.#left(s), k, this.#insertInto(this.#right(s), key, events));
  }

  /** Takes out a node that has at most one child, or defers to its predecessor. */
  #removeAt(s: Sub): Sub {
    const c = this.#colour(s);
    const l = this.#left(s);
    const r = this.#right(s);

    if (l === null && r === null) {
      // Removing a red leaf changes no black height. Removing a black one does,
      // and that shortfall is what has to be carried back up.
      return c === 'R' ? null : DOUBLE_EMPTY;
    }
    if (l === null) return this.#recolour(r, 'B');
    if (r === null) return this.#recolour(l, 'B');

    // Two children: take the largest key below on the left instead.
    const { key, rest } = this.#removeMax(l);
    return this.#bubble(c, rest, key, r);
  }

  #removeMax(s: Sub): { readonly key: number; readonly rest: Sub } {
    const r = this.#right(s);
    if (r === null) return { key: this.#key(s), rest: this.#removeAt(s) };
    const found = this.#removeMax(r);
    return { key: found.key, rest: this.#bubble(this.#colour(s), this.#left(s), this.#key(s), found.rest) };
  }

  #eraseFrom(s: Sub, key: number, events: SimEvent[]): Sub {
    if (s === null) return null;
    if (typeof s === 'number') events.push({ kind: 'NodeVisited', node: s as NodeId });
    const k = this.#key(s);
    if (key < k) return this.#bubble(this.#colour(s), this.#eraseFrom(this.#left(s), key, events), k, this.#right(s));
    if (key > k) return this.#bubble(this.#colour(s), this.#left(s), k, this.#eraseFrom(this.#right(s), key, events));
    return this.#removeAt(s);
  }

  /** Rule 1, and the only place a double black is allowed to be discharged. */
  #blacken(s: Sub): Sub {
    if (s === null || s === DOUBLE_EMPTY) return null;
    return this.#recolour(s, 'B');
  }

  /* ── Allocation ──────────────────────────────────────────────────── */

  #alloc(
    key: number, colour: 'R' | 'B', left: NodeId | null, right: NodeId | null,
    origin: number, events: SimEvent[],
  ): NodeId {
    const id = this.#next as NodeId;
    this.#next += 1;
    this.#nodes.set(id, { id, key, colour, left, right, origin });
    events.push({
      kind: 'NodeAllocated',
      node: id,
      value: key,
      // The colour goes in the label as well as the role, because it is the
      // whole invariant and belongs where it can be read off the picture.
      label: colour === 'R' ? 'red' : 'black',
      role: colour === 'R' ? 'red' : 'black',
      slot: `k${key}`,
      origin,
    });
    for (const [slot, child] of [['left', left], ['right', right]] as const) {
      if (child === null) continue;
      events.push({ kind: 'PointerSet', from: id, slot, to: child });
      if (this.#get(child).origin < origin) {
        events.push({ kind: 'NodeReused', node: child, by: id });
      }
    }
    return id;
  }

  /**
   * Turns a shape into nodes. Anything still a `NodeId` already exists and is
   * shared untouched; only the drafts along the rewritten path are allocated.
   */
  #materialise(s: Sub, origin: number, events: SimEvent[]): NodeId | null {
    if (s === null) return null;
    if (typeof s === 'number') return s as NodeId;
    if (s.colour !== 'R' && s.colour !== 'B') {
      // A transient colour reaching allocation would mean the repair never
      // finished. Better to say so than to store a tree that breaks rule 3.
      throw new Error(`unbalanced tree: ${s.colour} survived to allocation`);
    }
    const left = this.#materialise(s.left, origin, events);
    const right = this.#materialise(s.right, origin, events);
    return this.#alloc(s.key, s.colour, left, right, origin, events);
  }

  /* ── Reading the committed tree ──────────────────────────────────── */

  #rootOf(v: number): NodeId | null | undefined {
    return v >= 0 && v < this.#roots.length ? this.#roots[v] : undefined;
  }

  #available(): string {
    return this.#roots.length === 0
      ? 'nothing has been built yet - start with build'
      : `versions v0 to v${this.#roots.length - 1}`;
  }

  #keysOf(id: NodeId | null, out: number[] = []): number[] {
    if (id === null) return out;
    const node = this.#get(id);
    this.#keysOf(node.left, out);
    out.push(node.key);
    this.#keysOf(node.right, out);
    return out;
  }

  #height(id: NodeId | null): number {
    if (id === null) return 0;
    const node = this.#get(id);
    return 1 + Math.max(this.#height(node.left), this.#height(node.right));
  }

  /** Black nodes between here and any empty place. Rule 3 says it is one number. */
  #blackHeight(id: NodeId | null): number {
    if (id === null) return 1;
    const node = this.#get(id);
    return this.#blackHeight(node.left) + (node.colour === 'B' ? 1 : 0);
  }

  #contains(id: NodeId | null, key: number, visited: NodeId[]): boolean {
    let cursor = id;
    while (cursor !== null) {
      const node = this.#get(cursor);
      visited.push(cursor);
      if (node.key === key) return true;
      cursor = key < node.key ? node.left : node.right;
    }
    return false;
  }

  #commit(root: NodeId | null, version: number, events: SimEvent[]): void {
    this.#roots.push(root);
    events.push({ kind: 'VersionCommitted', version, roots: root === null ? [] : [root] });
    events.push({ kind: 'RootsSet', roots: this.#roots.filter((r): r is NodeId => r !== null) });
  }

  /* ── Commands ────────────────────────────────────────────────────── */

  #build(keys: readonly number[]): OperationResult {
    this.reset();
    const events: SimEvent[] = [];

    // Shaped as drafts first and allocated once. Inserting one key at a time
    // through the persistent path would allocate every intermediate tree and
    // strand all of them but the last.
    let shape: Sub = null;
    for (const key of keys) shape = this.#blacken(this.#insertInto(shape, key, []));
    const root = this.#materialise(shape, 0, events);
    this.#commit(root, 0, events);

    return {
      ok: true,
      value: {
        version: 0, size: this.#keysOf(root).length,
        height: this.#height(root), blackHeight: this.#blackHeight(root),
      },
      events,
      statsDelta: { versions: 1, nodesAllocated: this.#nodes.size, height: this.#height(root) },
    };
  }

  #write(
    v: number, key: number, mustExist: boolean,
    shape: (root: NodeId | null, events: SimEvent[]) => Sub,
  ): OperationResult {
    const root = this.#rootOf(v);
    if (root === undefined) {
      return failed(err('UNKNOWN_VERSION', `Version v${v} does not exist.`, this.#available()));
    }
    const present = this.#contains(root, key, []);
    if (present !== mustExist) {
      return failed(mustExist
        ? err('PRECONDITION_FAILED', `Key ${key} is not in v${v}.`,
          `v${v} holds ${this.#keysOf(root).join(', ') || 'nothing'}`)
        : err('PRECONDITION_FAILED', `Key ${key} is already in v${v}.`,
          'this tree holds each key once'));
    }

    const events: SimEvent[] = [];
    const version = this.#roots.length;
    const before = this.#nodes.size;
    this.#rebalances = 0;
    const newRoot = this.#materialise(this.#blacken(shape(root, events)), version, events);
    this.#commit(newRoot, version, events);

    return {
      ok: true,
      value: {
        version, key,
        allocated: this.#nodes.size - before,
        rebalances: this.#rebalances,
        height: this.#height(newRoot),
        blackHeight: this.#blackHeight(newRoot),
      },
      events,
      statsDelta: {
        versions: 1, updates: 1,
        nodesAllocated: this.#nodes.size - before,
        height: this.#height(newRoot),
      },
    };
  }

  #insert(v: number, key: number): OperationResult {
    return this.#write(v, key, false, (root, events) => this.#insertInto(root, key, events));
  }

  #erase(v: number, key: number): OperationResult {
    return this.#write(v, key, true, (root, events) => this.#eraseFrom(root, key, events));
  }

  #find(v: number, key: number): OperationResult {
    const root = this.#rootOf(v);
    if (root === undefined) {
      return failed(err('UNKNOWN_VERSION', `Version v${v} does not exist.`, this.#available()));
    }
    const visited: NodeId[] = [];
    const found = this.#contains(root, key, visited);
    return {
      ok: true,
      value: {
        found, key, visits: visited.length,
        height: this.#height(root), blackHeight: this.#blackHeight(root),
      },
      events: visited.map((id): SimEvent => ({ kind: 'NodeVisited', node: id })),
      statsDelta: { queries: 1, nodeVisits: visited.length, height: this.#height(root) },
    };
  }

  #compare(a: number, b: number): OperationResult {
    const ra = this.#rootOf(a);
    const rb = this.#rootOf(b);
    if (ra === undefined || rb === undefined) {
      return failed(err('UNKNOWN_VERSION',
        `Version v${ra === undefined ? a : b} does not exist.`, this.#available()));
    }
    const diff = diffRoots(this.getStructure(), ra === null ? [] : [ra], rb === null ? [] : [rb]);
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

    for (const node of this.#nodes.values()) {
      nodes.push({
        id: node.id,
        label: node.colour === 'R' ? 'red' : 'black',
        value: node.key,
        role: node.colour === 'R' ? 'red' : 'black',
        slot: `k${node.key}`,
        origin: node.origin,
        order: node.key,
      });
      for (const [slot, child] of [['left', node.left], ['right', node.right]] as const) {
        if (child === null) continue;
        edges.push({
          from: node.id, to: child, slot,
          reused: this.#get(child).origin < node.origin,
        });
      }
    }

    return {
      layout: 'dag',
      nodes,
      edges,
      roots: this.#roots.filter((r): r is NodeId => r !== null),
    };
  }

  serialize(): SerializedState {
    return {
      schemaVersion: SCHEMA_VERSION,
      pluginId: 'persistent-rbt',
      data: { versions: this.#roots.map((r) => this.#keysOf(r)) },
    };
  }
}

export const persistentRbt: AlgorithmPlugin = {
  meta: {
    id: 'persistent-rbt',
    name: 'Persistent Red-Black',
    category: 'Balanced trees',
    summary: 'One bit per node, three rules, and a tree that is never more than twice as deep as it must be.',
  },
  commands: COMMANDS,
  explain: explainRbt,
  benchmark: {
    sizes: [8, 16, 32, 64, 128, 256],
    command: 'find',
    // The same sorted input the plain BST degenerates on, so the three charts
    // - BST, AVL, red-black - can be read against one another.
    setup: (n: number): readonly string[] =>
      [`build [${Array.from({ length: n }, (_, i) => i + 1).join(' ')}]`],
    probes: (n: number): readonly string[] => [`find v0 ${n}`],
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
