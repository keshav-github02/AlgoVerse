/**
 * Persistent binary search tree — unbalanced, on purpose.
 *
 * This is the treap with the randomness taken out, and it exists to show what
 * that randomness was buying. Insert keys in sorted order and every node has
 * one child: the tree degenerates into a linked list, `find` walks all of it,
 * and the O(log n) everyone quotes for a search tree becomes O(n).
 *
 * Shape depends entirely on insertion order, which is why `build` inserts in
 * the order given rather than sorting first. Sorting would hide the effect the
 * plugin is here to demonstrate.
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
import { explainBst } from './explain.ts';

const SCHEMA_VERSION = 1;

interface Node {
  readonly id: NodeId;
  readonly key: number;
  readonly left: NodeId | null;
  readonly right: NodeId | null;
  readonly origin: number;
}

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Insert keys in the order given, producing version 0.',
    complexity: 'O(n²) worst case',
    params: [{ name: 'keys', kind: 'int-list' }],
  },
  {
    name: 'insert',
    summary: 'Add a key, producing a new version.',
    complexity: 'O(height)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'key', kind: 'int' },
    ],
  },
  {
    name: 'erase',
    summary: 'Remove a key, producing a new version.',
    complexity: 'O(height)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'key', kind: 'int' },
    ],
  },
  {
    name: 'find',
    summary: 'Look a key up, reporting how many nodes it had to walk.',
    complexity: 'O(height)',
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

  reset(): void {
    this.#nodes = new Map();
    this.#roots = [];
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

  #alloc(
    key: number, left: NodeId | null, right: NodeId | null, origin: number, events: SimEvent[],
  ): Node {
    const id = this.#next as NodeId;
    this.#next += 1;
    const node: Node = { id, key, left, right, origin };
    this.#nodes.set(id, node);
    events.push({
      kind: 'NodeAllocated',
      node: id,
      value: key,
      label: `${key}`,
      role: left === null && right === null ? 'leaf' : 'internal',
      // No depth: a shared subtree hangs at different depths in different
      // versions, so layout derives it.
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

  #heightOf(id: NodeId | null): number {
    if (id === null) return 0;
    const node = this.#get(id);
    return 1 + Math.max(this.#heightOf(node.left), this.#heightOf(node.right));
  }

  #keysOf(id: NodeId | null, out: number[] = []): number[] {
    if (id === null) return out;
    const node = this.#get(id);
    this.#keysOf(node.left, out);
    out.push(node.key);
    this.#keysOf(node.right, out);
    return out;
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

  #insertInto(id: NodeId | null, key: number, origin: number, events: SimEvent[]): NodeId {
    if (id === null) return this.#alloc(key, null, null, origin, events).id;
    const node = this.#get(id);
    events.push({ kind: 'NodeVisited', node: id });
    if (key < node.key) {
      const left = this.#insertInto(node.left, key, origin, events);
      return this.#alloc(node.key, left, node.right, origin, events).id;
    }
    const right = this.#insertInto(node.right, key, origin, events);
    return this.#alloc(node.key, node.left, right, origin, events).id;
  }

  /** Smallest key in a subtree, copying the path so the caller can rebuild it. */
  #detachMin(id: NodeId, origin: number, events: SimEvent[]): { key: number; rest: NodeId | null } {
    const node = this.#get(id);
    events.push({ kind: 'NodeVisited', node: id });
    if (node.left === null) return { key: node.key, rest: node.right };
    const { key, rest } = this.#detachMin(node.left, origin, events);
    return { key, rest: this.#alloc(node.key, rest, node.right, origin, events).id };
  }

  #eraseFrom(id: NodeId | null, key: number, origin: number, events: SimEvent[]): NodeId | null {
    if (id === null) return null;
    const node = this.#get(id);
    events.push({ kind: 'NodeVisited', node: id });

    if (key < node.key) {
      const left = this.#eraseFrom(node.left, key, origin, events);
      return this.#alloc(node.key, left, node.right, origin, events).id;
    }
    if (key > node.key) {
      const right = this.#eraseFrom(node.right, key, origin, events);
      return this.#alloc(node.key, node.left, right, origin, events).id;
    }

    if (node.left === null) return node.right;
    if (node.right === null) return node.left;
    // Two children: the in-order successor takes this node's place.
    const { key: successor, rest } = this.#detachMin(node.right, origin, events);
    return this.#alloc(successor, node.left, rest, origin, events).id;
  }

  /* ── Commands ────────────────────────────────────────────────────── */

  #build(keys: readonly number[]): OperationResult {
    this.reset();
    const events: SimEvent[] = [];

    /**
     * Shaped first, allocated second: inserting one key at a time would
     * path-copy on every insert and strand the intermediate trees. The draft
     * keeps insertion order, because that order is what decides the shape.
     */
    interface Draft { readonly key: number; left: Draft | null; right: Draft | null }
    let draft: Draft | null = null;
    for (const key of keys) {
      const fresh: Draft = { key, left: null, right: null };
      if (draft === null) { draft = fresh; continue; }
      let cursor = draft;
      for (;;) {
        if (key === cursor.key) break;
        if (key < cursor.key) {
          if (cursor.left === null) { cursor.left = fresh; break; }
          cursor = cursor.left;
        } else {
          if (cursor.right === null) { cursor.right = fresh; break; }
          cursor = cursor.right;
        }
      }
    }

    const construct = (node: Draft | null): NodeId | null => {
      if (node === null) return null;
      const left = construct(node.left);
      const right = construct(node.right);
      return this.#alloc(node.key, left, right, 0, events).id;
    };
    const root = construct(draft);

    this.#roots.push(root);
    events.push({ kind: 'VersionCommitted', version: 0, roots: root === null ? [] : [root] });
    events.push({ kind: 'RootsSet', roots: this.#roots.filter((r): r is NodeId => r !== null) });

    const height = this.#heightOf(root);
    const size = this.#keysOf(root).length;
    return {
      ok: true,
      value: { version: 0, size, height, degenerate: size > 2 && height === size },
      events,
      statsDelta: { versions: 1, nodesAllocated: this.#nodes.size, height },
    };
  }

  #insert(v: number, key: number): OperationResult {
    const root = this.#rootOf(v);
    if (root === undefined) {
      return failed(err('UNKNOWN_VERSION', `Version v${v} does not exist.`, this.#available()));
    }
    if (this.#contains(root, key, [])) {
      return failed(err('PRECONDITION_FAILED', `Key ${key} is already in v${v}.`,
        'this tree holds each key once'));
    }

    const events: SimEvent[] = [];
    const version = this.#roots.length;
    const before = this.#nodes.size;
    const newRoot = this.#insertInto(root, key, version, events);
    this.#roots.push(newRoot);
    events.push({ kind: 'VersionCommitted', version, roots: [newRoot] });
    events.push({ kind: 'RootsSet', roots: this.#roots.filter((r): r is NodeId => r !== null) });

    const height = this.#heightOf(newRoot);
    return {
      ok: true,
      value: { version, key, allocated: this.#nodes.size - before, height },
      events,
      statsDelta: {
        versions: 1, updates: 1, nodesAllocated: this.#nodes.size - before, height,
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
    const newRoot = this.#eraseFrom(root, key, version, events);
    this.#roots.push(newRoot);
    events.push({ kind: 'VersionCommitted', version, roots: newRoot === null ? [] : [newRoot] });
    events.push({ kind: 'RootsSet', roots: this.#roots.filter((r): r is NodeId => r !== null) });

    const height = this.#heightOf(newRoot);
    return {
      ok: true,
      value: { version, key, allocated: this.#nodes.size - before, height },
      events,
      statsDelta: {
        versions: 1, updates: 1, nodesAllocated: this.#nodes.size - before, height,
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
    const height = this.#heightOf(root);
    return {
      ok: true,
      value: { found, key, visits: visited.length, height },
      events: visited.map((id): SimEvent => ({ kind: 'NodeVisited', node: id })),
      statsDelta: { queries: 1, nodeVisits: visited.length, height },
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
        label: `${node.key}`,
        value: node.key,
        role: node.left === null && node.right === null ? 'leaf' : 'internal',
        slot: `k${node.key}`,
        origin: node.origin,
        // A search tree reads left to right by key, whatever its shape.
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
      pluginId: 'persistent-bst',
      data: { versions: this.#roots.map((r) => this.#keysOf(r)) },
    };
  }
}

export const persistentBst: AlgorithmPlugin = {
  meta: {
    id: 'persistent-bst',
    name: 'Persistent BST',
    category: 'Persistent structures',
    summary: 'A search tree with no balancing, to show what balancing is for.',
  },
  commands: COMMANDS,
  explain: explainBst,
  benchmark: {
    sizes: [8, 16, 32, 64, 128, 256],
    command: 'find',
    // Sorted input on purpose. This is the structure's worst case, and the
    // chart exists to show that its worst case is linear while every other
    // search structure here stays logarithmic.
    setup: (n: number): readonly string[] =>
      [`build [${Array.from({ length: n }, (_, i) => i + 1).join(' ')}]`],
    probes: (n: number): readonly string[] => [`find v0 ${n}`],
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
