/**
 * Persistent AVL tree.
 *
 * The answer to the plain BST. Every node keeps the height of its subtree, and
 * any insert or erase that leaves a node's two sides more than one level apart
 * is repaired by a rotation on the way back up. Sorted input — the input that
 * degenerates an unbalanced tree into a linked list — comes out logarithmic.
 *
 * Rotations are the first operation here that rearranges a node's children
 * rather than copying them along a path. Persistence makes that cheap rather
 * than awkward: the rotated nodes are being allocated anyway, so a rotation
 * only changes which children the new nodes are given.
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
import { explainAvl } from './explain.ts';

const SCHEMA_VERSION = 1;

interface Node {
  readonly id: NodeId;
  readonly key: number;
  /** Height of this subtree. Stored so balance is O(1) to check. */
  readonly height: number;
  readonly left: NodeId | null;
  readonly right: NodeId | null;
  readonly origin: number;
}

/** Which way a node leans. An AVL tree only ever allows these three. */
export type Balance = 'balanced' | 'left-heavy' | 'right-heavy';

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Insert keys in the order given, producing version 0.',
    complexity: 'O(n log n)',
    params: [{ name: 'keys', kind: 'int-list' }],
  },
  {
    name: 'insert',
    summary: 'Add a key, rebalancing as needed, producing a new version.',
    complexity: 'O(log n)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'key', kind: 'int' },
    ],
  },
  {
    name: 'erase',
    summary: 'Remove a key, rebalancing as needed, producing a new version.',
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

/** A plain mutable AVL, used to shape version 0 before anything is allocated. */
interface Draft {
  readonly key: number;
  height: number;
  left: Draft | null;
  right: Draft | null;
}

const draftHeight = (d: Draft | null): number => (d === null ? 0 : d.height);
const refresh = (d: Draft): Draft => {
  d.height = 1 + Math.max(draftHeight(d.left), draftHeight(d.right));
  return d;
};

function draftRotateRight(node: Draft): Draft {
  const pivot = node.left as Draft;
  node.left = pivot.right;
  pivot.right = refresh(node);
  return refresh(pivot);
}

function draftRotateLeft(node: Draft): Draft {
  const pivot = node.right as Draft;
  node.right = pivot.left;
  pivot.left = refresh(node);
  return refresh(pivot);
}

function draftInsert(node: Draft | null, key: number): Draft {
  if (node === null) return { key, height: 1, left: null, right: null };
  if (key === node.key) return node;
  if (key < node.key) node.left = draftInsert(node.left, key);
  else node.right = draftInsert(node.right, key);
  refresh(node);

  const slope = draftHeight(node.left) - draftHeight(node.right);
  if (slope > 1) {
    const left = node.left as Draft;
    if (draftHeight(left.left) < draftHeight(left.right)) node.left = draftRotateLeft(left);
    return draftRotateRight(node);
  }
  if (slope < -1) {
    const right = node.right as Draft;
    if (draftHeight(right.right) < draftHeight(right.left)) node.right = draftRotateRight(right);
    return draftRotateLeft(node);
  }
  return node;
}

class Instance implements PluginInstance {
  #nodes = new Map<NodeId, Node>();
  #roots: (NodeId | null)[] = [];
  #next = 0;
  /** Rotations performed by the operation currently running. */
  #rotations = 0;

  reset(): void {
    this.#nodes = new Map();
    this.#roots = [];
    this.#next = 0;
    this.#rotations = 0;
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

  #height(id: NodeId | null): number {
    return id === null ? 0 : this.#get(id).height;
  }

  balanceOf(node: Node): Balance {
    const slope = this.#height(node.left) - this.#height(node.right);
    if (slope > 0) return 'left-heavy';
    if (slope < 0) return 'right-heavy';
    return 'balanced';
  }

  #alloc(key: number, left: NodeId | null, right: NodeId | null, origin: number, events: SimEvent[]): Node {
    const id = this.#next as NodeId;
    this.#next += 1;
    const height = 1 + Math.max(this.#height(left), this.#height(right));
    const node: Node = { id, key, height, left, right, origin };
    this.#nodes.set(id, node);
    events.push({
      kind: 'NodeAllocated',
      node: id,
      value: key,
      label: `${key}`,
      // The role carries the balance, because "no node leans by more than one"
      // is the whole invariant and is worth being able to read off a node.
      role: this.balanceOf(node),
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

  /**
   * Allocates a node for `key`, rotating first if the two sides differ by more
   * than one level. Nothing is mutated: a rotation just hands the new nodes a
   * different arrangement of the same children.
   */
  #balanced(key: number, left: NodeId | null, right: NodeId | null, origin: number, events: SimEvent[]): NodeId {
    const slope = this.#height(left) - this.#height(right);

    if (slope > 1) {
      const pivot = this.#get(left as NodeId);
      if (this.#height(pivot.left) < this.#height(pivot.right)) {
        // Left-right: straighten the left child before rotating this node.
        const inner = this.#get(pivot.right as NodeId);
        this.#rotations += 2;
        const newLeft = this.#alloc(pivot.key, pivot.left, inner.left, origin, events).id;
        const newRight = this.#alloc(key, inner.right, right, origin, events).id;
        return this.#alloc(inner.key, newLeft, newRight, origin, events).id;
      }
      this.#rotations += 1;
      const newRight = this.#alloc(key, pivot.right, right, origin, events).id;
      return this.#alloc(pivot.key, pivot.left, newRight, origin, events).id;
    }

    if (slope < -1) {
      const pivot = this.#get(right as NodeId);
      if (this.#height(pivot.right) < this.#height(pivot.left)) {
        const inner = this.#get(pivot.left as NodeId);
        this.#rotations += 2;
        const newLeft = this.#alloc(key, left, inner.left, origin, events).id;
        const newRight = this.#alloc(pivot.key, inner.right, pivot.right, origin, events).id;
        return this.#alloc(inner.key, newLeft, newRight, origin, events).id;
      }
      this.#rotations += 1;
      const newLeft = this.#alloc(key, left, pivot.left, origin, events).id;
      return this.#alloc(pivot.key, newLeft, pivot.right, origin, events).id;
    }

    return this.#alloc(key, left, right, origin, events).id;
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
      return this.#balanced(node.key, this.#insertInto(node.left, key, origin, events), node.right, origin, events);
    }
    return this.#balanced(node.key, node.left, this.#insertInto(node.right, key, origin, events), origin, events);
  }

  #detachMin(id: NodeId, origin: number, events: SimEvent[]): { key: number; rest: NodeId | null } {
    const node = this.#get(id);
    events.push({ kind: 'NodeVisited', node: id });
    if (node.left === null) return { key: node.key, rest: node.right };
    const { key, rest } = this.#detachMin(node.left, origin, events);
    return { key, rest: this.#balanced(node.key, rest, node.right, origin, events) };
  }

  #eraseFrom(id: NodeId | null, key: number, origin: number, events: SimEvent[]): NodeId | null {
    if (id === null) return null;
    const node = this.#get(id);
    events.push({ kind: 'NodeVisited', node: id });

    if (key < node.key) {
      return this.#balanced(node.key, this.#eraseFrom(node.left, key, origin, events), node.right, origin, events);
    }
    if (key > node.key) {
      return this.#balanced(node.key, node.left, this.#eraseFrom(node.right, key, origin, events), origin, events);
    }
    if (node.left === null) return node.right;
    if (node.right === null) return node.left;
    const { key: successor, rest } = this.#detachMin(node.right, origin, events);
    return this.#balanced(successor, node.left, rest, origin, events);
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

    // Shaped in plain objects first: inserting one key at a time through the
    // persistent path would copy and strand every intermediate tree.
    let draft: Draft | null = null;
    for (const key of keys) draft = draftInsert(draft, key);

    const construct = (node: Draft | null): NodeId | null => {
      if (node === null) return null;
      const left = construct(node.left);
      const right = construct(node.right);
      return this.#alloc(node.key, left, right, 0, events).id;
    };
    const root = construct(draft);
    this.#commit(root, 0, events);

    return {
      ok: true,
      value: { version: 0, size: this.#keysOf(root).length, height: this.#height(root) },
      events,
      statsDelta: { versions: 1, nodesAllocated: this.#nodes.size, height: this.#height(root) },
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
    this.#rotations = 0;
    const newRoot = this.#insertInto(root, key, version, events);
    this.#commit(newRoot, version, events);

    return {
      ok: true,
      value: {
        version, key, allocated: this.#nodes.size - before,
        rotations: this.#rotations, height: this.#height(newRoot),
      },
      events,
      statsDelta: {
        versions: 1, updates: 1,
        nodesAllocated: this.#nodes.size - before,
        height: this.#height(newRoot),
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
    this.#rotations = 0;
    const newRoot = this.#eraseFrom(root, key, version, events);
    this.#commit(newRoot, version, events);

    return {
      ok: true,
      value: {
        version, key, allocated: this.#nodes.size - before,
        rotations: this.#rotations, height: this.#height(newRoot),
      },
      events,
      statsDelta: {
        versions: 1, updates: 1,
        nodesAllocated: this.#nodes.size - before,
        height: this.#height(newRoot),
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
      value: { found, key, visits: visited.length, height: this.#height(root) },
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
        label: `${node.key}`,
        value: node.key,
        role: this.balanceOf(node),
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
      pluginId: 'persistent-avl',
      data: { versions: this.#roots.map((r) => this.#keysOf(r)) },
    };
  }
}

export const persistentAvl: AlgorithmPlugin = {
  meta: {
    id: 'persistent-avl',
    name: 'Persistent AVL',
    category: 'Balanced trees',
    summary: 'A search tree that rotates to stay shallow, whatever order the keys arrive in.',
  },
  commands: COMMANDS,
  explain: explainAvl,
  benchmark: {
    sizes: [8, 16, 32, 64, 128, 256],
    command: 'find',
    // Deliberately the same sorted input that degenerates the plain BST. The
    // contrast between the two charts is the reason this plugin exists.
    setup: (n: number): readonly string[] =>
      [`build [${Array.from({ length: n }, (_, i) => i + 1).join(' ')}]`],
    probes: (n: number): readonly string[] => [`find v0 ${n}`],
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
