/**
 * Persistent splay tree.
 *
 * The first structure here where reading changes the shape. Every access drags
 * the key it found to the root by rotations, so a lookup is a write: `access`
 * produces a new version, and the old one stays exactly as it was.
 *
 * Nothing enforces balance. A single access can walk the whole tree; what the
 * splaying buys is that it cannot keep doing so. The bound is amortised over a
 * sequence, which is why the benchmark measures a run of accesses rather than
 * one - a single probe would report the worst case and call the claim false.
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
import { explainSplay } from './explain.ts';

const SCHEMA_VERSION = 1;

interface Pending {
  readonly key: number;
  readonly left: NodeId | null;
  readonly right: NodeId | null;
}

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
    complexity: 'O(n log n) amortised',
    params: [{ name: 'keys', kind: 'int-list' }],
  },
  {
    name: 'insert',
    summary: 'Add a key at the root, producing a new version.',
    complexity: 'O(log n) amortised',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'key', kind: 'int' },
    ],
  },
  {
    name: 'access',
    summary: 'Look a key up and splay it to the root. This makes a new version.',
    complexity: 'O(log n) amortised',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'key', kind: 'int' },
    ],
  },
  {
    name: 'contains',
    summary: 'Check for a key without reshaping anything.',
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

/* ── A plain mutable splay tree, to shape version 0 ─────────────────── */

interface Draft { key: number; left: Draft | null; right: Draft | null }

const rotRight = (t: Draft): Draft => {
  const l = t.left as Draft;
  t.left = l.right;
  l.right = t;
  return l;
};
const rotLeft = (t: Draft): Draft => {
  const r = t.right as Draft;
  t.right = r.left;
  r.left = t;
  return r;
};

function draftSplay(root: Draft | null, key: number): Draft | null {
  let t = root;
  if (t === null || t.key === key) return t;

  if (key < t.key) {
    if (t.left === null) return t;
    if (key < t.left.key) {
      t.left.left = draftSplay(t.left.left, key);
      t = rotRight(t);
    } else if (key > t.left.key) {
      t.left.right = draftSplay(t.left.right, key);
      if (t.left.right !== null) t.left = rotLeft(t.left);
    }
    return t.left === null ? t : rotRight(t);
  }

  if (t.right === null) return t;
  if (key > t.right.key) {
    t.right.right = draftSplay(t.right.right, key);
    t = rotLeft(t);
  } else if (key < t.right.key) {
    t.right.left = draftSplay(t.right.left, key);
    if (t.right.left !== null) t.right = rotRight(t.right);
  }
  return t.right === null ? t : rotLeft(t);
}

function draftInsert(root: Draft | null, key: number): Draft {
  const t = draftSplay(root, key);
  if (t === null) return { key, left: null, right: null };
  if (t.key === key) return t;
  if (key < t.key) {
    const l = t.left;
    t.left = null;
    return { key, left: l, right: t };
  }
  const r = t.right;
  t.right = null;
  return { key, left: t, right: r };
}

class Instance implements PluginInstance {
  #nodes = new Map<NodeId, Node>();
  #roots: (NodeId | null)[] = [];
  #next = 0;
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
      case 'access': return this.#access(getVersion(cmd, 'version'), getInt(cmd, 'key'));
      case 'contains': return this.#contains(getVersion(cmd, 'version'), getInt(cmd, 'key'));
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

  #alloc(key: number, left: NodeId | null, right: NodeId | null, origin: number, events: SimEvent[]): NodeId {
    const id = this.#next as NodeId;
    this.#next += 1;
    this.#nodes.set(id, { id, key, left, right, origin });
    events.push({
      kind: 'NodeAllocated',
      node: id,
      value: key,
      label: `${key}`,
      role: left === null && right === null ? 'leaf' : 'internal',
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
   * A node whose shape is still being decided. Nothing is allocated until it
   * is final: rotating a node that was already allocated would leave the
   * original stranded, and a splay rotates the same node twice.
   */
  #materialise(p: Pending, origin: number, events: SimEvent[]): NodeId {
    return this.#alloc(p.key, p.left, p.right, origin, events);
  }

  /**
   * Brings `key` to the root, or the last node reached if it is absent.
   *
   * Each case computes the final shape in one step rather than rotating twice
   * over an intermediate. A splay moves the same node up two levels, so
   * building it after the first rotation would strand it after the second -
   * and the whole point of persistence is that nothing is allocated in vain.
   *
   * The result stays pending, so a caller that takes it apart again - insert
   * does - never pays for a node it discards.
   */
  #splay(id: NodeId | null, key: number, origin: number, events: SimEvent[]): Pending | null {
    if (id === null) return null;
    const t = this.#get(id);
    events.push({ kind: 'NodeVisited', node: id });
    const here = (): Pending => ({ key: t.key, left: t.left, right: t.right });
    if (t.key === key) return here();

    if (key < t.key) {
      if (t.left === null) return here();
      const l = this.#get(t.left);
      const goDeeper = key < l.key ? l.left : key > l.key ? l.right : null;

      if (goDeeper === null) {
        // Zig: one rotation brings the child up and pushes this node right.
        this.#rotations += 1;
        return { key: l.key, left: l.left, right: this.#alloc(t.key, l.right, t.right, origin, events) };
      }

      const d = this.#splay(goDeeper, key, origin, events) as Pending;
      this.#rotations += 2;
      if (key < l.key) {
        // Zig-zig: the grandchild rises two levels, both ancestors move right.
        const outer = this.#alloc(t.key, l.right, t.right, origin, events);
        return { key: d.key, left: d.left, right: this.#alloc(l.key, d.right, outer, origin, events) };
      }
      // Zig-zag: the grandchild rises between its two ancestors.
      return {
        key: d.key,
        left: this.#alloc(l.key, l.left, d.left, origin, events),
        right: this.#alloc(t.key, d.right, t.right, origin, events),
      };
    }

    if (t.right === null) return here();
    const r = this.#get(t.right);
    const goDeeper = key > r.key ? r.right : key < r.key ? r.left : null;

    if (goDeeper === null) {
      this.#rotations += 1;
      return { key: r.key, left: this.#alloc(t.key, t.left, r.left, origin, events), right: r.right };
    }

    const d = this.#splay(goDeeper, key, origin, events) as Pending;
    this.#rotations += 2;
    if (key > r.key) {
      const outer = this.#alloc(t.key, t.left, r.left, origin, events);
      return { key: d.key, left: this.#alloc(r.key, outer, d.left, origin, events), right: d.right };
    }
    return {
      key: d.key,
      left: this.#alloc(t.key, t.left, d.left, origin, events),
      right: this.#alloc(r.key, d.right, r.right, origin, events),
    };
  }

  #keysOf(id: NodeId | null, out: number[] = []): number[] {
    if (id === null) return out;
    const node = this.#get(id);
    this.#keysOf(node.left, out);
    out.push(node.key);
    this.#keysOf(node.right, out);
    return out;
  }

  #heightOf(id: NodeId | null): number {
    if (id === null) return 0;
    const node = this.#get(id);
    return 1 + Math.max(this.#heightOf(node.left), this.#heightOf(node.right));
  }

  #walk(id: NodeId | null, key: number, visited: NodeId[]): boolean {
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

    // Shaped in plain objects, so the intermediate trees a sequence of splaying
    // inserts passes through are never allocated and then stranded.
    let draft: Draft | null = null;
    for (const key of keys) draft = draftInsert(draft, key);

    const construct = (node: Draft | null): NodeId | null =>
      node === null ? null
        : this.#alloc(node.key, construct(node.left), construct(node.right), 0, events);
    const root = construct(draft);
    this.#commit(root, 0, events);

    return {
      ok: true,
      value: { version: 0, size: this.#keysOf(root).length, height: this.#heightOf(root) },
      events,
      statsDelta: { versions: 1, nodesAllocated: this.#nodes.size, height: this.#heightOf(root) },
    };
  }

  #insert(v: number, key: number): OperationResult {
    const root = this.#rootOf(v);
    if (root === undefined) {
      return failed(err('UNKNOWN_VERSION', `Version v${v} does not exist.`, this.#available()));
    }
    if (this.#walk(root, key, [])) {
      return failed(err('PRECONDITION_FAILED', `Key ${key} is already in v${v}.`,
        'this tree holds each key once'));
    }

    const events: SimEvent[] = [];
    const version = this.#roots.length;
    const before = this.#nodes.size;
    this.#rotations = 0;

    const splayed = this.#splay(root, key, version, events);
    // The new key becomes the root and takes the split halves as its children.
    // The splayed root is still pending, so it is taken apart rather than built.
    const newRoot = splayed === null
      ? this.#alloc(key, null, null, version, events)
      : key < splayed.key
        ? this.#alloc(key, splayed.left,
          this.#alloc(splayed.key, null, splayed.right, version, events), version, events)
        : this.#alloc(key, this.#alloc(splayed.key, splayed.left, null, version, events),
          splayed.right, version, events);
    this.#commit(newRoot, version, events);

    return {
      ok: true,
      value: {
        version, key, allocated: this.#nodes.size - before,
        rotations: this.#rotations, height: this.#heightOf(newRoot),
      },
      events,
      statsDelta: {
        versions: 1, updates: 1,
        nodesAllocated: this.#nodes.size - before,
        height: this.#heightOf(newRoot),
      },
    };
  }

  #access(v: number, key: number): OperationResult {
    const root = this.#rootOf(v);
    if (root === undefined) {
      return failed(err('UNKNOWN_VERSION', `Version v${v} does not exist.`, this.#available()));
    }

    const events: SimEvent[] = [];
    const version = this.#roots.length;
    const before = this.#nodes.size;
    this.#rotations = 0;

    const pending = this.#splay(root, key, version, events);
    const found = pending !== null && pending.key === key;
    const splayed = pending === null ? null : this.#materialise(pending, version, events);
    this.#commit(splayed, version, events);

    return {
      ok: true,
      value: {
        found, key, version,
        // Reads are counted here too: the walk is what the rotations undo.
        visits: events.filter((e) => e.kind === 'NodeVisited').length,
        rotations: this.#rotations,
        allocated: this.#nodes.size - before,
        atRoot: pending?.key ?? null,
      },
      events,
      // A version, because the shape changed; a query, because the user asked a
      // question. Both are true, and the statistics say so.
      statsDelta: {
        versions: 1, queries: 1,
        nodeVisits: events.filter((e) => e.kind === 'NodeVisited').length,
        nodesAllocated: this.#nodes.size - before,
        height: this.#heightOf(splayed),
      },
    };
  }

  #contains(v: number, key: number): OperationResult {
    const root = this.#rootOf(v);
    if (root === undefined) {
      return failed(err('UNKNOWN_VERSION', `Version v${v} does not exist.`, this.#available()));
    }
    const visited: NodeId[] = [];
    const found = this.#walk(root, key, visited);
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
      pluginId: 'persistent-splay',
      data: { versions: this.#roots.map((r) => this.#keysOf(r)) },
    };
  }
}

export const persistentSplay: AlgorithmPlugin = {
  meta: {
    id: 'persistent-splay',
    name: 'Persistent Splay',
    category: 'Balanced trees',
    summary: 'A tree that rearranges itself when you read it, so recent keys stay near the top.',
  },
  commands: COMMANDS,
  explain: explainSplay,
  benchmark: {
    sizes: [8, 16, 32, 64, 128, 256],
    command: 'access',
    setup: (n: number): readonly string[] =>
      [`build [${Array.from({ length: n }, (_, i) => i + 1).join(' ')}]`],
    /**
     * A run of accesses, not one. Each probe reads the version the previous
     * probe produced, so the tree keeps the rearrangement - which is the whole
     * point of an amortised bound. One probe would measure the worst case and
     * make the declared complexity look wrong.
     *
     * Two things here are load-bearing, and an earlier version got both wrong.
     *
     * The count is proportional to n, not capped. An amortised bound says a
     * sequence of m operations costs O((m + n) log n); with m held at a
     * constant while n grows, the (n log n)/m term is what is being measured,
     * and it is not the bound.
     *
     * The keys are scattered rather than swept. Splaying a tree in ascending
     * order is O(1) amortised, not O(log n) - reading a splay tree end to end
     * is one of the things it is unusually good at - so a sweeping probe
     * measures a real property, just not the declared one. Stepping by a prime
     * visits every key exactly once in an order the tree cannot exploit.
     */
    probes: (n: number): readonly string[] =>
      Array.from({ length: 2 * n }, (_, i) => `access v${i} ${((i * 7919) % n) + 1}`),
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
