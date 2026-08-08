/**
 * Persistent treap.
 *
 * A binary search tree by key and a heap by priority, where the priorities are
 * random - so the shape is balanced in expectation without any rebalancing
 * rules. Insert descends and splits once where the new key outranks; erase
 * descends and merges once at the key removed. Both copy only the path they
 * walk and share everything else.
 *
 * This is the first plugin that draws from `ctx.rng`. It has to: a treap that
 * read `Math.random()` would replay differently from the run its author saw,
 * which would silently break every shared link.
 */

import {
  diffRoots, getInt, getIntList, getVersion,
  type CommandSpec, type NodeId, type OperationError, type ParsedCommand, type Rng,
  type SimEvent,
} from '@algoverse/core';
import {
  failed,
  type AlgorithmPlugin, type EngineContext, type OperationResult,
  type PluginInstance, type SerializedState,
  type StructureEdge, type StructureGraph, type StructureNode,
} from '@algoverse/plugin-sdk';
import { explainTreap } from './explain.ts';

const SCHEMA_VERSION = 1;

interface Node {
  readonly id: NodeId;
  readonly key: number;
  readonly priority: number;
  readonly left: NodeId | null;
  readonly right: NodeId | null;
  readonly origin: number;
}

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Insert several keys, producing version 0.',
    complexity: 'O(n log n)',
    params: [{ name: 'keys', kind: 'int-list' }],
  },
  {
    name: 'insert',
    summary: 'Add a key, producing a new version.',
    complexity: 'O(log n) expected',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'key', kind: 'int' },
    ],
  },
  {
    name: 'erase',
    summary: 'Remove a key, producing a new version.',
    complexity: 'O(log n) expected',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'key', kind: 'int' },
    ],
  },
  {
    name: 'find',
    summary: 'Look a key up in a version.',
    complexity: 'O(log n) expected',
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
  readonly #rng: Rng;
  #nodes = new Map<NodeId, Node>();
  #roots: (NodeId | null)[] = [];
  /** Priorities are drawn once per key, so re-inserting a key cannot reshape history. */
  #priorities = new Map<number, number>();
  #next = 0;

  constructor(rng: Rng) {
    this.#rng = rng;
  }

  reset(): void {
    this.#nodes = new Map();
    this.#roots = [];
    this.#priorities = new Map();
    this.#next = 0;
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

  /* ── Helpers ─────────────────────────────────────────────────────── */

  #available(): string {
    return this.#roots.length === 0
      ? 'nothing is built yet - start with build'
      : `versions available: ${this.#roots.map((_, i) => `v${i}`).join(', ')}`;
  }

  #rootOf(v: number): NodeId | null | undefined {
    return v >= 0 && v < this.#roots.length ? this.#roots[v] : undefined;
  }

  #get(id: NodeId): Node {
    return this.#nodes.get(id) as Node;
  }

  #priorityFor(key: number): number {
    const existing = this.#priorities.get(key);
    if (existing !== undefined) return existing;
    const drawn = this.#rng.nextInt(0, 1_000_000);
    this.#priorities.set(key, drawn);
    return drawn;
  }

  #alloc(
    key: number, priority: number, left: NodeId | null, right: NodeId | null,
    origin: number, events: SimEvent[],
  ): Node {
    const id = this.#next as NodeId;
    this.#next += 1;
    const node: Node = { id, key, priority, left, right, origin };
    this.#nodes.set(id, node);
    events.push({
      kind: 'NodeAllocated',
      node: id,
      value: key,
      label: `${key}`,
      role: left === null && right === null ? 'leaf' : 'internal',
      // Depth is deliberately absent: a shared subtree sits at different depths
      // in different versions, so no single number is true. Layout derives it.
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
    return node;
  }

  /** Keys < key go left, the rest go right. Copies the path it walks. */
  #split(
    id: NodeId | null, key: number, origin: number, events: SimEvent[],
  ): [NodeId | null, NodeId | null] {
    if (id === null) return [null, null];
    const node = this.#get(id);
    events.push({ kind: 'NodeVisited', node: id });
    if (node.key < key) {
      const [a, b] = this.#split(node.right, key, origin, events);
      return [this.#alloc(node.key, node.priority, node.left, a, origin, events).id, b];
    }
    const [a, b] = this.#split(node.left, key, origin, events);
    return [a, this.#alloc(node.key, node.priority, b, node.right, origin, events).id];
  }

  /**
   * Insert by descent, splitting only where the new key outranks the node it
   * reached. The obvious alternative - split the whole tree, then merge the new
   * node back in - copies every path twice and orphans the first copy; with a
   * five-key tree that left 64% of the allocated nodes unreachable. Here every
   * node allocated ends up in the new version.
   */
  #insertInto(
    id: NodeId | null, key: number, priority: number, origin: number, events: SimEvent[],
  ): NodeId {
    if (id === null) return this.#alloc(key, priority, null, null, origin, events).id;
    const node = this.#get(id);

    if (priority > node.priority) {
      // The new key belongs here. Split what is below it into its two children.
      const [l, r] = this.#split(id, key, origin, events);
      return this.#alloc(key, priority, l, r, origin, events).id;
    }

    events.push({ kind: 'NodeVisited', node: id });
    if (key < node.key) {
      const left = this.#insertInto(node.left, key, priority, origin, events);
      return this.#alloc(node.key, node.priority, left, node.right, origin, events).id;
    }
    const right = this.#insertInto(node.right, key, priority, origin, events);
    return this.#alloc(node.key, node.priority, node.left, right, origin, events).id;
  }

  /** Erase by descent, merging only the two children of the node removed. */
  #eraseFrom(
    id: NodeId | null, key: number, origin: number, events: SimEvent[],
  ): NodeId | null {
    if (id === null) return null;
    const node = this.#get(id);
    events.push({ kind: 'NodeVisited', node: id });

    if (node.key === key) return this.#merge(node.left, node.right, origin, events);
    if (key < node.key) {
      const left = this.#eraseFrom(node.left, key, origin, events);
      return this.#alloc(node.key, node.priority, left, node.right, origin, events).id;
    }
    const right = this.#eraseFrom(node.right, key, origin, events);
    return this.#alloc(node.key, node.priority, node.left, right, origin, events).id;
  }

  /** Every key in `a` must be below every key in `b`. */
  #merge(a: NodeId | null, b: NodeId | null, origin: number, events: SimEvent[]): NodeId | null {
    if (a === null) return b;
    if (b === null) return a;
    const left = this.#get(a);
    const right = this.#get(b);
    if (left.priority > right.priority) {
      const merged = this.#merge(left.right, b, origin, events);
      return this.#alloc(left.key, left.priority, left.left, merged, origin, events).id;
    }
    const merged = this.#merge(a, right.left, origin, events);
    return this.#alloc(right.key, right.priority, merged, right.right, origin, events).id;
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

  #keysOf(id: NodeId | null, out: number[] = []): number[] {
    if (id === null) return out;
    const node = this.#get(id);
    this.#keysOf(node.left, out);
    out.push(node.key);
    this.#keysOf(node.right, out);
    return out;
  }

  #commit(root: NodeId | null, version: number, events: SimEvent[]): void {
    this.#roots.push(root);
    events.push({ kind: 'VersionCommitted', version, roots: root === null ? [] : [root] });
    events.push({
      kind: 'RootsSet',
      roots: this.#roots.filter((r): r is NodeId => r !== null),
    });
  }

  /* ── Commands ────────────────────────────────────────────────────── */

  #build(keys: readonly number[]): OperationResult {
    this.reset();
    const events: SimEvent[] = [];
    /**
     * Built directly rather than by repeated insertion. Inserting one key at a
     * time path-copies each step and commits only the last root, stranding
     * every intermediate tree - with five keys that was a third of the nodes.
     * Recursing on the highest priority allocates each node exactly once, with
     * its children already known.
     */
    const sorted = [...new Set(keys)].sort((a, b) => a - b);
    const construct = (lo: number, hi: number): NodeId | null => {
      if (lo >= hi) return null;
      let top = lo;
      for (let i = lo + 1; i < hi; i += 1) {
        if (this.#priorityFor(sorted[i] as number) > this.#priorityFor(sorted[top] as number)) top = i;
      }
      const left = construct(lo, top);
      const right = construct(top + 1, hi);
      const key = sorted[top] as number;
      return this.#alloc(key, this.#priorityFor(key), left, right, 0, events).id;
    };
    const root = construct(0, sorted.length);
    this.#commit(root, 0, events);

    return {
      ok: true,
      value: { version: 0, size: this.#keysOf(root).length },
      events,
      statsDelta: {
        versions: 1,
        nodesAllocated: this.#nodes.size,
        height: this.#heightOf(root),
      },
    };
  }

  #insert(v: number, key: number): OperationResult {
    const root = this.#rootOf(v);
    if (root === undefined) {
      return failed(err('UNKNOWN_VERSION', `Version v${v} does not exist.`, this.#available()));
    }
    if (this.#contains(root, key, [])) {
      return failed(err('PRECONDITION_FAILED', `Key ${key} is already in v${v}.`,
        'a treap holds each key once'));
    }

    const events: SimEvent[] = [];
    const version = this.#roots.length;
    const before = this.#nodes.size;
    const priority = this.#priorityFor(key);
    const merged = this.#insertInto(root, key, priority, version, events);
    this.#commit(merged, version, events);

    const allocated = this.#nodes.size - before;
    return {
      ok: true,
      value: { version, key, priority, allocated },
      events,
      statsDelta: {
        versions: 1, updates: 1, nodesAllocated: allocated, height: this.#heightOf(merged),
      },
    };
  }

  #erase(v: number, key: number): OperationResult {
    const root = this.#rootOf(v);
    if (root === undefined) {
      return failed(err('UNKNOWN_VERSION', `Version v${v} does not exist.`, this.#available()));
    }
    if (!this.#contains(root, key, [])) {
      return failed(err('PRECONDITION_FAILED', `Key ${key} is not in v${v}.`,
        `v${v} holds ${this.#keysOf(root).join(', ') || 'nothing'}`));
    }

    const events: SimEvent[] = [];
    const version = this.#roots.length;
    const before = this.#nodes.size;
    const merged = this.#eraseFrom(root, key, version, events);
    this.#commit(merged, version, events);

    const allocated = this.#nodes.size - before;
    return {
      ok: true,
      value: { version, key, allocated },
      events,
      statsDelta: {
        versions: 1, updates: 1, nodesAllocated: allocated, height: this.#heightOf(merged),
      },
    };
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
      value: { found, key, visits: visited.length },
      events: visited.map((id): SimEvent => ({ kind: 'NodeVisited', node: id })),
      statsDelta: { queries: 1, nodeVisits: visited.length },
    };
  }

  #compare(a: number, b: number): OperationResult {
    const ra = this.#rootOf(a);
    const rb = this.#rootOf(b);
    if (ra === undefined || rb === undefined) {
      return failed(err('UNKNOWN_VERSION',
        `Version v${ra === undefined ? a : b} does not exist.`, this.#available()));
    }
    const diff = diffRoots(
      this.getStructure(),
      ra === null ? [] : [ra],
      rb === null ? [] : [rb],
    );
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

  #heightOf(id: NodeId | null): number {
    if (id === null) return 0;
    const node = this.#get(id);
    return 1 + Math.max(this.#heightOf(node.left), this.#heightOf(node.right));
  }

  /* ── Views ───────────────────────────────────────────────────────── */

  getStructure(): StructureGraph {
    const nodes: StructureNode[] = [];
    const edges: StructureEdge[] = [];

    for (const node of this.#nodes.values()) {
      nodes.push({
        id: node.id,
        label: `${node.key}`,
        value: node.key,
        role: node.left === null && node.right === null ? 'leaf' : 'internal',
        slot: `k${node.key}`,
        origin: node.origin,
        // A binary search tree reads left to right by key, whatever its shape.
        order: node.key,
      });
      for (const [slot, child] of [['left', node.left], ['right', node.right]] as const) {
        if (child === null) continue;
        edges.push({
          from: node.id,
          to: child,
          slot,
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
      pluginId: 'persistent-treap',
      data: {
        versions: this.#roots.map((r) => this.#keysOf(r)),
        priorities: [...this.#priorities.entries()].sort((a, b) => a[0] - b[0]),
      },
    };
  }
}

export const persistentTreap: AlgorithmPlugin = {
  meta: {
    id: 'persistent-treap',
    name: 'Persistent Treap',
    category: 'Persistent structures',
    summary: 'A balanced search tree that stays balanced by chance rather than by rules.',
  },
  commands: COMMANDS,
  explain: explainTreap,
  createInstance: (ctx: EngineContext): PluginInstance => new Instance(ctx.rng),
};
