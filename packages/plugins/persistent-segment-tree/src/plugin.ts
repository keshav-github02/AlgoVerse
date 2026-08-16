/**
 * Persistent segment tree.
 *
 * Every update copies the O(log n) root-to-leaf path and reuses the rest of
 * the previous version, so all earlier versions stay readable. Each operation
 * reports its result, its event log, and a statistics delta; it never touches
 * the UI and never mutates a node that already exists.
 *
 * ## Lazy tags, without pushing them down
 *
 * A range update marks the O(log n) nodes that cover the range with a pending
 * add rather than touching everything below them. The textbook then *pushes*
 * that tag down on the next visit - and that is exactly what a persistent
 * structure cannot do, because the nodes below are shared with every earlier
 * version and pushing would rewrite their past.
 *
 * So nothing is ever pushed. A tag stays on the node that received it, and a
 * query adds up the tags it passes on the way down. The two ideas fit together
 * better than they do in the mutable case: not pushing is what makes a range
 * update O(log n) *allocations* rather than O(log n) now and an unbounded
 * rewrite later.
 *
 * The consequence worth knowing is that **a node's number is not its range's
 * total**. It is the total of everything at or below it, and the tags above it
 * still have to be added in. That is what the tree stores, so that is what is
 * drawn.
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
import { explainSegmentTree } from './explain.ts';

const SCHEMA_VERSION = 1;

interface Node {
  readonly id: NodeId;
  readonly lo: number;
  readonly hi: number;
  /** Sum of this range, counting this node's tag and every tag below it. */
  readonly value: number;
  readonly min: number;
  readonly max: number;
  /**
   * A pending add covering this whole range. Already counted in the three
   * figures above, and not counted in any child - which is the entire trick.
   */
  readonly lazy: number;
  readonly left: NodeId | null;
  readonly right: NodeId | null;
  readonly origin: number;
  readonly depth: number;
}

/** What a node holds, before it has an identity. */
interface Fold {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly lazy: number;
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
    name: 'apply',
    summary: 'Add a delta across a range, producing a new version.',
    complexity: 'O(log n)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'lo', kind: 'int' },
      { name: 'hi', kind: 'int' },
      { name: 'delta', kind: 'int' },
    ],
  },
  {
    name: 'min',
    summary: 'Smallest value in a half-open range.',
    complexity: 'O(log n)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'lo', kind: 'int' },
      { name: 'hi', kind: 'int' },
    ],
  },
  {
    name: 'max',
    summary: 'Largest value in a half-open range.',
    complexity: 'O(log n)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'lo', kind: 'int' },
      { name: 'hi', kind: 'int' },
    ],
  },
  {
    name: 'kth',
    summary: 'First index whose running total reaches k, found by descending once.',
    complexity: 'O(log n)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'k', kind: 'int' },
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
      case 'query': return this.#fold(getVersion(cmd, 'version'), getInt(cmd, 'lo'), getInt(cmd, 'hi'), 'sum');
      case 'min': return this.#fold(getVersion(cmd, 'version'), getInt(cmd, 'lo'), getInt(cmd, 'hi'), 'min');
      case 'max': return this.#fold(getVersion(cmd, 'version'), getInt(cmd, 'lo'), getInt(cmd, 'hi'), 'max');
      case 'apply':
        return this.#apply(getVersion(cmd, 'version'), getInt(cmd, 'lo'), getInt(cmd, 'hi'), getInt(cmd, 'delta'));
      case 'kth': return this.#kth(getVersion(cmd, 'version'), getInt(cmd, 'k'));
      case 'compare': return this.#compare(getVersion(cmd, 'a'), getVersion(cmd, 'b'));
      default:
        return failed(err('PARSE_ERROR', `This plugin does not handle "${cmd.name}".`));
    }
  }

  /* ── Helpers ─────────────────────────────────────────────────────── */

  #versions(): string {
    return this.#roots.length === 0
      ? 'nothing is built yet - start with build'
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

  /** A range with a tag says so, because the tag is the surprising part. */
  #label(lo: number, hi: number, lazy: number): string {
    const span = this.#span(lo, hi);
    return lazy === 0 ? span : `${span} ${lazy > 0 ? '+' : ''}${lazy}`;
  }

  #alloc(
    lo: number, hi: number, fold: Fold, left: NodeId | null, right: NodeId | null,
    origin: number, depth: number, events: SimEvent[],
  ): Node {
    const id = this.#next as NodeId;
    this.#next += 1;
    const node: Node = {
      id, lo, hi, value: fold.value, min: fold.min, max: fold.max, lazy: fold.lazy,
      left, right, origin, depth,
    };
    this.#nodes.set(id, node);
    events.push({
      kind: 'NodeAllocated',
      node: id,
      value: fold.value,
      label: this.#label(lo, hi, fold.lazy),
      role: fold.lazy !== 0 ? 'tagged' : hi - lo === 1 ? 'leaf' : 'internal',
      depth,
      slot: this.#slot(lo, hi, depth),
      origin,
    });
    if (left !== null) events.push({ kind: 'PointerSet', from: id, slot: 'left', to: left });
    if (right !== null) events.push({ kind: 'PointerSet', from: id, slot: 'right', to: right });
    return node;
  }

  /** What a node holds, given its children and its own tag. */
  #combine(l: Node, r: Node, lazy: number, span: number): Fold {
    return {
      value: l.value + r.value + lazy * span,
      min: Math.min(l.min, r.min) + lazy,
      max: Math.max(l.max, r.max) + lazy,
      lazy,
    };
  }

  #leaf(value: number): Fold {
    return { value, min: value, max: value, lazy: 0 };
  }

  #kid(id: NodeId | null): Node {
    return this.#nodes.get(id as NodeId) as Node;
  }

  /* ── Commands ────────────────────────────────────────────────────── */

  #build(values: readonly number[]): OperationResult {
    this.reset();
    const events: SimEvent[] = [];
    const build = (lo: number, hi: number, depth: number): Node => {
      if (hi - lo === 1) {
        return this.#alloc(lo, hi, this.#leaf(values[lo] as number), null, null, 0, depth, events);
      }
      const mid = (lo + hi) >> 1;
      const l = build(lo, mid, depth + 1);
      const r = build(mid, hi, depth + 1);
      return this.#alloc(lo, hi, this.#combine(l, r, 0, hi - lo), l.id, r.id, 0, depth, events);
    };

    const root = build(0, values.length, 0);
    this.#size = values.length;
    this.#roots.push(root.id);
    events.push({ kind: 'VersionCommitted', version: 0, roots: [root.id] });
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

    /*
     * `carried` is the sum of the tags on the way down, which is the part of
     * this index's value that lives above the leaf. Writing v means storing
     * v - carried, so that adding the tags back gives v again.
     */
    const copy = (node: Node, carried: number): Node => {
      events.push({ kind: 'NodeVisited', node: node.id });
      if (node.hi - node.lo === 1) {
        allocated += 1;
        return this.#alloc(node.lo, node.hi, this.#leaf(value - carried), null, null, version, node.depth, events);
      }
      const mid = (node.lo + node.hi) >> 1;
      const goLeft = index < mid;
      const below = carried + node.lazy;
      const l = goLeft ? copy(this.#kid(node.left), below) : this.#kid(node.left);
      const r = goLeft ? this.#kid(node.right) : copy(this.#kid(node.right), below);
      allocated += 1;
      const made = this.#alloc(node.lo, node.hi,
        this.#combine(l, r, node.lazy, node.hi - node.lo), l.id, r.id, version, node.depth, events);
      reused += 1;
      events.push({ kind: 'NodeReused', node: goLeft ? r.id : l.id, by: made.id });
      return made;
    };

    const newRoot = copy(root, 0);
    this.#roots.push(newRoot.id);
    events.push({ kind: 'VersionCommitted', version, roots: [newRoot.id] });
    events.push({ kind: 'RootsSet', roots: [...this.#roots] });

    return {
      ok: true,
      value: { version, sum: newRoot.value, allocated, reused },
      events,
      statsDelta: { versions: 1, updates: 1, nodesAllocated: allocated, nodesReused: reused, nodeVisits: allocated },
    };
  }

  #fold(v: number, lo: number, hi: number, what: 'sum' | 'min' | 'max'): OperationResult {
    const root = this.#root(v);
    if (!('id' in root)) return failed(root);
    if (lo < 0 || hi > this.#size || lo >= hi) {
      return failed(err('INVALID_RANGE',
        `Range [${lo},${hi}) is not a valid half-open range inside 0..${this.#size}.`,
        'lo must be less than hi, and both within the structure'));
    }

    const events: SimEvent[] = [];
    let visits = 0;
    const empty = what === 'sum' ? 0 : what === 'min' ? Infinity : -Infinity;
    const join = (a: number, b: number): number =>
      what === 'sum' ? a + b : what === 'min' ? Math.min(a, b) : Math.max(a, b);

    /*
     * `carried` is the tags collected on the way down. A covered node's own
     * figures already hold everything at or below it, so all that is left is
     * to add in what was picked up above it.
     */
    const walk = (node: Node, carried: number): number => {
      visits += 1;
      events.push({ kind: 'NodeVisited', node: node.id });
      if (hi <= node.lo || node.hi <= lo) return empty;
      if (lo <= node.lo && node.hi <= hi) {
        const own = what === 'sum' ? node.value : what === 'min' ? node.min : node.max;
        return what === 'sum' ? own + carried * (node.hi - node.lo) : own + carried;
      }
      const below = carried + node.lazy;
      return join(walk(this.#kid(node.left), below), walk(this.#kid(node.right), below));
    };

    const answer = walk(root, 0);
    return {
      ok: true,
      value: what === 'sum' ? { sum: answer, visits } : { [what]: answer, visits },
      events,
      statsDelta: { queries: 1, nodeVisits: visits },
    };
  }

  #apply(v: number, lo: number, hi: number, delta: number): OperationResult {
    const root = this.#root(v);
    if (!('id' in root)) return failed(root);
    if (lo < 0 || hi > this.#size || lo >= hi) {
      return failed(err('INVALID_RANGE',
        `Range [${lo},${hi}) is not a valid half-open range inside 0..${this.#size}.`,
        'lo must be less than hi, and both within the structure'));
    }

    const events: SimEvent[] = [];
    const version = this.#roots.length;
    let allocated = 0;
    let reused = 0;
    let tagged = 0;

    const rewrite = (node: Node): Node => {
      // Outside the range: hand back the very same node, untouched.
      if (hi <= node.lo || node.hi <= lo) return node;
      events.push({ kind: 'NodeVisited', node: node.id });

      if (lo <= node.lo && node.hi <= hi) {
        /*
         * Covered. One new node carries the tag and keeps both children as
         * they are - the whole subtree below is shared with the previous
         * version, which is why this costs O(log n) nodes rather than the
         * width of the range.
         */
        allocated += 1;
        tagged += 1;
        const made = this.#alloc(node.lo, node.hi, {
          value: node.value + delta * (node.hi - node.lo),
          min: node.min + delta,
          max: node.max + delta,
          lazy: node.lazy + delta,
        }, node.left, node.right, version, node.depth, events);
        for (const child of [node.left, node.right]) {
          if (child === null) continue;
          reused += 1;
          events.push({ kind: 'NodeReused', node: child, by: made.id });
        }
        return made;
      }

      const l = rewrite(this.#kid(node.left));
      const r = rewrite(this.#kid(node.right));
      allocated += 1;
      const made = this.#alloc(node.lo, node.hi,
        this.#combine(l, r, node.lazy, node.hi - node.lo), l.id, r.id, version, node.depth, events);
      for (const [was, now] of [[node.left, l.id], [node.right, r.id]] as const) {
        if (was === now) {
          reused += 1;
          events.push({ kind: 'NodeReused', node: was as NodeId, by: made.id });
        }
      }
      return made;
    };

    const newRoot = rewrite(root);
    this.#roots.push(newRoot.id);
    events.push({ kind: 'VersionCommitted', version, roots: [newRoot.id] });
    events.push({ kind: 'RootsSet', roots: [...this.#roots] });

    return {
      ok: true,
      value: { version, sum: newRoot.value, allocated, reused, tagged },
      events,
      statsDelta: {
        versions: 1, updates: 1, nodesAllocated: allocated, nodesReused: reused, nodeVisits: allocated,
      },
    };
  }

  #kth(v: number, k: number): OperationResult {
    const root = this.#root(v);
    if (!('id' in root)) return failed(root);
    if (k < 1) {
      return failed(err('BAD_ARGUMENT', `k must be at least 1; ${k} was given.`,
        'k counts from one, so k = 1 asks for the first index carrying any weight'));
    }
    /*
     * The descent needs running totals to be non-decreasing, which holds
     * only when nothing is negative. The smallest value in the whole range
     * is already on the root, so the precondition costs nothing to check.
     */
    if (root.min < 0) {
      return failed(err('PRECONDITION_FAILED',
        `This version holds a negative value (${root.min}), so running totals do not only rise.`,
        'kth descends by comparing against the left half, which needs every value to be at least 0'));
    }
    if (root.value < k) {
      return failed(err('PRECONDITION_FAILED',
        `The whole range totals ${root.value}, which never reaches ${k}.`,
        'ask for a k no larger than the total'));
    }

    const events: SimEvent[] = [];
    let remaining = k;
    let node = root;
    let carried = 0;
    let visits = 0;

    while (node.hi - node.lo > 1) {
      visits += 1;
      events.push({ kind: 'NodeVisited', node: node.id });
      const below = carried + node.lazy;
      const l = this.#kid(node.left);
      const leftTotal = l.value + below * (l.hi - l.lo);
      if (remaining <= leftTotal) {
        node = l;
      } else {
        remaining -= leftTotal;
        node = this.#kid(node.right);
      }
      carried = below;
    }
    visits += 1;
    events.push({ kind: 'NodeVisited', node: node.id });

    return {
      ok: true,
      // One walk from the root, not a query per candidate index.
      value: { k, index: node.lo, visits },
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
    // re-implemented per plugin - and the diff view uses the same function.
    const diff = diffRoots(this.getStructure(), [ra.id], [rb.id]);
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
        label: this.#label(n.lo, n.hi, n.lazy),
        value: n.value,
        role: n.lazy !== 0 ? 'tagged' : n.hi - n.lo === 1 ? 'leaf' : 'internal',
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
          min: n.min, max: n.max, lazy: n.lazy,
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
  explain: explainSegmentTree,
  benchmark: {
    sizes: [8, 16, 32, 64, 128, 256],
    command: 'query',
    setup: (n: number): readonly string[] => [`build [${Array.from({ length: n }, (_, i) => (i % 9) + 1).join(' ')}]`],
    // [1, n-1) straddles both halves at every level, so the descent cannot
    // stop early the way a whole-range query would.
    probes: (n: number): readonly string[] => [`query v0 1 ${n - 1}`],
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
