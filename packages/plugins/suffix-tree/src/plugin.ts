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
 * The construction is logged as it happens, which took a change to the event
 * model to make possible. A leaf's edge grows on every character, so labelling
 * leaves by what they spell would be n events per step for an algorithm whose
 * whole point is n events in total. Instead a leaf is drawn by **which suffix
 * it is** - a number that never changes - and the label it spells is filled in
 * once at the end, when the leaves stop growing. That final pass is not a fudge
 * to make the log tidy: turning the implicit tree into the explicit one by
 * closing the open ends is a real step of the algorithm, and it is exactly n
 * updates.
 *
 * The one other thing that changes is the surviving half of a split edge. Its
 * path from the root is unaffected - a split inserts a node above it - but what
 * its own edge spells gets shorter, and that is a single update per split.
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

  /**
   * What a node is called, which has to be settled when it is drawn.
   *
   * A leaf is named by the suffix it is, because the string it spells is not
   * known until the input ends; a branch is named by what its own edge spells,
   * which is fixed the moment it is cut out.
   */
  #describe(id: NodeId): { value: number; label: string; role: string; slot: string } {
    const n = this.#get(id);
    if (id === ROOT) return { value: 0, label: '·', role: 'root', slot: 'root' };
    /*
     * Which suffix a node stands for, or -1 for a branch. This rather than
     * "has no children": a node cut out by a split has none for the moment it
     * takes to attach them, and it was drawn as a leaf in that moment.
     */
    if (n.suffix >= 0) {
      return {
        // Which suffix, not how deep. A leaf's depth grows on every character
        // and the suffix it stands for never changes, so this is the number
        // that can be drawn once and left alone.
        value: n.suffix,
        // While the end is still open there is nothing to spell yet.
        label: n.end === null ? `${n.suffix}` : this.#labelOf(id),
        role: 'suffix',
        slot: `s${n.suffix}`,
      };
    }
    return {
      value: n.depthChars,
      label: this.#labelOf(id),
      role: 'branch',
      slot: `b${id}`,
    };
  }

  #make(
    start: number, end: number | null, suffix: number, depth: number, events: SimEvent[],
  ): NodeId {
    const id = this.#next as NodeId;
    this.#next += 1;
    this.#nodes.set(id, {
      id, start, end, next: new Map(), link: null, suffix, depthChars: depth, leaves: 0,
    });
    const drawn = this.#describe(id);
    events.push({
      kind: 'NodeAllocated',
      node: id,
      value: drawn.value,
      label: drawn.label,
      role: drawn.role,
      slot: drawn.slot,
      origin: 0,
    });
    return id;
  }

  #setNext(id: NodeId, letter: string, to: NodeId, events: SimEvent[]): void {
    const n = this.#get(id);
    const changed = n.next.get(letter) !== to;
    n.next.set(letter, to);
    if (changed) {
      events.push({ kind: 'PointerSet', from: id, slot: `c${letter}`, to, pointer: 'child' });
    }
  }

  #setLink(id: NodeId, to: NodeId, events: SimEvent[]): void {
    const n = this.#get(id);
    const changed = n.link !== to;
    n.link = to;
    this.#linksMade += 1;
    if (changed) {
      events.push({
        kind: 'PointerSet',
        from: id,
        slot: 'link',
        to,
        pointer: 'link',
        directed: true,
        weight: this.#get(to).depthChars,
      });
    }
  }

  /**
   * One character. The inner loop runs once per suffix still owed, and across
   * the whole word it runs O(n) times in total, because every turn either
   * settles a suffix or advances the active point past a character it will
   * never revisit.
   */
  #extend(i: number, events: SimEvent[]): void {
    this.#leafEnd = i;
    this.#remainder += 1;
    let lastNew: NodeId | null = null;

    while (this.#remainder > 0) {
      if (this.#activeLength === 0) this.#activeEdge = i;
      const first = this.#s[this.#activeEdge] as string;
      const onward = this.#get(this.#activeNode).next.get(first);

      if (onward === undefined) {
        // Nothing starts this way yet, so the suffix becomes a new leaf.
        this.#setNext(
          this.#activeNode, first,
          this.#make(i, null, i - this.#remainder + 1, 0, events),
          events,
        );
        if (lastNew !== null) {
          this.#setLink(lastNew, this.#activeNode, events);
          lastNew = null;
        }
      } else {
        events.push({ kind: 'NodeVisited', node: onward });
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
            this.#setLink(lastNew, this.#activeNode, events);
            lastNew = null;
          }
          this.#activeLength += 1;
          break;
        }

        // The edge agrees for a while and then does not, so it is cut in two
        // and the disagreement becomes a branch.
        const onwardNode = this.#get(onward);
        const split = this.#make(
          onwardNode.start, onwardNode.start + this.#activeLength, -1,
          this.#get(this.#activeNode).depthChars + this.#activeLength, events,
        );
        this.#setNext(this.#activeNode, first, split, events);
        this.#setNext(
          split, this.#s[i] as string,
          this.#make(i, null, i - this.#remainder + 1, 0, events),
          events,
        );

        /*
         * The surviving half keeps its path from the root and its children, and
         * loses the front of its own edge. That is the one thing in the whole
         * construction that changes an existing node without remaking it - and
         * a leaf is unaffected, because a leaf is drawn by which suffix it is
         * rather than by what it spells.
         */
        onwardNode.start += this.#activeLength;
        if (onwardNode.next.size > 0) {
          events.push({ kind: 'NodeUpdated', node: onward, label: this.#labelOf(onward) });
        }

        this.#setNext(split, this.#s[onwardNode.start] as string, onward, events);
        if (lastNew !== null) this.#setLink(lastNew, split, events);
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
        events.push({ kind: 'NodeVisited', node: this.#activeNode });
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

  /**
   * Closing the open ends.
   *
   * Until now every leaf has run to wherever the input had got to, which is why
   * a leaf is drawn by which suffix it is rather than by what it spells. The
   * input has finished, so the ends can be written down - and this is the step
   * that turns the implicit suffix tree into the explicit one, not a tidying-up
   * of the log. One update per leaf, which is n of them.
   */
  #close(events: SimEvent[]): void {
    for (const n of this.#nodes.values()) if (n.end === null) n.end = this.#s.length;
    this.#settle();
    for (const n of this.#nodes.values()) {
      if (n.id === ROOT || n.suffix < 0) continue;
      events.push({
        kind: 'NodeUpdated', node: n.id, label: this.#labelOf(n.id), value: n.suffix,
      });
    }
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
    const events: SimEvent[] = [];
    this.#make(-1, -1, -1, 0, events);
    for (let i = 0; i < this.#s.length; i += 1) this.#extend(i, events);
    this.#close(events);
    events.push({ kind: 'RootsSet', roots: [ROOT] });

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
      events,
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
      const drawn = this.#describe(n.id);
      nodes.push({
        id: n.id,
        label: drawn.label,
        value: drawn.value,
        role: drawn.role,
        slot: drawn.slot,
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
    command: 'build',
    /** Nothing: the command being measured is the one that does the building. */
    setup: (): readonly string[] => [],
    /**
     * A pseudo-random word over two letters, which branches the most and so
     * makes the most nodes and the most splits.
     *
     * `build` is the measured command now that the construction is logged. It
     * could not be before: nothing was recorded until the tree was finished, so
     * it emitted no traversal events and measured as costing nothing - the same
     * trap the Rabin-Karp benchmark fell into. What is counted is the walking
     * back through suffixes, which is the part whose linearity is the claim.
     */
    probes: (n: number): readonly string[] => {
      let x = 20_260_906 % 2147483647;
      let word = '';
      for (let i = 0; i < n; i += 1) {
        x = (x * 48271) % 2147483647;
        word += x % 2 === 0 ? 'a' : 'b';
      }
      return [`build ${word}`];
    },
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
