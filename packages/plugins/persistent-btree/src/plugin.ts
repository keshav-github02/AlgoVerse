/**
 * Persistent B-tree.
 *
 * The first structure here whose node is not a single value. A node holds up
 * to `ORDER - 1` keys and one more child than it has keys, which is what keeps
 * the tree shallow: fan-out does the work that rotations do in an AVL.
 *
 * Insertion splits from the bottom up. A full node divides in two and pushes
 * its middle key to the parent; if that fills the parent it splits in turn, and
 * if the root splits the tree gains a level. Every node on the path is copied,
 * so earlier versions keep the shape they had.
 *
 * Deletion is not implemented. Removing from a B-tree needs borrowing and
 * merging between siblings, which is a good deal more intricate than the rest
 * of this plugin, and a wrong version of it would be worse than an absent one.
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
import { explainBtree } from './explain.ts';

const SCHEMA_VERSION = 1;

/** Maximum children per node. Four keeps the arithmetic visible on screen. */
export const ORDER = 4;
const MAX_KEYS = ORDER - 1;

interface Node {
  readonly id: NodeId;
  readonly keys: readonly number[];
  /** Empty for a leaf; otherwise exactly `keys.length + 1` entries. */
  readonly children: readonly NodeId[];
  readonly origin: number;
}

/** What an insert hands back: either one node, or a node that split in two. */
type Inserted =
  | { readonly kind: 'node'; readonly id: NodeId }
  | { readonly kind: 'split'; readonly left: NodeId; readonly key: number; readonly right: NodeId };

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Insert keys in the order given, producing version 0.',
    complexity: 'O(n log n)',
    params: [{ name: 'keys', kind: 'int-list' }],
  },
  {
    name: 'insert',
    summary: 'Add a key, splitting full nodes, producing a new version.',
    complexity: 'O(log n)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'key', kind: 'int' },
    ],
  },
  {
    name: 'find',
    summary: 'Look a key up, reporting how many nodes it had to read.',
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

/** Index of the first key not less than `key`. Where a search turns down. */
function slotFor(keys: readonly number[], key: number): number {
  let i = 0;
  while (i < keys.length && (keys[i] as number) < key) i += 1;
  return i;
}

/* ── A plain mutable B-tree, used to shape version 0 ────────────────── */

interface Draft { keys: number[]; kids: Draft[] }

function draftInsert(node: Draft, key: number): { key: number; right: Draft } | null {
  const i = slotFor(node.keys, key);
  if (node.keys[i] === key) return null;

  if (node.kids.length === 0) {
    node.keys.splice(i, 0, key);
  } else {
    const split = draftInsert(node.kids[i] as Draft, key);
    if (split === null) return null;
    node.keys.splice(i, 0, split.key);
    node.kids.splice(i + 1, 0, split.right);
  }
  if (node.keys.length <= MAX_KEYS) return null;

  const mid = node.keys.length >> 1;
  const key0 = node.keys[mid] as number;
  const right: Draft = {
    keys: node.keys.slice(mid + 1),
    kids: node.kids.length === 0 ? [] : node.kids.slice(mid + 1),
  };
  node.keys = node.keys.slice(0, mid);
  node.kids = node.kids.length === 0 ? [] : node.kids.slice(0, mid + 1);
  return { key: key0, right };
}

class Instance implements PluginInstance {
  #nodes = new Map<NodeId, Node>();
  #roots: NodeId[] = [];
  #next = 0;
  #splits = 0;

  reset(): void {
    this.#nodes = new Map();
    this.#roots = [];
    this.#next = 0;
    this.#splits = 0;
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getIntList(cmd, 'keys'));
      case 'insert': return this.#insert(getVersion(cmd, 'version'), getInt(cmd, 'key'));
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

  #get(id: NodeId): Node {
    return this.#nodes.get(id) as Node;
  }

  #alloc(keys: readonly number[], children: readonly NodeId[], origin: number, events: SimEvent[]): Node {
    const id = this.#next as NodeId;
    this.#next += 1;
    const node: Node = { id, keys, children, origin };
    this.#nodes.set(id, node);
    events.push({
      kind: 'NodeAllocated',
      node: id,
      // `value` still means something singular, so the smallest key stands for
      // the node; `values` carries what it actually holds.
      value: keys[0] as number,
      values: [...keys],
      label: children.length === 0 ? 'leaf' : `${children.length} ways`,
      role: children.length === 0 ? 'leaf' : 'internal',
      slot: `k${keys[0] as number}`,
      origin,
    });
    children.forEach((child, i) => {
      // Numbered so the layout engine's natural sort puts c2 before c10.
      events.push({ kind: 'PointerSet', from: id, slot: `c${i}`, to: child });
      if (this.#get(child).origin < origin) {
        events.push({ kind: 'NodeReused', node: child, by: id });
      }
    });
    return node;
  }

  #split(keys: readonly number[], children: readonly NodeId[], origin: number, events: SimEvent[]): Inserted {
    this.#splits += 1;
    const mid = keys.length >> 1;
    const leaf = children.length === 0;
    return {
      kind: 'split',
      left: this.#alloc(keys.slice(0, mid), leaf ? [] : children.slice(0, mid + 1), origin, events).id,
      key: keys[mid] as number,
      right: this.#alloc(keys.slice(mid + 1), leaf ? [] : children.slice(mid + 1), origin, events).id,
    };
  }

  #insertInto(id: NodeId, key: number, origin: number, events: SimEvent[]): Inserted {
    const node = this.#get(id);
    events.push({ kind: 'NodeVisited', node: id });
    const i = slotFor(node.keys, key);

    let keys: number[];
    let children: NodeId[];
    if (node.children.length === 0) {
      keys = [...node.keys.slice(0, i), key, ...node.keys.slice(i)];
      children = [];
    } else {
      const below = this.#insertInto(node.children[i] as NodeId, key, origin, events);
      keys = [...node.keys];
      children = [...node.children];
      if (below.kind === 'node') {
        children[i] = below.id;
      } else {
        // The child split, so its middle key joins this node between the two.
        keys.splice(i, 0, below.key);
        children.splice(i, 1, below.left, below.right);
      }
    }

    return keys.length <= MAX_KEYS
      ? { kind: 'node', id: this.#alloc(keys, children, origin, events).id }
      : this.#split(keys, children, origin, events);
  }

  #keysOf(id: NodeId | undefined, out: number[] = []): number[] {
    if (id === undefined) return out;
    const node = this.#get(id);
    if (node.children.length === 0) {
      out.push(...node.keys);
      return out;
    }
    node.keys.forEach((k, i) => {
      this.#keysOf(node.children[i], out);
      out.push(k);
    });
    this.#keysOf(node.children[node.keys.length], out);
    return out;
  }

  #heightOf(id: NodeId | undefined): number {
    if (id === undefined) return 0;
    const node = this.#get(id);
    return 1 + (node.children.length === 0 ? 0 : this.#heightOf(node.children[0]));
  }

  #contains(root: NodeId | undefined, key: number, visited: NodeId[]): boolean {
    let cursor = root;
    while (cursor !== undefined) {
      const node = this.#get(cursor);
      visited.push(cursor);
      const i = slotFor(node.keys, key);
      if (node.keys[i] === key) return true;
      if (node.children.length === 0) return false;
      cursor = node.children[i];
    }
    return false;
  }

  #commit(root: NodeId, version: number, events: SimEvent[]): void {
    this.#roots.push(root);
    events.push({ kind: 'VersionCommitted', version, roots: [root] });
    events.push({ kind: 'RootsSet', roots: [...this.#roots] });
  }

  /* ── Commands ────────────────────────────────────────────────────── */

  #build(keys: readonly number[]): OperationResult {
    this.reset();
    const events: SimEvent[] = [];

    // Shaped in plain objects first, so no intermediate tree is allocated and
    // then stranded by the next insert's path copy.
    let draft: Draft = { keys: [], kids: [] };
    for (const key of keys) {
      const split = draftInsert(draft, key);
      if (split !== null) draft = { keys: [split.key], kids: [draft, split.right] };
    }

    const construct = (node: Draft): NodeId =>
      this.#alloc(node.keys, node.kids.map(construct), 0, events).id;
    // An empty draft still needs a root to exist as version 0.
    const root = construct(draft.keys.length === 0 && draft.kids.length === 0
      ? { keys: [], kids: [] } : draft);
    this.#commit(root, 0, events);

    return {
      ok: true,
      value: { version: 0, size: this.#keysOf(root).length, height: this.#heightOf(root), order: ORDER },
      events,
      statsDelta: { versions: 1, nodesAllocated: this.#nodes.size, height: this.#heightOf(root) },
    };
  }

  #insert(v: number, key: number): OperationResult {
    const root = this.#roots[v];
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
    this.#splits = 0;

    const result = this.#insertInto(root, key, version, events);
    // A split at the root is the only way a B-tree gets taller.
    const newRoot = result.kind === 'node'
      ? result.id
      : this.#alloc([result.key], [result.left, result.right], version, events).id;
    this.#commit(newRoot, version, events);

    return {
      ok: true,
      value: {
        version, key, allocated: this.#nodes.size - before,
        splits: this.#splits, height: this.#heightOf(newRoot),
        grew: result.kind === 'split',
      },
      events,
      statsDelta: {
        versions: 1, updates: 1,
        nodesAllocated: this.#nodes.size - before,
        height: this.#heightOf(newRoot),
      },
    };
  }

  #find(v: number, key: number): OperationResult {
    const root = this.#roots[v];
    if (root === undefined) {
      return failed(err('UNKNOWN_VERSION', `Version v${v} does not exist.`, this.#available()));
    }
    const visited: NodeId[] = [];
    const found = this.#contains(root, key, visited);
    return {
      ok: true,
      value: { found, key, visits: visited.length, height: this.#heightOf(root) },
      events: visited.map((id): SimEvent => ({ kind: 'NodeVisited', node: id })),
      statsDelta: { queries: 1, nodeVisits: visited.length, height: this.#heightOf(root) },
    };
  }

  #compare(a: number, b: number): OperationResult {
    const ra = this.#roots[a];
    const rb = this.#roots[b];
    if (ra === undefined || rb === undefined) {
      return failed(err('UNKNOWN_VERSION',
        `Version v${ra === undefined ? a : b} does not exist.`, this.#available()));
    }
    const diff = diffRoots(this.getStructure(), [ra], [rb]);
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
        label: node.children.length === 0 ? 'leaf' : `${node.children.length} ways`,
        value: node.keys[0] ?? 0,
        values: [...node.keys],
        role: node.children.length === 0 ? 'leaf' : 'internal',
        slot: `k${node.keys[0] ?? 0}`,
        origin: node.origin,
        // A B-tree reads left to right by key, like any search tree.
        order: node.keys[0] ?? 0,
      });
      node.children.forEach((child, i) => {
        edges.push({
          from: node.id, to: child, slot: `c${i}`,
          reused: this.#get(child).origin < node.origin,
        });
      });
    }

    return { layout: 'dag', nodes, edges, roots: [...this.#roots] };
  }

  serialize(): SerializedState {
    return {
      schemaVersion: SCHEMA_VERSION,
      pluginId: 'persistent-btree',
      data: { order: ORDER, versions: this.#roots.map((r) => this.#keysOf(r)) },
    };
  }
}

export const persistentBtree: AlgorithmPlugin = {
  meta: {
    id: 'persistent-btree',
    name: 'Persistent B-Tree',
    category: 'Balanced trees',
    summary: 'Many keys to a node, so the tree stays shallow by being wide.',
  },
  commands: COMMANDS,
  explain: explainBtree,
  benchmark: {
    sizes: [8, 16, 32, 64, 128, 256],
    command: 'find',
    setup: (n: number): readonly string[] =>
      [`build [${Array.from({ length: n }, (_, i) => i + 1).join(' ')}]`],
    probes: (n: number): readonly string[] => [`find v0 ${n}`],
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
