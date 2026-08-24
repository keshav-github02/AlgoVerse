/**
 * Suffix tree, built by Ukkonen's algorithm.
 *
 * The last of the three ways this repo holds every substring of a word. The
 * suffix array sorts the suffixes; the suffix automaton merges the positions
 * that behave alike; this one is the compressed trie of all the suffixes, and it
 * is the oldest and most direct of the three - a substring is a path down from
 * the root, full stop.
 *
 * What makes it hard is building it in linear time, and Ukkonen's construction
 * is worth reading for three ideas that have nothing to do with trees:
 *
 *   - **A leaf's edge is left open.** Every leaf runs to the end of the input,
 *     so rather than lengthening every leaf on every character, the end is a
 *     single shared number. One assignment does what would otherwise be n.
 *   - **Only one place needs looking at.** The *active point* - a node, an edge
 *     and how far along it - is where the next suffix goes in. It is carried
 *     from step to step rather than searched for.
 *   - **A suffix link says where the next suffix starts from.** After inserting
 *     the suffix beginning at j, the one beginning at j+1 is inserted from the
 *     node reached by dropping the first character, and that is one pointer
 *     away rather than a walk from the root.
 *
 * A note on what is drawn, because it is a real limitation rather than a
 * choice. The picture here is the **finished** tree, not the construction. A
 * faithful step-by-step log is not possible: a leaf's edge label grows on every
 * character, so writing down what changed at each step would be n events per
 * step for an algorithm whose whole point is n events in total. Rather than
 * quietly log something that is not what happened, the build reports the shape
 * of the construction as numbers - phases, splits, suffix links - and draws the
 * tree it arrived at. Queries are logged step by step as usual.
 */

import {
  getWord,
  type CommandSpec, type NodeId, type OperationError, type ParsedCommand, type SimEvent,
} from '@algoverse/core';
import {
  failed,
  type AlgorithmPlugin, type EngineContext, type OperationResult,
  type PluginInstance, type SerializedState,
  type StructureEdge, type StructureGraph, type StructureNode,
} from '@algoverse/plugin-sdk';
import { explainSuffixTree } from './explain.ts';

const SCHEMA_VERSION = 1;

const MAX_LENGTH = 1024;

/**
 * Appended so that no suffix is a prefix of another, which is what makes every
 * suffix end at a leaf of its own rather than somewhere in the middle of an
 * edge. Words are letters only, so this cannot occur in the input.
 */
const END = '$';

interface Node {
  readonly id: NodeId;
  /** The edge arriving here, as a window on the text. */
  start: number;
  /** Where that window ends, or null for a leaf, which runs to the end. */
  end: number | null;
  readonly next: Map<string, NodeId>;
  link: NodeId | null;
  /** Which suffix this leaf is, or -1 for an internal node. */
  suffix: number;
  /* Filled in once, after the construction has finished. */
  depthChars: number;
  leaves: number;
}

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Build the compressed trie of every suffix, one character at a time.',
    complexity: 'O(n)',
    params: [{ name: 'text', kind: 'word' }],
  },
  {
    name: 'contains',
    summary: 'Ask whether a word occurs, by walking it down from the root.',
    complexity: 'O(n)',
    params: [{ name: 'word', kind: 'word' }],
  },
  {
    name: 'occurrences',
    summary: 'How many times a word occurs, which is how many leaves are below it.',
    complexity: 'O(n)',
    params: [{ name: 'word', kind: 'word' }],
  },
  {
    name: 'repeated',
    summary: 'The longest substring that occurs more than once - the deepest branching node.',
    complexity: 'O(n)',
    params: [],
  },
  {
    name: 'edges',
    summary: 'Read the tree out, one line per edge, with what each one spells.',
    complexity: 'O(n)',
    params: [],
  },
];

function err(code: OperationError['code'], message: string, hint?: string): OperationError {
  return { code, message, ...(hint === undefined ? {} : { hint }) };
}

const ROOT = 0 as NodeId;

class Instance implements PluginInstance {
  #nodes = new Map<NodeId, Node>();
  /** The word with the terminator on the end, which is what the tree is over. */
  #s = '';
  #text = '';
  #next = 0;
  #splits = 0;
  #linksMade = 0;

  /* The active point, and the count of suffixes still owed. */
  #activeNode: NodeId = ROOT;
  #activeEdge = -1;
  #activeLength = 0;
  #remainder = 0;
  #leafEnd = -1;

  reset(): void {
    this.#nodes = new Map();
    this.#s = '';
    this.#text = '';
    this.#next = 0;
    this.#splits = 0;
    this.#linksMade = 0;
    this.#activeNode = ROOT;
    this.#activeEdge = -1;
    this.#activeLength = 0;
    this.#remainder = 0;
    this.#leafEnd = -1;
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getWord(cmd, 'text'));
      case 'contains': return this.#contains(getWord(cmd, 'word'));
      case 'occurrences': return this.#occurrences(getWord(cmd, 'word'));
      case 'repeated': return this.#repeated();
      case 'edges': return this.#edges();
      default:
        return failed(err('PARSE_ERROR', `This plugin does not handle "${cmd.name}".`));
    }
  }

  #ready(): OperationError | null {
    return this.#text.length === 0
      ? err('PRECONDITION_FAILED', 'No word has been built yet.',
        'start with build, as in: build abcbc')
      : null;
  }

  #get(id: NodeId): Node {
    const n = this.#nodes.get(id);
    if (n === undefined) throw new Error(`no node ${id}`);
    return n;
  }

  /** Where a node's edge ends: fixed for a branch, the current end for a leaf. */
  #endOf(id: NodeId): number {
    const n = this.#get(id);
    return n.end === null ? this.#leafEnd + 1 : n.end;
  }

  #edgeLength(id: NodeId): number {
    return this.#endOf(id) - this.#get(id).start;
  }

  /** What a node's incoming edge spells. */
  #labelOf(id: NodeId): string {
    const n = this.#get(id);
    return n.start < 0 ? '' : this.#s.slice(n.start, this.#endOf(id));
  }

  /* ── Ukkonen ─────────────────────────────────────────────────────── */

  #make(start: number, end: number | null, suffix: number): NodeId {
    const id = this.#next as NodeId;
    this.#next += 1;
    this.#nodes.set(id, {
      id, start, end, next: new Map(), link: null, suffix, depthChars: 0, leaves: 0,
    });
    return id;
  }

  /**
   * One character. The inner loop runs once per suffix still owed, and across
   * the whole word it runs O(n) times in total, because every turn either
   * settles a suffix or advances the active point past a character it will
   * never revisit.
   */
  #extend(i: number): void {
    this.#leafEnd = i;
    this.#remainder += 1;
    let lastNew: NodeId | null = null;

    while (this.#remainder > 0) {
      if (this.#activeLength === 0) this.#activeEdge = i;
      const first = this.#s[this.#activeEdge] as string;
      const onward = this.#get(this.#activeNode).next.get(first);

      if (onward === undefined) {
        // Nothing starts this way yet, so the suffix becomes a new leaf.
        this.#get(this.#activeNode).next.set(
          first, this.#make(i, null, i - this.#remainder + 1),
        );
        if (lastNew !== null) {
          this.#get(lastNew).link = this.#activeNode;
          this.#linksMade += 1;
          lastNew = null;
        }
      } else {
        const span = this.#edgeLength(onward);
        if (this.#activeLength >= span) {
          // The active point is past the end of this edge: step over it. The
          // step is what keeps the whole thing linear - the characters skipped
          // are never looked at again.
          this.#activeEdge += span;
          this.#activeLength -= span;
          this.#activeNode = onward;
          continue;
        }
        if (this.#s[this.#get(onward).start + this.#activeLength] === this.#s[i]) {
          /*
           * The character is already there. Nothing to insert, and nothing
           * after this in the phase can need inserting either - every shorter
           * suffix is present for the same reason. So the phase stops, still
           * owing suffixes, and the debt is paid by a later character.
           */
          if (lastNew !== null && this.#activeNode !== ROOT) {
            this.#get(lastNew).link = this.#activeNode;
            this.#linksMade += 1;
            lastNew = null;
          }
          this.#activeLength += 1;
          break;
        }

        // The edge agrees for a while and then does not, so it is cut in two
        // and the disagreement becomes a branch.
        const onwardNode = this.#get(onward);
        const split = this.#make(onwardNode.start, onwardNode.start + this.#activeLength, -1);
        this.#get(this.#activeNode).next.set(first, split);
        this.#get(split).next.set(
          this.#s[i] as string, this.#make(i, null, i - this.#remainder + 1),
        );
        onwardNode.start += this.#activeLength;
        this.#get(split).next.set(this.#s[onwardNode.start] as string, onward);
        if (lastNew !== null) {
          this.#get(lastNew).link = split;
          this.#linksMade += 1;
        }
        lastNew = split;
        this.#splits += 1;
      }

      this.#remainder -= 1;
      if (this.#activeNode === ROOT && this.#activeLength > 0) {
        this.#activeLength -= 1;
        this.#activeEdge = i - this.#remainder + 1;
      } else if (this.#activeNode !== ROOT) {
        // The suffix link: where the next-shorter suffix is inserted from.
        this.#activeNode = this.#get(this.#activeNode).link ?? ROOT;
      }
    }
  }

  /** String depths and leaf counts, once the shape has stopped moving. */
  #settle(): void {
    const walk = (id: NodeId, depth: number): number => {
      const n = this.#get(id);
      n.depthChars = depth;
      if (n.next.size === 0) {
        n.leaves = 1;
        return 1;
      }
      let total = 0;
      for (const child of n.next.values()) {
        total += walk(child, depth + this.#edgeLength(child));
      }
      n.leaves = total;
      return total;
    };
    walk(ROOT, 0);
  }

  /* ── Drawing, once ───────────────────────────────────────────────── */

  #picture(): SimEvent[] {
    const events: SimEvent[] = [];
    const order: NodeId[] = [];
    const collect = (id: NodeId): void => {
      order.push(id);
      for (const child of [...this.#get(id).next.values()].sort((a, b) => a - b)) collect(child);
    };
    collect(ROOT);

    for (const id of order) {
      const n = this.#get(id);
      const leaf = n.next.size === 0;
      events.push({
        kind: 'NodeAllocated',
        node: id,
        // How far into the word the path to here reaches. For a leaf that is
        // the whole suffix, so the two numbers on screen say the same thing
        // from either end.
        value: n.depthChars,
        label: id === ROOT ? '·' : this.#labelOf(id),
        role: id === ROOT ? 'root' : (leaf ? 'suffix' : 'branch'),
        slot: id === ROOT ? 'root' : (leaf ? `s${n.suffix}` : `b${id}`),
        origin: 0,
      });
    }
    for (const id of order) {
      for (const [first, child] of this.#get(id).next) {
        events.push({
          kind: 'PointerSet', from: id, slot: `c${first}`, to: child, pointer: 'child',
        });
      }
    }
    for (const id of order) {
      const link = this.#get(id).link;
      if (link === null) continue;
      events.push({
        kind: 'PointerSet',
        from: id,
        slot: 'link',
        to: link,
        pointer: 'link',
        directed: true,
        weight: this.#get(link).depthChars,
      });
    }
    events.push({ kind: 'RootsSet', roots: [ROOT] });
    return events;
  }

  /* ── Commands ────────────────────────────────────────────────────── */

  #build(text: string): OperationResult {
    if (text.length > MAX_LENGTH) {
      return failed(err('BAD_ARGUMENT', `A word of ${text.length} letters is too long.`,
        `the longest is ${MAX_LENGTH}`));
    }

    this.reset();
    this.#text = text;
    this.#s = `${text}${END}`;
    this.#make(-1, -1, -1);
    for (let i = 0; i < this.#s.length; i += 1) this.#extend(i);
    // Leaves stop growing here, so their open ends can be closed and the shape
    // read off without the global end being consulted again.
    for (const n of this.#nodes.values()) if (n.end === null) n.end = this.#s.length;
    this.#settle();

    const leaves = [...this.#nodes.values()].filter((n) => n.next.size === 0).length;
    const edgeChars = [...this.#nodes.values()]
      .filter((n) => n.id !== ROOT)
      .reduce((sum, n) => sum + this.#edgeLength(n.id), 0);

    return {
      ok: true,
      value: {
        text,
        length: text.length,
        // One per suffix of the word with the terminator, which is why the
        // terminator is there: without it a suffix could end mid-edge.
        leaves,
        nodes: this.#nodes.size,
        branches: this.#nodes.size - leaves - 1,
        splits: this.#splits,
        suffixLinks: this.#linksMade,
        /*
         * Every substring is a path ending somewhere along some edge, and each
         * edge offers one per character of it. The terminator contributes one
         * dead end per leaf, so those come off again.
         */
        distinctSubstrings: edgeChars - leaves,
      },
      events: this.#picture(),
      statsDelta: { nodesAllocated: this.#nodes.size, updates: 1 },
    };
  }

  /**
   * Walk a word down from the root.
   *
   * Returns the node whose edge the word ended on, or null if it fell off. The
   * word may end part way along an edge, and where it ends does not matter to
   * either question asked of it - what matters is the subtree below.
   */
  #descend(word: string, events: SimEvent[]): { at: NodeId; matched: number } {
    let cur = ROOT;
    let matched = 0;

    while (matched < word.length) {
      const child = this.#get(cur).next.get(word[matched] as string);
      if (child === undefined) return { at: cur, matched };
      events.push({ kind: 'NodeVisited', node: child });
      const label = this.#labelOf(child);
      let k = 0;
      while (k < label.length && matched + k < word.length) {
        if (label[k] !== word[matched + k]) return { at: child, matched: matched + k };
        k += 1;
      }
      matched += k;
      cur = child;
    }
    return { at: cur, matched };
  }

  #contains(word: string): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);

    const events: SimEvent[] = [];
    const walk = this.#descend(word, events);

    return {
      ok: true,
      value: {
        word,
        contains: walk.matched === word.length,
        // The longest prefix of the question that is a substring.
        matched: walk.matched,
        edgesFollowed: events.length,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: events.length },
    };
  }

  #occurrences(word: string): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);

    const events: SimEvent[] = [];
    const walk = this.#descend(word, events);
    const complete = walk.matched === word.length;

    return {
      ok: true,
      value: {
        word,
        /*
         * One leaf per suffix, so the leaves below a point are exactly the
         * suffixes beginning with the path to it - which is the same thing as
         * the positions the word occurs at.
         */
        count: complete ? this.#get(walk.at).leaves : 0,
        edgesFollowed: events.length,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: events.length },
    };
  }

  #repeated(): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);

    /*
     * A branching node means two suffixes share the path to it and then differ,
     * so that path occurs at least twice. The deepest one is therefore the
     * longest repeat, and no comparing is involved. A leaf cannot qualify: its
     * path ends in the terminator, which occurs once.
     */
    let best: Node | null = null;
    const events: SimEvent[] = [];
    for (const n of this.#nodes.values()) {
      events.push({ kind: 'NodeVisited', node: n.id });
      if (n.id === ROOT || n.next.size === 0) continue;
      if (best === null || n.depthChars > best.depthChars) best = n;
    }

    const where = best === null ? -1 : this.#endOf(best.id) - best.depthChars;
    return {
      ok: true,
      value: {
        text: this.#text,
        length: best === null ? 0 : best.depthChars,
        substring: best === null ? null : this.#s.slice(where, where + best.depthChars),
        occurrences: best === null ? 0 : best.leaves,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: this.#nodes.size },
    };
  }

  #edges(): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);

    const rows: { from: string; spells: string; leadsTo: string; below: number }[] = [];
    const walk = (id: NodeId, path: string): void => {
      for (const child of [...this.#get(id).next.values()].sort((a, b) => a - b)) {
        const label = this.#labelOf(child);
        const n = this.#get(child);
        rows.push({
          from: path === '' ? '·' : path,
          spells: label,
          leadsTo: n.next.size === 0 ? `suffix ${n.suffix}` : `${path}${label}`,
          below: n.leaves,
        });
        walk(child, `${path}${label}`);
      }
    };
    walk(ROOT, '');

    return {
      ok: true,
      value: { text: this.#text, edges: rows.length, rows },
      events: [...this.#nodes.values()].map((n): SimEvent => ({
        kind: 'NodeVisited', node: n.id,
      })),
      statsDelta: { queries: 1, nodeVisits: this.#nodes.size },
    };
  }

  /* ── Views ───────────────────────────────────────────────────────── */

  getStructure(): StructureGraph {
    const nodes: StructureNode[] = [];
    const edges: StructureEdge[] = [];

    for (const n of [...this.#nodes.values()].sort((a, b) => a.id - b.id)) {
      const leaf = n.next.size === 0;
      nodes.push({
        id: n.id,
        label: n.id === ROOT ? '·' : this.#labelOf(n.id),
        value: n.depthChars,
        role: n.id === ROOT ? 'root' : (leaf ? 'suffix' : 'branch'),
        slot: n.id === ROOT ? 'root' : (leaf ? `s${n.suffix}` : `b${n.id}`),
        origin: 0,
      });
      for (const [first, child] of n.next) {
        edges.push({
          from: n.id, to: child, slot: `c${first}`, reused: false, kind: 'child',
        });
      }
      if (n.link !== null) {
        edges.push({
          from: n.id, to: n.link, slot: 'link',
          reused: false, kind: 'link', directed: true, weight: this.#get(n.link).depthChars,
        });
      }
    }

    return {
      layout: 'dag', nodes, edges, roots: this.#nodes.size === 0 ? [] : [ROOT],
    };
  }

  serialize(): SerializedState {
    return {
      schemaVersion: SCHEMA_VERSION,
      pluginId: 'suffix-tree',
      data: { text: this.#text },
    };
  }
}

export const suffixTree: AlgorithmPlugin = {
  meta: {
    id: 'suffix-tree',
    name: 'Suffix Tree',
    category: 'Strings',
    summary: 'The compressed trie of every suffix, built in one pass by leaving the leaves open.',
  },
  commands: COMMANDS,
  explain: explainSuffixTree,
  benchmark: {
    sizes: [16, 32, 64, 128, 256, 512],
    command: 'repeated',
    /**
     * A pseudo-random word over two letters, which branches the most and so
     * makes the most nodes. `build` itself cannot be the measured command here:
     * the construction is not logged step by step, for the reason given at the
     * top of this file, so it emits no traversal events and would measure as
     * costing nothing. `repeated` looks at every node, which is the honest
     * linear thing this structure does.
     */
    setup: (n: number): readonly string[] => {
      let x = 20_260_906 % 2147483647;
      let word = '';
      for (let i = 0; i < n; i += 1) {
        x = (x * 48271) % 2147483647;
        word += x % 2 === 0 ? 'a' : 'b';
      }
      return [`build ${word}`];
    },
    probes: (): readonly string[] => ['repeated'],
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
