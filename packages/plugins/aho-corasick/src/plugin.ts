/**
 * Aho-Corasick.
 *
 * KMP reads a text once looking for one word, by precomputing where to resume
 * after a mismatch. This is the same idea with the pattern replaced by a set of
 * them: a trie of every word, with a failure link from each node saying where
 * to resume, and one pass over the text finding every occurrence of every word.
 *
 * The failure link of a node is the node for the **longest proper suffix of
 * this node's string that is also a prefix of some word**. On a single word
 * that is exactly KMP's border function, and the pictures next door look the
 * same for that reason - one link back from each position. What generalises is
 * the phrase "a prefix of some word": with one word the only prefixes are its
 * own, so the links form a chain; with several they form a tree over a tree.
 *
 * Failure links are found breadth-first, and they have to be. The link of a
 * node one level down is found by following its parent's link and taking the
 * same letter - which requires the parent's link to be known already, and the
 * parent is one level up. Depth order is therefore not an optimisation but the
 * only order in which the definition can be applied.
 *
 * Two things are then worth separating, and this plugin has a command for
 * each. Walking the automaton over a text is O(n) whatever the words are.
 * *Listing* the occurrences is not: a text can contain a quadratic number of
 * them, and no algorithm can report more matches than it has time to write
 * down. So `count` answers how many in one pass, using a precomputed count per
 * state, and `search` lists them and is honest about costing more.
 */

import {
  getWord, getWordList,
  type CommandSpec, type NodeId, type OperationError, type ParsedCommand, type SimEvent,
} from '@algoverse/core';
import {
  failed,
  type AlgorithmPlugin, type EngineContext, type OperationResult,
  type PluginInstance, type SerializedState,
  type StructureEdge, type StructureGraph, type StructureNode,
} from '@algoverse/plugin-sdk';
import { explainAhoCorasick } from './explain.ts';

const SCHEMA_VERSION = 1;

const MAX_WORDS = 64;
const MAX_LENGTH = 4096;

interface State {
  readonly id: NodeId;
  /** The letter on the edge that arrives here; empty at the root. */
  readonly letter: string;
  readonly depth: number;
  readonly parent: NodeId | null;
  readonly next: Map<string, NodeId>;
  /** Longest proper suffix of this state's string that is a prefix of a word. */
  fail: NodeId | null;
  /** Nearest state along the failure chain that ends a word, if any. */
  output: NodeId | null;
  /** Words ending exactly here. More than one only if a word is repeated. */
  readonly ends: string[];
  /** Words ending at this state or at any state along its failure chain. */
  matches: number;
}

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Build a trie of the words and link each node to where a mismatch resumes.',
    complexity: 'O(n)',
    params: [{ name: 'words', kind: 'word-list' }],
  },
  {
    name: 'search',
    summary: 'Read a text once, listing every occurrence of every word.',
    complexity: 'O(n + z)',
    params: [{ name: 'text', kind: 'word' }],
  },
  {
    name: 'count',
    summary: 'How many occurrences there are, without listing them.',
    complexity: 'O(n)',
    params: [{ name: 'text', kind: 'word' }],
  },
  {
    name: 'links',
    summary: 'Where each state resumes on a mismatch, and what it says about the words.',
    complexity: 'O(n)',
    params: [],
  },
];

function err(code: OperationError['code'], message: string, hint?: string): OperationError {
  return { code, message, ...(hint === undefined ? {} : { hint }) };
}

const ROOT = 0 as NodeId;

class Instance implements PluginInstance {
  #states = new Map<NodeId, State>();
  #words: string[] = [];
  #next = 0;
  #built = false;

  reset(): void {
    this.#states = new Map();
    this.#words = [];
    this.#next = 0;
    this.#built = false;
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getWordList(cmd, 'words'));
      case 'search': return this.#search(getWord(cmd, 'text'));
      case 'count': return this.#count(getWord(cmd, 'text'));
      case 'links': return this.#links();
      default:
        return failed(err('PARSE_ERROR', `This plugin does not handle "${cmd.name}".`));
    }
  }

  #ready(): OperationError | null {
    return this.#built
      ? null
      : err('PRECONDITION_FAILED', 'No words have been built yet.',
        'start with build, as in: build [he she his hers]');
  }

  #get(id: NodeId): State {
    const s = this.#states.get(id);
    if (s === undefined) throw new Error(`no state ${id}`);
    return s;
  }

  /** The string a state stands for, read back up the trie. */
  #stringOf(id: NodeId): string {
    const parts: string[] = [];
    let cur: NodeId | null = id;
    while (cur !== null) {
      const s = this.#get(cur);
      if (s.parent !== null) parts.push(s.letter);
      cur = s.parent;
    }
    return parts.reverse().join('');
  }

  /* ── Building ────────────────────────────────────────────────────── */

  /** What a state is called, which has to be settled before it is drawn. */
  #roleOf(s: State): string {
    if (s.parent === null) return 'root';
    return s.ends.length > 0 ? 'word' : 'inner';
  }

  /**
   * Failure links, breadth-first.
   *
   * For a child `c` of `v` reached by letter `x`, follow v's failure link and
   * take `x` from there; if that is not possible, follow again, and so on to
   * the root. That is the definition applied literally, and it terminates
   * because each step is strictly shorter.
   *
   * The root's children are the special case: their only proper suffix is the
   * empty string, so they fail to the root.
   */
  #linkUp(events: SimEvent[]): void {
    const queue: NodeId[] = [];
    const root = this.#get(ROOT);
    root.fail = null;
    root.output = null;
    root.matches = root.ends.length;

    for (const child of root.next.values()) {
      const c = this.#get(child);
      c.fail = ROOT;
      queue.push(child);
      events.push({
        kind: 'PointerSet', from: child, slot: 'fail', to: ROOT, pointer: 'link', directed: true,
      });
    }

    for (let head = 0; head < queue.length; head += 1) {
      const id = queue[head] as NodeId;
      const state = this.#get(id);

      for (const [letter, child] of state.next) {
        let candidate = state.fail;
        while (candidate !== null && !this.#get(candidate).next.has(letter)) {
          candidate = this.#get(candidate).fail;
        }
        const target = candidate === null
          ? ROOT
          : (this.#get(candidate).next.get(letter) as NodeId);
        // A state cannot fail to itself: the suffix has to be proper.
        this.#get(child).fail = target === child ? ROOT : target;
        queue.push(child);
        const fail = this.#get(child).fail as NodeId;
        events.push({
          kind: 'PointerSet',
          from: child,
          slot: 'fail',
          to: fail,
          pointer: 'link',
          directed: true,
          weight: this.#get(fail).depth,
        });
      }

      /*
       * The output link skips the states along the failure chain that do not
       * end a word, so listing the matches at a position costs one step per
       * match rather than one per letter of the string. Without it, listing is
       * O(depth) at every position even when nothing matches.
       */
      const fail = state.fail as NodeId;
      const failState = this.#get(fail);
      state.output = failState.ends.length > 0 ? fail : failState.output;
      // Matches ending anywhere in this state's suffix chain, which is what
      // makes counting a single read.
      state.matches = state.ends.length + failState.matches;

      if (state.output !== null) {
        events.push({
          kind: 'PointerSet',
          from: id,
          slot: 'out',
          to: state.output,
          pointer: 'link',
          directed: true,
          weight: this.#get(state.output).depth,
        });
      }
    }
  }

  #build(words: readonly string[]): OperationResult {
    if (words.length > MAX_WORDS) {
      return failed(err('BAD_ARGUMENT', `${words.length} words is too many.`,
        `the limit is ${MAX_WORDS}`));
    }
    const total = words.reduce((sum, w) => sum + w.length, 0);
    if (total > MAX_LENGTH) {
      return failed(err('BAD_ARGUMENT', `${total} letters of words is too many.`,
        `the limit is ${MAX_LENGTH} across all of them`));
    }
    const seen = new Set<string>();
    for (const word of words) {
      if (seen.has(word)) {
        return failed(err('BAD_ARGUMENT', `The word "${word}" is given twice.`,
          'it would be reported twice at every position it occurs, which is never what was meant'));
      }
      seen.add(word);
    }

    this.reset();
    this.#words = [...words];
    this.#states.set(ROOT, {
      id: ROOT, letter: '', depth: 0, parent: null,
      next: new Map(), fail: null, output: null, ends: [], matches: 0,
    });
    this.#next = 1;

    const events: SimEvent[] = [];
    events.push({
      kind: 'NodeAllocated',
      node: ROOT,
      value: 0,
      label: '·',
      role: 'root',
      depth: 0,
      slot: 'root',
      origin: 0,
    });

    /*
     * The words are read one letter at a time and the trie is drawn as it
     * grows.
     *
     * This used to shape the whole trie first and draw it afterwards, because
     * whether a state ends a word is part of what the state *is* - the picture
     * colours those differently - and it is not known until a word has been
     * read to its last letter. Allocating first and marking afterwards meant a
     * node was drawn as one thing and quietly became another, which the event
     * log had no way to say and conformance was right to reject. It can say it
     * now, so the trie is built in the open and a state is told to count as the
     * end of a word at the moment it becomes one.
     */
    for (const word of words) {
      let cur = ROOT;
      for (const letter of word) {
        const existing = this.#states.get(cur)?.next.get(letter);
        if (existing !== undefined) { cur = existing; continue; }
        const id = this.#next as NodeId;
        this.#next += 1;
        const depth = this.#get(cur).depth + 1;
        this.#states.set(id, {
          id, letter, depth, parent: cur,
          next: new Map(), fail: null, output: null, ends: [], matches: 0,
        });
        events.push({
          kind: 'NodeAllocated',
          node: id,
          // Depth is the length of the string this state stands for, which is
          // the number worth reading off it.
          value: depth,
          label: letter,
          role: 'inner',
          depth,
          slot: `c${letter}`,
          origin: 0,
        });
        this.#get(cur).next.set(letter, id);
        events.push({
          kind: 'PointerSet', from: cur, slot: `c${letter}`, to: id, pointer: 'child',
        });
        cur = id;
      }
      this.#get(cur).ends.push(word);
      // Two distinct words cannot end at the same state, so this happens at
      // most once per state and there are never more of these than words.
      events.push({ kind: 'NodeUpdated', node: cur, role: this.#roleOf(this.#get(cur)) });
    }

    this.#linkUp(events);
    this.#built = true;
    events.push({ kind: 'RootsSet', roots: [ROOT] });

    return {
      ok: true,
      value: {
        words: words.length,
        states: this.#states.size,
        letters: total,
        // Where the trie shared work: a state per letter would be the total.
        shared: total - (this.#states.size - 1),
        deepest: Math.max(...[...this.#states.values()].map((s) => s.depth)),
      },
      events,
      statsDelta: { nodesAllocated: this.#states.size, updates: 1 },
    };
  }

  /* ── Walking ─────────────────────────────────────────────────────── */

  /**
   * One step of the automaton: take `letter` from `from`, following failure
   * links until it is possible or the root is reached.
   *
   * The falling back is what makes the whole pass linear rather than
   * quadratic. Each fall shortens the current string by at least one and the
   * string only ever grew by one per letter of text, so across the text there
   * can be no more falls than letters.
   */
  #step(from: NodeId, letter: string, events: SimEvent[]): { to: NodeId; falls: number } {
    let cur: NodeId | null = from;
    let falls = 0;
    for (;;) {
      const state = this.#get(cur as NodeId);
      const onward = state.next.get(letter);
      if (onward !== undefined) {
        events.push({ kind: 'NodeVisited', node: onward });
        return { to: onward, falls };
      }
      if (state.fail === null) {
        // At the root with nowhere to go: this letter appears in no word.
        events.push({ kind: 'NodeVisited', node: ROOT });
        return { to: ROOT, falls };
      }
      falls += 1;
      cur = state.fail;
      events.push({ kind: 'NodeVisited', node: cur });
    }
  }

  #search(text: string): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);
    if (text.length > MAX_LENGTH) {
      return failed(err('BAD_ARGUMENT', `A text of ${text.length} letters is too long.`,
        `the longest is ${MAX_LENGTH}`));
    }

    const events: SimEvent[] = [];
    const found: { at: number; word: string }[] = [];
    let cur = ROOT;
    let falls = 0;

    for (let i = 0; i < text.length; i += 1) {
      const step = this.#step(cur, text[i] as string, events);
      cur = step.to;
      falls += step.falls;

      /*
       * Every word ending at this position is this state's words, then those
       * of the states its output link chain reaches. Following failure links
       * instead would work and would cost one step per letter of the current
       * string, most of them finding nothing.
       */
      for (const word of this.#get(cur).ends) found.push({ at: i - word.length + 1, word });
      let at: NodeId | null = this.#get(cur).output;
      while (at !== null) {
        // Logged, because these are the visits that make listing cost more
        // than walking: one per match reported, which is the `z` in O(n + z).
        events.push({ kind: 'NodeVisited', node: at });
        const state = this.#get(at);
        for (const word of state.ends) found.push({ at: i - word.length + 1, word });
        at = state.output;
      }
    }

    return {
      ok: true,
      value: {
        text,
        count: found.length,
        // Sorted by position so the answer does not depend on the trie's shape.
        occurrences: found
          .slice()
          .sort((p, q) => p.at - q.at || p.word.localeCompare(q.word))
          .map((m) => `${m.word}@${m.at}`),
        words: this.#words.filter((w) => found.some((m) => m.word === w)).length,
        of: this.#words.length,
        falls,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: events.length },
    };
  }

  #count(text: string): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);
    if (text.length > MAX_LENGTH) {
      return failed(err('BAD_ARGUMENT', `A text of ${text.length} letters is too long.`,
        `the longest is ${MAX_LENGTH}`));
    }

    const events: SimEvent[] = [];
    let cur = ROOT;
    let total = 0;

    for (let i = 0; i < text.length; i += 1) {
      cur = this.#step(cur, text[i] as string, events).to;
      // One read per letter, whatever the words are and however many of them
      // end here. That is what the precomputed count is for.
      total += this.#get(cur).matches;
    }

    return {
      ok: true,
      value: {
        text,
        count: total,
        // The whole point: the reading is the same length as the text.
        reads: text.length,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: events.length },
    };
  }

  #links(): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);

    const rows = [...this.#states.values()]
      .filter((s) => s.parent !== null)
      .sort((a, b) => a.depth - b.depth || a.id - b.id)
      .map((s) => ({
        state: this.#stringOf(s.id),
        resumesAt: this.#stringOf(s.fail as NodeId),
        ends: s.ends.length > 0,
        matchesHere: s.matches,
      }));

    return {
      ok: true,
      value: {
        states: this.#states.size,
        rows,
        // A word that is a suffix of another is the case the output links exist
        // for, and is worth pointing at when it happens.
        withOutput: [...this.#states.values()].filter((s) => s.output !== null).length,
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
        label: s.parent === null ? '·' : s.letter,
        value: s.depth,
        role: this.#roleOf(s),
        depth: s.depth,
        slot: s.parent === null ? 'root' : `c${s.letter}`,
        origin: 0,
      });
      for (const [letter, child] of s.next) {
        edges.push({
          from: s.id, to: child, slot: `c${letter}`, reused: false, kind: 'child',
        });
      }
      if (s.fail !== null) {
        edges.push({
          from: s.id, to: s.fail, slot: 'fail',
          reused: false, kind: 'link', directed: true, weight: this.#get(s.fail).depth,
        });
      }
      if (s.output !== null) {
        edges.push({
          from: s.id, to: s.output, slot: 'out',
          reused: false, kind: 'link', directed: true, weight: this.#get(s.output).depth,
        });
      }
    }

    return {
      layout: 'dag', nodes, edges, roots: this.#states.size === 0 ? [] : [ROOT],
    };
  }

  serialize(): SerializedState {
    return {
      schemaVersion: SCHEMA_VERSION,
      pluginId: 'aho-corasick',
      data: { words: [...this.#words] },
    };
  }
}

export const ahoCorasick: AlgorithmPlugin = {
  meta: {
    id: 'aho-corasick',
    name: 'Aho-Corasick',
    category: 'Strings',
    summary: 'A trie of many words with failure links, so one pass over a text finds every '
      + 'occurrence of all of them.',
  },
  commands: COMMANDS,
  explain: explainAhoCorasick,
  benchmark: {
    sizes: [16, 32, 64, 128, 256, 512],
    command: 'count',
    /**
     * Words that overlap each other heavily, so the failure links are long
     * chains rather than all pointing at the root - which is the case where a
     * naive automaton would fall back repeatedly and this one must not.
     */
    setup: (): readonly string[] => ['build [aab aabaa aabab ab abab b ba]'],
    /**
     * A text over the same two letters, so the walk is always deep inside the
     * trie and every letter has somewhere to fall back to.
     *
     * `count` rather than `search` on purpose: this text contains a number of
     * occurrences proportional to its length, so measuring `search` would be
     * measuring the size of the answer as much as the cost of finding it. The
     * claim being measured here is that walking the automaton costs one step
     * per letter no matter what the words are.
     */
    probes: (n: number): readonly string[] => {
      let text = '';
      for (let i = 0; i < n; i += 1) text += i % 3 === 2 ? 'b' : 'a';
      return [`count ${text}`];
    },
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
