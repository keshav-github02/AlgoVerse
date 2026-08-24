/**
 * Suffix automaton.
 *
 * The suffix array next door holds every suffix of a word in sorted order, so
 * any substring is a contiguous block of it. This holds every **substring** at
 * once, as the smallest automaton that accepts exactly them - and it is built
 * one letter at a time, never looking back at the letters already read.
 *
 * The reason it stays small is that two substrings which always end at the same
 * set of positions are indistinguishable from then on: whatever can follow one
 * can follow the other. So states are those equivalence classes, and there are
 * fewer than 2n of them however long the word is. Each state stands for a run
 * of strings, all suffixes of one another, whose lengths fill the range from
 * `len(link) + 1` to `len` - which is why the number of distinct substrings is
 * a sum of those widths and needs no enumeration.
 *
 * The **suffix link** of a state points at the class of the longest suffix that
 * belongs to a different class. That is the same shape of idea as the failure
 * link in Aho-Corasick, and it is used the same way while building: to walk
 * back through shorter and shorter suffixes adding transitions until one is
 * already there.
 *
 * When one is already there, the interesting case appears. If that transition
 * leads to a state whose longest string is longer than the suffix being
 * extended, the state is standing for strings that no longer belong together -
 * some now end at the new position and some do not. It has to be **split**, and
 * the split is the only thing in the construction that is not obvious. One of
 * the halves is a copy: same transitions, same suffix link, a shorter `len`.
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
import { explainSuffixAutomaton } from './explain.ts';

const SCHEMA_VERSION = 1;

const MAX_LENGTH = 2048;

interface State {
  readonly id: NodeId;
  /** Length of the longest string in this state's class. */
  readonly len: number;
  /** The class of the longest suffix that is in a different class. */
  link: NodeId | null;
  readonly next: Map<string, NodeId>;
  /** Whether this state came from a split rather than from a new letter. */
  readonly split: boolean;
  /** Where the first occurrence of this state's longest string ends. */
  readonly firstEnd: number;
  /** How many times the strings of this class occur. Filled in after building. */
  count: number;
}

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Read a word one letter at a time, splitting states when they stop agreeing.',
    complexity: 'O(n)',
    params: [{ name: 'text', kind: 'word' }],
  },
  {
    name: 'contains',
    summary: 'Ask whether a word occurs, by walking it from the start state.',
    complexity: 'O(n)',
    params: [{ name: 'word', kind: 'word' }],
  },
  {
    name: 'occurrences',
    summary: 'How many times a word occurs, read off the state it lands on.',
    complexity: 'O(n)',
    params: [{ name: 'word', kind: 'word' }],
  },
  {
    name: 'distinct',
    summary: 'How many different substrings there are, without listing any of them.',
    complexity: 'O(n)',
    params: [],
  },
  {
    name: 'repeated',
    summary: 'The longest substring that occurs more than once.',
    complexity: 'O(n)',
    params: [],
  },
];

function err(code: OperationError['code'], message: string, hint?: string): OperationError {
  return { code, message, ...(hint === undefined ? {} : { hint }) };
}

const START = 0 as NodeId;

class Instance implements PluginInstance {
  #states = new Map<NodeId, State>();
  #text = '';
  #next = 0;
  /** The state the whole word lands on, which is where the suffixes hang from. */
  #last: NodeId = START;
  #splits = 0;

  reset(): void {
    this.#states = new Map();
    this.#text = '';
    this.#next = 0;
    this.#last = START;
    this.#splits = 0;
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getWord(cmd, 'text'));
      case 'contains': return this.#contains(getWord(cmd, 'word'));
      case 'occurrences': return this.#occurrences(getWord(cmd, 'word'));
      case 'distinct': return this.#distinct();
      case 'repeated': return this.#repeated();
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

  #get(id: NodeId): State {
    const s = this.#states.get(id);
    if (s === undefined) throw new Error(`no state ${id}`);
    return s;
  }

  /** The longest string a state stands for, cut out of the word. */
  #longestOf(id: NodeId): string {
    const s = this.#get(id);
    return s.len === 0 ? '' : this.#text.slice(s.firstEnd - s.len + 1, s.firstEnd + 1);
  }

  /* ── Building ────────────────────────────────────────────────────── */

  #alloc(len: number, split: boolean, firstEnd: number, events: SimEvent[]): NodeId {
    const id = this.#next as NodeId;
    this.#next += 1;
    this.#states.set(id, {
      id, len, link: null, next: new Map(), split, firstEnd, count: 0,
    });
    events.push({
      kind: 'NodeAllocated',
      node: id,
      // The length of the longest string in this class, which is also what
      // orders the states and what the substring count is a sum over.
      value: len,
      label: len === 0 ? '·' : `${len}`,
      role: len === 0 ? 'start' : (split ? 'split' : 'state'),
      depth: len,
      slot: `s${len}`,
      origin: 0,
    });
    return id;
  }

  #setLink(id: NodeId, to: NodeId | null, events: SimEvent[]): void {
    const s = this.#get(id);
    const changed = s.link !== to;
    s.link = to;
    if (changed) {
      events.push({
        kind: 'PointerSet',
        from: id,
        slot: 'link',
        to,
        pointer: 'link',
        directed: true,
        ...(to === null ? {} : { weight: this.#get(to).len }),
      });
    }
  }

  #setNext(id: NodeId, letter: string, to: NodeId, events: SimEvent[]): void {
    const s = this.#get(id);
    const changed = s.next.get(letter) !== to;
    s.next.set(letter, to);
    if (changed) {
      events.push({
        kind: 'PointerSet', from: id, slot: `t${letter}`, to, pointer: 'child',
      });
    }
  }

  /**
   * One more letter.
   *
   * The first loop walks back through the suffixes of what has been read,
   * adding a transition on `c` to the new state, and stops at the first suffix
   * that already has one. Every step of it adds a transition that stays, so
   * across the whole word the loop cannot run more times than there are
   * transitions - which is what makes the construction linear rather than
   * quadratic, and it is the same accounting as KMP's fallbacks.
   */
  #extend(c: string, index: number, events: SimEvent[]): void {
    const cur = this.#alloc(this.#get(this.#last).len + 1, false, index, events);
    this.#get(cur).count = 1;

    let p: NodeId | null = this.#last;
    while (p !== null && !this.#get(p).next.has(c)) {
      events.push({ kind: 'NodeVisited', node: p });
      this.#setNext(p, c, cur, events);
      p = this.#get(p).link;
    }

    if (p === null) {
      // Every suffix, down to the empty one, was missing this letter: the new
      // state's longest proper suffix in the automaton is the empty string.
      this.#setLink(cur, START, events);
      this.#last = cur;
      return;
    }

    events.push({ kind: 'NodeVisited', node: p });
    const q = this.#get(p).next.get(c) as NodeId;

    if (this.#get(p).len + 1 === this.#get(q).len) {
      // q stands for exactly the suffix being extended, so it can be used.
      this.#setLink(cur, q, events);
      this.#last = cur;
      return;
    }

    /*
     * q stands for strings longer than the one arrived at, and those longer
     * ones do not end at this new position while the shorter ones now do. They
     * have stopped being interchangeable, so the class has to be split: the
     * copy keeps the shorter strings and everything q could do, and q keeps
     * only the longer ones.
     */
    this.#splits += 1;
    const copy = this.#alloc(this.#get(p).len + 1, true, this.#get(q).firstEnd, events);
    this.#setLink(copy, this.#get(q).link, events);
    for (const [letter, to] of this.#get(q).next) this.#setNext(copy, letter, to, events);

    // Everything that reached q by this letter from a short enough suffix now
    // reaches the copy instead.
    let r: NodeId | null = p;
    while (r !== null && this.#get(r).next.get(c) === q) {
      events.push({ kind: 'NodeVisited', node: r });
      this.#setNext(r, c, copy, events);
      r = this.#get(r).link;
    }

    this.#setLink(q, copy, events);
    this.#setLink(cur, copy, events);
    this.#last = cur;
  }

  /**
   * How many times each class occurs.
   *
   * A state created for a new letter occurs at least at that position; a state
   * created by a split occurs only where its longer relatives do. Adding each
   * count into its suffix link, longest first, gathers them all - because the
   * occurrences of a string are the occurrences of every longer string that
   * ends with it, plus its own.
   */
  #countOccurrences(): void {
    const byLength = [...this.#states.values()].sort((a, b) => b.len - a.len);
    for (const s of byLength) {
      if (s.link !== null) this.#get(s.link).count += s.count;
    }
  }

  /** The classes the whole word's suffixes land on. */
  #terminals(): Set<NodeId> {
    const out = new Set<NodeId>();
    let cur: NodeId | null = this.#last;
    while (cur !== null) {
      out.add(cur);
      cur = this.#get(cur).link;
    }
    return out;
  }

  #build(text: string): OperationResult {
    if (text.length > MAX_LENGTH) {
      return failed(err('BAD_ARGUMENT', `A word of ${text.length} letters is too long.`,
        `the longest is ${MAX_LENGTH}`));
    }

    this.reset();
    const events: SimEvent[] = [];
    this.#alloc(0, false, -1, events);
    this.#text = text;

    for (let i = 0; i < text.length; i += 1) {
      this.#extend(text[i] as string, i, events);
    }
    this.#countOccurrences();
    events.push({ kind: 'RootsSet', roots: [START] });

    const n = text.length;
    return {
      ok: true,
      value: {
        text,
        length: n,
        states: this.#states.size,
        // Splits are the only way the state count exceeds one per letter, and
        // there are never more than n - 1 of them.
        splits: this.#splits,
        // Fewer than 2n, whatever the letters are.
        statesPerLetter: n === 0 ? 0 : Math.round((this.#states.size / n) * 100) / 100,
        distinctSubstrings: this.#distinctCount(),
        suffixStates: this.#terminals().size,
      },
      events,
      statsDelta: { nodesAllocated: this.#states.size, updates: 1 },
    };
  }

  /* ── Asking ──────────────────────────────────────────────────────── */

  /** Walk a word from the start state, or say where it fell off. */
  #walk(word: string, events: SimEvent[]): NodeId | null {
    let cur = START;
    for (const letter of word) {
      const onward = this.#get(cur).next.get(letter);
      if (onward === undefined) return null;
      cur = onward;
      events.push({ kind: 'NodeVisited', node: cur });
    }
    return cur;
  }

  #contains(word: string): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);

    const events: SimEvent[] = [];
    const landed = this.#walk(word, events);

    return {
      ok: true,
      value: {
        word,
        contains: landed !== null,
        // How many letters were walked before falling off, which is the longest
        // prefix of the question that is a substring. One step per letter and
        // never any backtracking, so this is the cost as well as the answer.
        matched: events.length,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: events.length },
    };
  }

  #occurrences(word: string): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);

    const events: SimEvent[] = [];
    const landed = this.#walk(word, events);

    return {
      ok: true,
      value: {
        word,
        count: landed === null ? 0 : this.#get(landed).count,
        // Every string in one class occurs the same number of times, which is
        // the reason one number per state is enough.
        sharesItsClassWith: (() => {
          if (landed === null) return 0;
          const link = this.#get(landed).link;
          return this.#get(landed).len - (link === null ? 0 : this.#get(link).len) - 1;
        })(),
      },
      events,
      statsDelta: { queries: 1, nodeVisits: events.length },
    };
  }

  /**
   * Each state stands for the strings whose lengths run from `len(link) + 1` to
   * `len`, and no string is in two classes, so adding those widths up counts
   * every substring exactly once.
   */
  #distinctCount(): number {
    let total = 0;
    for (const s of this.#states.values()) {
      if (s.link === null) continue;
      total += s.len - this.#get(s.link).len;
    }
    return total;
  }

  #distinct(): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);

    const n = this.#text.length;
    return {
      ok: true,
      value: {
        text: this.#text,
        distinct: this.#distinctCount(),
        // What it would be if no substring ever repeated.
        atMost: (n * (n + 1)) / 2,
        states: this.#states.size,
      },
      events: [...this.#states.values()].map((s): SimEvent => ({
        kind: 'NodeVisited', node: s.id,
      })),
      statsDelta: { queries: 1, nodeVisits: this.#states.size },
    };
  }

  #repeated(): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);

    /*
     * A state whose class occurs twice or more contains only strings that occur
     * twice or more, so the answer is the longest string of the deepest such
     * state. Nothing has to be compared against anything.
     */
    let best: NodeId | null = null;
    for (const s of this.#states.values()) {
      if (s.link === null || s.count < 2) continue;
      if (best === null || s.len > this.#get(best).len) best = s.id;
    }

    return {
      ok: true,
      value: {
        text: this.#text,
        length: best === null ? 0 : this.#get(best).len,
        substring: best === null ? null : this.#longestOf(best),
        occurrences: best === null ? 0 : this.#get(best).count,
      },
      events: [...this.#states.values()].map((s): SimEvent => ({
        kind: 'NodeVisited', node: s.id,
      })),
      statsDelta: { queries: 1, nodeVisits: this.#states.size },
    };
  }

  /* ── Views ───────────────────────────────────────────────────────── */

  getStructure(): StructureGraph {
    const nodes: StructureNode[] = [];
    const edges: StructureEdge[] = [];

    for (const s of [...this.#states.values()].sort((a, b) => a.id - b.id)) {
      nodes.push({
        id: s.id,
        label: s.len === 0 ? '·' : `${s.len}`,
        value: s.len,
        role: s.len === 0 ? 'start' : (s.split ? 'split' : 'state'),
        depth: s.len,
        slot: `s${s.len}`,
        origin: 0,
      });
      for (const [letter, to] of s.next) {
        edges.push({
          from: s.id, to, slot: `t${letter}`, reused: false, kind: 'child',
        });
      }
      if (s.link !== null) {
        edges.push({
          from: s.id, to: s.link, slot: 'link',
          reused: false, kind: 'link', directed: true, weight: this.#get(s.link).len,
        });
      }
    }

    return {
      layout: 'dag', nodes, edges, roots: this.#states.size === 0 ? [] : [START],
    };
  }

  serialize(): SerializedState {
    return {
      schemaVersion: SCHEMA_VERSION,
      pluginId: 'suffix-automaton',
      data: { text: this.#text },
    };
  }
}

export const suffixAutomaton: AlgorithmPlugin = {
  meta: {
    id: 'suffix-automaton',
    name: 'Suffix Automaton',
    category: 'Strings',
    summary: 'The smallest automaton accepting every substring of a word, built one letter '
      + 'at a time.',
  },
  commands: COMMANDS,
  explain: explainSuffixAutomaton,
  benchmark: {
    sizes: [16, 32, 64, 128, 256, 512],
    command: 'build',
    /** Nothing: the command being measured is the one that does the building. */
    setup: (): readonly string[] => [],
    /**
     * A pseudo-random word over two letters, which is the shape that produces
     * the most states and the most splits - a word of one repeated letter needs
     * no splits at all and would measure the easy case.
     *
     * Seeded the same every run so the measurement is reproducible, and MINSTD
     * because its multiplier keeps the arithmetic exact.
     */
    probes: (n: number): readonly string[] => {
      let x = 20_260_903 % 2147483647;
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
