/**
 * Persistent B+ tree.
 *
 * Every key lives in a leaf. Internal nodes hold separators only - signposts,
 * not data - which is what lets a range query descend once and then read
 * straight along the leaves instead of walking back up and down.
 *
 * That leaf chain is the first pointer in this project that is not a tree
 * edge, and it is the reason the plugin exists: layout had assumed every edge
 * meant "one level down".
 *
 * The chain is maintained destructively while the tree itself is persistent,
 * and that split is deliberate. A leaf shared between two versions can have a
 * different successor in each, and a pointer that differs per version cannot
 * live on a shared node - that is what persistence *means*. A production B+
 * tree pays for this by copying the predecessor leaf and all of its ancestors
 * on every split; here the chain is simply re-pointed, and the events that
 * re-point it are in the log like any other change. Scrub back and the chain
 * scrubs with you; what you cannot do is view two versions' chains at once.
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
import { explainBplus } from './explain.ts';

const SCHEMA_VERSION = 1;

/** Maximum children per node. */
export const ORDER = 4;
const MAX_KEYS = ORDER - 1;

interface Node {
  readonly id: NodeId;
  /** Data in a leaf; separators in an internal node. */
  readonly keys: readonly number[];
  readonly children: readonly NodeId[];
  readonly origin: number;
}

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
    summary: 'Add a key to its leaf, producing a new version.',
    complexity: 'O(log n)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'key', kind: 'int' },
    ],
  },
  {
    name: 'find',
    summary: 'Look a key up. Every search goes all the way to a leaf.',
    complexity: 'O(log n)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'key', kind: 'int' },
    ],
  },
  {
    name: 'range',
    summary: 'Read every key in a half-open range by walking the leaf chain.',
    complexity: 'O(log n)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'lo', kind: 'int' },
      { name: 'hi', kind: 'int' },
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

/** Which child a search follows: the first separator strictly above the key. */
function branchFor(separators: readonly number[], key: number): number {
  let i = 0;
  while (i < separators.length && key >= (separators[i] as number)) i += 1;
  return i;
}

/* ── A plain mutable B+ tree, to shape version 0 ────────────────────── */

interface Draft { keys: number[]; kids: Draft[] }

function draftInsert(node: Draft, key: number): { key: number; right: Draft } | null {
  if (node.kids.length === 0) {
    const at = node.keys.findIndex((k) => k >= key);
    if (node.keys[at === -1 ? node.keys.length : at] === key) return null;
    node.keys.splice(at === -1 ? node.keys.length : at, 0, key);
    if (node.keys.length <= MAX_KEYS) return null;
    // A leaf split copies its first key upward; the key itself stays put.
    const mid = Math.ceil(node.keys.length / 2);
    const right: Draft = { keys: node.keys.slice(mid), kids: [] };
    node.keys = node.keys.slice(0, mid);
    return { key: right.keys[0] as number, right };
  }

  const i = branchFor(node.keys, key);
  const split = draftInsert(node.kids[i] as Draft, key);
  if (split === null) return null;
  node.keys.splice(i, 0, split.key);
  node.kids.splice(i + 1, 0, split.right);
  if (node.keys.length <= MAX_KEYS) return null;

  // An internal split promotes its middle separator, which leaves this node.
  const mid = node.keys.length >> 1;
  const promoted = node.keys[mid] as number;
  const right: Draft = { keys: node.keys.slice(mid + 1), kids: node.kids.slice(mid + 1) };
  node.keys = node.keys.slice(0, mid);
  node.kids = node.kids.slice(0, mid + 1);
  return { key: promoted, right };
}

class Instance implements PluginInstance {
  #nodes = new Map<NodeId, Node>();
  #roots: NodeId[] = [];
  #next = 0;
  #splits = 0;
  /** The leaf chain as it currently stands: from -> next. */
  #chain = new Map<NodeId, NodeId>();

  reset(): void {
    this.#nodes = new Map();
    this.#roots = [];
    this.#next = 0;
    this.#splits = 0;
    this.#chain = new Map();
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getIntList(cmd, 'keys'));
      case 'insert': return this.#insert(getVersion(cmd, 'version'), getInt(cmd, 'key'));
      case 'find': return this.#find(getVersion(cmd, 'version'), getInt(cmd, 'key'));
      case 'range': return this.#range(getVersion(cmd, 'version'), getInt(cmd, 'lo'), getInt(cmd, 'hi'));
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

  #isLeaf(node: Node): boolean {
    return node.children.length === 0;
  }

  #alloc(keys: readonly number[], children: readonly NodeId[], origin: number, events: SimEvent[]): NodeId {
    const id = this.#next as NodeId;
    this.#next += 1;
    this.#nodes.set(id, { id, keys, children, origin });
    const leaf = children.length === 0;
    events.push({
      kind: 'NodeAllocated',
      node: id,
      value: keys[0] ?? 0,
      values: [...keys],
      label: leaf ? 'leaf' : 'separators',
      role: leaf ? 'leaf' : 'internal',
      slot: `${leaf ? 'l' : 'i'}${keys[0] ?? 0}`,
      origin,
    });
    children.forEach((child, i) => {
      events.push({ kind: 'PointerSet', from: id, slot: `c${i}`, to: child });
      if (this.#get(child).origin < origin) {
        events.push({ kind: 'NodeReused', node: child, by: id });
      }
    });
    return id;
  }

  /** Leaves left to right. The chain the plugin draws, and the order it reads. */
  #leaves(root: NodeId, out: NodeId[] = []): NodeId[] {
    const node = this.#get(root);
    if (this.#isLeaf(node)) { out.push(root); return out; }
    for (const child of node.children) this.#leaves(child, out);
    return out;
  }

  #keysOf(root: NodeId): number[] {
    return this.#leaves(root).flatMap((id) => [...this.#get(id).keys]);
  }

  #heightOf(id: NodeId): number {
    const node = this.#get(id);
    return 1 + (this.#isLeaf(node) ? 0 : this.#heightOf(node.children[0] as NodeId));
  }

  /** Descends to the leaf that would hold `key`, recording what it read. */
  #descend(root: NodeId, key: number, visited: NodeId[]): Node {
    let node = this.#get(root);
    visited.push(node.id);
    while (!this.#isLeaf(node)) {
      node = this.#get(node.children[branchFor(node.keys, key)] as NodeId);
      visited.push(node.id);
    }
    return node;
  }

  #insertInto(id: NodeId, key: number, origin: number, events: SimEvent[]): Inserted {
    const node = this.#get(id);
    events.push({ kind: 'NodeVisited', node: id });

    if (this.#isLeaf(node)) {
      const at = branchFor(node.keys, key);
      const keys = [...node.keys.slice(0, at), key, ...node.keys.slice(at)];
      if (keys.length <= MAX_KEYS) return { kind: 'node', id: this.#alloc(keys, [], origin, events) };
      this.#splits += 1;
      const mid = Math.ceil(keys.length / 2);
      return {
        kind: 'split',
        left: this.#alloc(keys.slice(0, mid), [], origin, events),
        // Copied, not moved: the key still has to be findable in a leaf.
        key: keys[mid] as number,
        right: this.#alloc(keys.slice(mid), [], origin, events),
      };
    }

    const i = branchFor(node.keys, key);
    const below = this.#insertInto(node.children[i] as NodeId, key, origin, events);
    const keys = [...node.keys];
    const children = [...node.children];
    if (below.kind === 'node') {
      children[i] = below.id;
    } else {
      keys.splice(i, 0, below.key);
      children.splice(i, 1, below.left, below.right);
    }

    if (keys.length <= MAX_KEYS) return { kind: 'node', id: this.#alloc(keys, children, origin, events) };
    this.#splits += 1;
    const mid = keys.length >> 1;
    return {
      kind: 'split',
      left: this.#alloc(keys.slice(0, mid), children.slice(0, mid + 1), origin, events),
      // Promoted, not copied: a separator is a signpost, so it moves upward.
      key: keys[mid] as number,
      right: this.#alloc(keys.slice(mid + 1), children.slice(mid + 1), origin, events),
    };
  }

  /**
   * Re-points the leaf chain to match the newest version, emitting only the
   * links that actually changed. These are events like any other, so replay
   * rebuilds the chain rather than the renderer inventing it.
   */
  #relink(root: NodeId, events: SimEvent[]): void {
    const chain = this.#leaves(root);
    const wanted = new Map<NodeId, NodeId>();
    for (let i = 1; i < chain.length; i += 1) {
      wanted.set(chain[i - 1] as NodeId, chain[i] as NodeId);
    }
    for (const [from, to] of wanted) {
      if (this.#chain.get(from) === to) continue;
      events.push({ kind: 'PointerSet', from, slot: 'next', to, pointer: 'link' });
    }
    for (const [from] of this.#chain) {
      if (!wanted.has(from)) {
        events.push({ kind: 'PointerSet', from, slot: 'next', to: null, pointer: 'link' });
      }
    }
    this.#chain = wanted;
  }

  #commit(root: NodeId, version: number, events: SimEvent[]): void {
    this.#roots.push(root);
    this.#relink(root, events);
    events.push({ kind: 'VersionCommitted', version, roots: [root] });
    events.push({ kind: 'RootsSet', roots: [...this.#roots] });
  }

  /* ── Commands ────────────────────────────────────────────────────── */

  #build(keys: readonly number[]): OperationResult {
    this.reset();
    const events: SimEvent[] = [];

    let draft: Draft = { keys: [], kids: [] };
    for (const key of keys) {
      const split = draftInsert(draft, key);
      if (split !== null) draft = { keys: [split.key], kids: [draft, split.right] };
    }

    const construct = (node: Draft): NodeId =>
      this.#alloc(node.keys, node.kids.map(construct), 0, events);
    const root = construct(draft);
    this.#commit(root, 0, events);

    return {
      ok: true,
      value: {
        version: 0, size: this.#keysOf(root).length,
        height: this.#heightOf(root), leaves: this.#leaves(root).length,
      },
      events,
      statsDelta: { versions: 1, nodesAllocated: this.#nodes.size, height: this.#heightOf(root) },
    };
  }

  #insert(v: number, key: number): OperationResult {
    const root = this.#roots[v];
    if (root === undefined) {
      return failed(err('UNKNOWN_VERSION', `Version v${v} does not exist.`, this.#available()));
    }
    if (this.#descend(root, key, []).keys.includes(key)) {
      return failed(err('PRECONDITION_FAILED', `Key ${key} is already in v${v}.`,
        'this tree holds each key once'));
    }

    const events: SimEvent[] = [];
    const version = this.#roots.length;
    const before = this.#nodes.size;
    this.#splits = 0;

    const result = this.#insertInto(root, key, version, events);
    const newRoot = result.kind === 'node'
      ? result.id
      : this.#alloc([result.key], [result.left, result.right], version, events);
    this.#commit(newRoot, version, events);

    return {
      ok: true,
      value: {
        version, key, allocated: this.#nodes.size - before,
        splits: this.#splits, height: this.#heightOf(newRoot),
        leaves: this.#leaves(newRoot).length,
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
    const leaf = this.#descend(root, key, visited);
    return {
      ok: true,
      value: { found: leaf.keys.includes(key), key, visits: visited.length, height: this.#heightOf(root) },
      events: visited.map((id): SimEvent => ({ kind: 'NodeVisited', node: id })),
      statsDelta: { queries: 1, nodeVisits: visited.length, height: this.#heightOf(root) },
    };
  }

  #range(v: number, lo: number, hi: number): OperationResult {
    const root = this.#roots[v];
    if (root === undefined) {
      return failed(err('UNKNOWN_VERSION', `Version v${v} does not exist.`, this.#available()));
    }
    if (hi < lo) {
      return failed(err('INVALID_RANGE', `Range [${lo}, ${hi}) runs backwards.`,
        'the low end must not exceed the high end'));
    }

    // Descend once to the first leaf, then read along the chain. This is the
    // whole reason the leaves are linked: no second descent per leaf.
    const visited: NodeId[] = [];
    this.#descend(root, lo, visited);
    const chain = this.#leaves(root);
    const start = chain.indexOf(visited[visited.length - 1] as NodeId);

    const found: number[] = [];
    let walked = 0;
    for (let i = Math.max(0, start); i < chain.length; i += 1) {
      const leaf = this.#get(chain[i] as NodeId);
      if ((leaf.keys[0] as number) >= hi) break;
      if (i > start) visited.push(leaf.id);
      walked += 1;
      for (const k of leaf.keys) if (k >= lo && k < hi) found.push(k);
    }

    return {
      ok: true,
      value: { lo, hi, keys: found, descent: this.#heightOf(root), leavesRead: walked, visits: visited.length },
      events: visited.map((id): SimEvent => ({ kind: 'NodeVisited', node: id })),
      statsDelta: { queries: 1, nodeVisits: visited.length },
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
      const leaf = this.#isLeaf(node);
      nodes.push({
        id: node.id,
        label: leaf ? 'leaf' : 'separators',
        value: node.keys[0] ?? 0,
        values: [...node.keys],
        role: leaf ? 'leaf' : 'internal',
        slot: `${leaf ? 'l' : 'i'}${node.keys[0] ?? 0}`,
        origin: node.origin,
        order: node.keys[0] ?? 0,
      });
      node.children.forEach((child, i) => {
        edges.push({
          from: node.id, to: child, slot: `c${i}`,
          reused: this.#get(child).origin < node.origin,
        });
      });
    }

    // The chain as it currently stands, which is what the log last said.
    for (const [from, to] of this.#chain) {
      edges.push({ from, to, slot: 'next', reused: false, kind: 'link' });
    }

    return { layout: 'dag', nodes, edges, roots: [...this.#roots] };
  }

  serialize(): SerializedState {
    return {
      schemaVersion: SCHEMA_VERSION,
      pluginId: 'persistent-bplus',
      data: { order: ORDER, versions: this.#roots.map((r) => this.#keysOf(r)) },
    };
  }
}

export const persistentBplus: AlgorithmPlugin = {
  meta: {
    id: 'persistent-bplus',
    name: 'Persistent B+ Tree',
    category: 'Balanced trees',
    summary: 'Keys only in the leaves, and the leaves in a chain, so ranges read straight through.',
  },
  commands: COMMANDS,
  explain: explainBplus,
  benchmark: {
    sizes: [8, 16, 32, 64, 128, 256],
    command: 'find',
    setup: (n: number): readonly string[] =>
      [`build [${Array.from({ length: n }, (_, i) => i + 1).join(' ')}]`],
    probes: (n: number): readonly string[] => [`find v0 ${n}`],
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
