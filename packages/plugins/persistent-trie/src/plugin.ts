/**
 * Persistent trie.
 *
 * Words share their prefixes, so a node stands for a prefix rather than a
 * value. Inserting copies the O(len) nodes along the word's own path and reuses
 * every other branch - the same persistence trick as the other structures, but
 * over a node with up to twenty-six children rather than two.
 *
 * That fan-out is the point of building it: everything before this had at most
 * two children, so the layout engine's child ordering had only ever been
 * exercised on a synthetic fixture.
 */

import {
  diffRoots, getVersion, getWord, getWordList,
  type CommandSpec, type NodeId, type OperationError, type ParsedCommand, type SimEvent,
} from '@algoverse/core';
import {
  failed,
  type AlgorithmPlugin, type EngineContext, type OperationResult,
  type PluginInstance, type SerializedState,
  type StructureEdge, type StructureGraph, type StructureNode,
} from '@algoverse/plugin-sdk';
import { explainTrie } from './explain.ts';

const SCHEMA_VERSION = 1;
const ROOT_LABEL = '·';

interface Node {
  readonly id: NodeId;
  /** The prefix this node stands for. The root's is empty. */
  readonly prefix: string;
  /** True when some word ends exactly here. */
  readonly terminal: boolean;
  /** Words stored at or below this node. */
  readonly words: number;
  readonly children: ReadonlyMap<string, NodeId>;
  readonly origin: number;
}

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Create version 0 from a list of words.',
    complexity: 'O(total letters)',
    params: [{ name: 'words', kind: 'word-list' }],
  },
  {
    name: 'insert',
    summary: 'Add a word, producing a new version.',
    complexity: 'O(len)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'word', kind: 'word' },
    ],
  },
  {
    name: 'contains',
    summary: 'Is this exact word stored in a version?',
    complexity: 'O(len)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'word', kind: 'word' },
    ],
  },
  {
    name: 'count',
    summary: 'How many words in a version start with this prefix?',
    complexity: 'O(len)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'prefix', kind: 'word' },
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
  #next = 0;

  reset(): void {
    this.#nodes = new Map();
    this.#roots = [];
    this.#next = 0;
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getWordList(cmd, 'words'));
      case 'insert': return this.#insert(getVersion(cmd, 'version'), getWord(cmd, 'word'));
      case 'contains': return this.#lookup(getVersion(cmd, 'version'), getWord(cmd, 'word'), true);
      case 'count': return this.#lookup(getVersion(cmd, 'version'), getWord(cmd, 'prefix'), false);
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

  #alloc(
    prefix: string, terminal: boolean, words: number,
    children: ReadonlyMap<string, NodeId>, origin: number, events: SimEvent[],
  ): Node {
    const id = this.#next as NodeId;
    this.#next += 1;
    const node: Node = { id, prefix, terminal, words, children, origin };
    this.#nodes.set(id, node);
    events.push({
      kind: 'NodeAllocated',
      node: id,
      value: words,
      label: prefix === '' ? ROOT_LABEL : (prefix[prefix.length - 1] as string),
      role: terminal ? 'word' : 'prefix',
      // A prefix always sits at its own length, whatever else changes.
      depth: prefix.length,
      // One slot per prefix, so the same prefix in different versions aligns.
      slot: `p:${prefix}`,
      origin,
    });
    for (const [letter, child] of [...children].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      events.push({ kind: 'PointerSet', from: id, slot: letter, to: child });
      if (this.#get(child).origin < origin) {
        events.push({ kind: 'NodeReused', node: child, by: id });
      }
    }
    return node;
  }

  /** Copies the path the word walks; every other branch is shared. */
  #insertInto(id: NodeId | null, word: string, at: number, origin: number, events: SimEvent[]): Node {
    const prefix = word.slice(0, at);
    const existing = id === null ? null : this.#get(id);
    if (existing !== null) events.push({ kind: 'NodeVisited', node: existing.id });

    if (at === word.length) {
      return this.#alloc(
        prefix, true,
        (existing?.words ?? 0) + (existing?.terminal === true ? 0 : 1),
        existing?.children ?? new Map(), origin, events,
      );
    }

    const letter = word[at] as string;
    const nextId = existing?.children.get(letter) ?? null;
    const child = this.#insertInto(nextId, word, at + 1, origin, events);
    const children = new Map(existing?.children ?? []);
    children.set(letter, child.id);

    return this.#alloc(
      prefix, existing?.terminal ?? false,
      (existing?.words ?? 0) + (nextId === null ? 1 : child.words - this.#get(nextId).words),
      children, origin, events,
    );
  }

  #walk(root: NodeId, word: string, visited: NodeId[]): Node | null {
    let cursor: Node | null = this.#get(root);
    visited.push(root);
    for (const letter of word) {
      const next: NodeId | undefined = cursor?.children.get(letter);
      if (next === undefined) return null;
      cursor = this.#get(next);
      visited.push(next);
    }
    return cursor;
  }

  /* ── Commands ────────────────────────────────────────────────────── */

  #build(words: readonly string[]): OperationResult {
    this.reset();
    const events: SimEvent[] = [];
    const unique = [...new Set(words)];

    /**
     * Shaped first, allocated second. Inserting the words one at a time would
     * path-copy on every insert and commit only the final root, leaving every
     * intermediate node unreachable - the same waste the treap's build had.
     */
    interface Draft { terminal: boolean; readonly kids: Map<string, Draft> }
    const draft: Draft = { terminal: false, kids: new Map() };
    for (const word of unique) {
      let cursor = draft;
      for (const letter of word) {
        let next = cursor.kids.get(letter);
        if (next === undefined) { next = { terminal: false, kids: new Map() }; cursor.kids.set(letter, next); }
        cursor = next;
      }
      cursor.terminal = true;
    }

    const construct = (node: Draft, prefix: string): Node => {
      const children = new Map<string, NodeId>();
      let below = node.terminal ? 1 : 0;
      // Sorted so allocation order matches the order the trie reads in.
      for (const letter of [...node.kids.keys()].sort()) {
        const child = construct(node.kids.get(letter) as Draft, prefix + letter);
        children.set(letter, child.id);
        below += child.words;
      }
      return this.#alloc(prefix, node.terminal, below, children, 0, events);
    };
    const root = construct(draft, '').id;

    this.#roots.push(root);
    events.push({ kind: 'VersionCommitted', version: 0, roots: [root] });
    events.push({ kind: 'RootsSet', roots: [...this.#roots] });

    return {
      ok: true,
      value: { version: 0, words: this.#get(root).words, nodes: this.#nodes.size },
      events,
      statsDelta: {
        versions: 1,
        nodesAllocated: this.#nodes.size,
        height: Math.max(0, ...unique.map((w) => w.length)),
      },
    };
  }

  #insert(v: number, word: string): OperationResult {
    const root = this.#roots[v];
    if (root === undefined) {
      return failed(err('UNKNOWN_VERSION', `Version v${v} does not exist.`, this.#available()));
    }
    const found = this.#walk(root, word, []);
    if (found !== null && found.terminal) {
      return failed(err('PRECONDITION_FAILED', `"${word}" is already in v${v}.`,
        'a trie holds each word once'));
    }

    const events: SimEvent[] = [];
    const version = this.#roots.length;
    const before = this.#nodes.size;
    const newRoot = this.#insertInto(root, word, 0, version, events);
    this.#roots.push(newRoot.id);
    events.push({ kind: 'VersionCommitted', version, roots: [newRoot.id] });
    events.push({ kind: 'RootsSet', roots: [...this.#roots] });

    return {
      ok: true,
      value: { version, word, allocated: this.#nodes.size - before, words: newRoot.words },
      events,
      statsDelta: {
        versions: 1, updates: 1,
        nodesAllocated: this.#nodes.size - before,
        height: Math.max(word.length, 0),
      },
    };
  }

  #lookup(v: number, word: string, exact: boolean): OperationResult {
    const root = this.#roots[v];
    if (root === undefined) {
      return failed(err('UNKNOWN_VERSION', `Version v${v} does not exist.`, this.#available()));
    }
    const visited: NodeId[] = [];
    const node = this.#walk(root, word, visited);

    return {
      ok: true,
      value: exact
        ? { word, found: node !== null && node.terminal, visits: visited.length }
        : { prefix: word, words: node?.words ?? 0, visits: visited.length },
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
      nodes.push({
        id: node.id,
        label: node.prefix === '' ? ROOT_LABEL : (node.prefix[node.prefix.length - 1] as string),
        value: node.words,
        role: node.terminal ? 'word' : 'prefix',
        depth: node.prefix.length,
        slot: `p:${node.prefix}`,
        origin: node.origin,
      });
      for (const [letter, child] of node.children) {
        edges.push({
          from: node.id,
          to: child,
          // The pointer name is the letter, so layout orders children a to z.
          slot: letter,
          reused: this.#get(child).origin < node.origin,
        });
      }
    }

    return { layout: 'dag', nodes, edges, roots: [...this.#roots] };
  }

  serialize(): SerializedState {
    const wordsOf = (id: NodeId, out: string[]): string[] => {
      const node = this.#get(id);
      if (node.terminal) out.push(node.prefix);
      for (const child of [...node.children.values()]) wordsOf(child, out);
      return out;
    };
    return {
      schemaVersion: SCHEMA_VERSION,
      pluginId: 'persistent-trie',
      data: { versions: this.#roots.map((r) => wordsOf(r, []).sort()) },
    };
  }
}

export const persistentTrie: AlgorithmPlugin = {
  meta: {
    id: 'persistent-trie',
    name: 'Persistent Trie',
    category: 'Persistent structures',
    summary: 'Words sharing prefixes, and versions sharing words.',
  },
  commands: COMMANDS,
  explain: explainTrie,
  benchmark: {
    // The size that matters here is the length of the word, not how many
    // words are stored: a lookup never touches a branch it does not follow.
    sizes: [4, 8, 16, 32, 64, 128],
    command: 'contains',
    setup: (n: number): readonly string[] => [`build [${'a'.repeat(n)} ${'b'.repeat(n)}]`],
    probes: (n: number): readonly string[] => [`contains v0 ${'a'.repeat(n)}`],
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
/**
 * Persistent trie.
 *
 * Words share their prefixes, so a node stands for a prefix rather than a
 * value. Inserting copies the O(len) nodes along the word's own path and reuses
 * every other branch - the same persistence trick as the other structures, but
 * over a node with up to twenty-six children rather than two.
 *
 * That fan-out is the point of building it: everything before this had at most
 * two children, so the layout engine's child ordering had only ever been
 * exercised on a synthetic fixture.
 */

import {
  diffRoots, getVersion, getWord, getWordList,
  type CommandSpec, type NodeId, type OperationError, type ParsedCommand, type SimEvent,
} from '@algoverse/core';
import {
  failed,
  type AlgorithmPlugin, type EngineContext, type OperationResult,
  type PluginInstance, type SerializedState,
  type StructureEdge, type StructureGraph, type StructureNode,
} from '@algoverse/plugin-sdk';
import { explainTrie } from './explain.ts';

const SCHEMA_VERSION = 1;
const ROOT_LABEL = '·';

interface Node {
  readonly id: NodeId;
  /** The prefix this node stands for. The root's is empty. */
  readonly prefix: string;
  /** True when some word ends exactly here. */
  readonly terminal: boolean;
  /** Words stored at or below this node. */
  readonly words: number;
  readonly children: ReadonlyMap<string, NodeId>;
  readonly origin: number;
}

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Create version 0 from a list of words.',
    complexity: 'O(total letters)',
    params: [{ name: 'words', kind: 'word-list' }],
  },
  {
    name: 'insert',
    summary: 'Add a word, producing a new version.',
    complexity: 'O(len)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'word', kind: 'word' },
    ],
  },
  {
    name: 'contains',
    summary: 'Is this exact word stored in a version?',
    complexity: 'O(len)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'word', kind: 'word' },
    ],
  },
  {
    name: 'count',
    summary: 'How many words in a version start with this prefix?',
    complexity: 'O(len)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'prefix', kind: 'word' },
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
  #next = 0;

  reset(): void {
    this.#nodes = new Map();
    this.#roots = [];
    this.#next = 0;
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getWordList(cmd, 'words'));
      case 'insert': return this.#insert(getVersion(cmd, 'version'), getWord(cmd, 'word'));
      case 'contains': return this.#lookup(getVersion(cmd, 'version'), getWord(cmd, 'word'), true);
      case 'count': return this.#lookup(getVersion(cmd, 'version'), getWord(cmd, 'prefix'), false);
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

  #alloc(
    prefix: string, terminal: boolean, words: number,
    children: ReadonlyMap<string, NodeId>, origin: number, events: SimEvent[],
  ): Node {
    const id = this.#next as NodeId;
    this.#next += 1;
    const node: Node = { id, prefix, terminal, words, children, origin };
    this.#nodes.set(id, node);
    events.push({
      kind: 'NodeAllocated',
      node: id,
      value: words,
      label: prefix === '' ? ROOT_LABEL : (prefix[prefix.length - 1] as string),
      role: terminal ? 'word' : 'prefix',
      // A prefix always sits at its own length, whatever else changes.
      depth: prefix.length,
      // One slot per prefix, so the same prefix in different versions aligns.
      slot: `p:${prefix}`,
      origin,
    });
    for (const [letter, child] of [...children].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      events.push({ kind: 'PointerSet', from: id, slot: letter, to: child });
      if (this.#get(child).origin < origin) {
        events.push({ kind: 'NodeReused', node: child, by: id });
      }
    }
    return node;
  }

  /** Copies the path the word walks; every other branch is shared. */
  #insertInto(id: NodeId | null, word: string, at: number, origin: number, events: SimEvent[]): Node {
    const prefix = word.slice(0, at);
    const existing = id === null ? null : this.#get(id);
    if (existing !== null) events.push({ kind: 'NodeVisited', node: existing.id });

    if (at === word.length) {
      return this.#alloc(
        prefix, true,
        (existing?.words ?? 0) + (existing?.terminal === true ? 0 : 1),
        existing?.children ?? new Map(), origin, events,
      );
    }

    const letter = word[at] as string;
    const nextId = existing?.children.get(letter) ?? null;
    const child = this.#insertInto(nextId, word, at + 1, origin, events);
    const children = new Map(existing?.children ?? []);
    children.set(letter, child.id);

    return this.#alloc(
      prefix, existing?.terminal ?? false,
      (existing?.words ?? 0) + (nextId === null ? 1 : child.words - this.#get(nextId).words),
      children, origin, events,
    );
  }

  #walk(root: NodeId, word: string, visited: NodeId[]): Node | null {
    let cursor: Node | null = this.#get(root);
    visited.push(root);
    for (const letter of word) {
      const next: NodeId | undefined = cursor?.children.get(letter);
      if (next === undefined) return null;
      cursor = this.#get(next);
      visited.push(next);
    }
    return cursor;
  }

  /* ── Commands ────────────────────────────────────────────────────── */

  #build(words: readonly string[]): OperationResult {
    this.reset();
    const events: SimEvent[] = [];
    const unique = [...new Set(words)];

    /**
     * Shaped first, allocated second. Inserting the words one at a time would
     * path-copy on every insert and commit only the final root, leaving every
     * intermediate node unreachable - the same waste the treap's build had.
     */
    interface Draft { terminal: boolean; readonly kids: Map<string, Draft> }
    const draft: Draft = { terminal: false, kids: new Map() };
    for (const word of unique) {
      let cursor = draft;
      for (const letter of word) {
        let next = cursor.kids.get(letter);
        if (next === undefined) { next = { terminal: false, kids: new Map() }; cursor.kids.set(letter, next); }
        cursor = next;
      }
      cursor.terminal = true;
    }

    const construct = (node: Draft, prefix: string): Node => {
      const children = new Map<string, NodeId>();
      let below = node.terminal ? 1 : 0;
      // Sorted so allocation order matches the order the trie reads in.
      for (const letter of [...node.kids.keys()].sort()) {
        const child = construct(node.kids.get(letter) as Draft, prefix + letter);
        children.set(letter, child.id);
        below += child.words;
      }
      return this.#alloc(prefix, node.terminal, below, children, 0, events);
    };
    const root = construct(draft, '').id;

    this.#roots.push(root);
    events.push({ kind: 'VersionCommitted', version: 0, roots: [root] });
    events.push({ kind: 'RootsSet', roots: [...this.#roots] });

    return {
      ok: true,
      value: { version: 0, words: this.#get(root).words, nodes: this.#nodes.size },
      events,
      statsDelta: {
        versions: 1,
        nodesAllocated: this.#nodes.size,
        height: Math.max(0, ...unique.map((w) => w.length)),
      },
    };
  }

  #insert(v: number, word: string): OperationResult {
    const root = this.#roots[v];
    if (root === undefined) {
      return failed(err('UNKNOWN_VERSION', `Version v${v} does not exist.`, this.#available()));
    }
    const found = this.#walk(root, word, []);
    if (found !== null && found.terminal) {
      return failed(err('PRECONDITION_FAILED', `"${word}" is already in v${v}.`,
        'a trie holds each word once'));
    }

    const events: SimEvent[] = [];
    const version = this.#roots.length;
    const before = this.#nodes.size;
    const newRoot = this.#insertInto(root, word, 0, version, events);
    this.#roots.push(newRoot.id);
    events.push({ kind: 'VersionCommitted', version, roots: [newRoot.id] });
    events.push({ kind: 'RootsSet', roots: [...this.#roots] });

    return {
      ok: true,
      value: { version, word, allocated: this.#nodes.size - before, words: newRoot.words },
      events,
      statsDelta: {
        versions: 1, updates: 1,
        nodesAllocated: this.#nodes.size - before,
        height: Math.max(word.length, 0),
      },
    };
  }

  #lookup(v: number, word: string, exact: boolean): OperationResult {
    const root = this.#roots[v];
    if (root === undefined) {
      return failed(err('UNKNOWN_VERSION', `Version v${v} does not exist.`, this.#available()));
    }
    const visited: NodeId[] = [];
    const node = this.#walk(root, word, visited);

    return {
      ok: true,
      value: exact
        ? { word, found: node !== null && node.terminal, visits: visited.length }
        : { prefix: word, words: node?.words ?? 0, visits: visited.length },
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
      nodes.push({
        id: node.id,
        label: node.prefix === '' ? ROOT_LABEL : (node.prefix[node.prefix.length - 1] as string),
        value: node.words,
        role: node.terminal ? 'word' : 'prefix',
        depth: node.prefix.length,
        slot: `p:${node.prefix}`,
        origin: node.origin,
      });
      for (const [letter, child] of node.children) {
        edges.push({
          from: node.id,
          to: child,
          // The pointer name is the letter, so layout orders children a to z.
          slot: letter,
          reused: this.#get(child).origin < node.origin,
        });
      }
    }

    return { layout: 'dag', nodes, edges, roots: [...this.#roots] };
  }

  serialize(): SerializedState {
    const wordsOf = (id: NodeId, out: string[]): string[] => {
      const node = this.#get(id);
      if (node.terminal) out.push(node.prefix);
      for (const child of [...node.children.values()]) wordsOf(child, out);
      return out;
    };
    return {
      schemaVersion: SCHEMA_VERSION,
      pluginId: 'persistent-trie',
      data: { versions: this.#roots.map((r) => wordsOf(r, []).sort()) },
    };
  }
}

export const persistentTrie: AlgorithmPlugin = {
  meta: {
    id: 'persistent-trie',
    name: 'Persistent Trie',
    category: 'Persistent structures',
    summary: 'Words sharing prefixes, and versions sharing words.',
  },
  commands: COMMANDS,
  explain: explainTrie,
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
