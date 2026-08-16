/**
 * Suffix array, with the LCP array beside it.
 *
 * Every suffix of a string, sorted. That is the whole structure - an array of
 * n starting positions - and it is the first thing here that is not a tree or
 * a graph. What makes it worth building is that sorting the suffixes puts
 * every occurrence of any pattern into one contiguous block, because the
 * suffixes beginning with that pattern are exactly the ones that sort
 * together. Searching becomes a binary search, and it does not care how many
 * matches there are.
 *
 * ## Building it by doubling
 *
 * Sorting n suffixes by comparing them costs O(n) per comparison, which makes
 * the obvious method O(n² log n). The way out is to never compare two suffixes
 * directly. Sort them by their first character; that gives every suffix a
 * rank. Now the first *two* characters of suffix i are the pair of ranks
 * (rank[i], rank[i+1]) - two numbers, compared in constant time. Sorting on
 * that pair gives new ranks, which describe the first two characters, and the
 * same trick with (rank[i], rank[i+2]) then covers four.
 *
 * Each round doubles how much of each suffix the ranks account for, so log n
 * rounds settle it, and no comparison ever looks at more than two numbers.
 *
 * ## The LCP array
 *
 * How much of a prefix each suffix shares with the one before it in sorted
 * order. It is computed by Kasai's method, which is the surprising part: it
 * walks the suffixes in *string* order rather than sorted order, and relies on
 * the fact that dropping the first character of a suffix can only shorten its
 * shared prefix by one. That keeps the total work linear.
 *
 * Here the LCP sits on the edges between neighbours rather than in a list of
 * its own, because that is what it is - a measurement between two suffixes,
 * not a property of either.
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
import { explainSuffixArray } from './explain.ts';

const SCHEMA_VERSION = 1;

/** Long enough to be interesting, short enough to draw. */
const MAX_LENGTH = 4096;

/** How much of a suffix is shown on its node before it is cut short. */
const LABEL_WIDTH = 12;

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Sort every suffix of a word, by doubling how much of each one is ranked.',
    complexity: 'O(n log² n)',
    params: [{ name: 'text', kind: 'word' }],
  },
  {
    name: 'find',
    summary: 'Locate every occurrence of a pattern, as one block of the sorted order.',
    complexity: 'O(log n)',
    params: [{ name: 'pattern', kind: 'word' }],
  },
  {
    name: 'lrs',
    summary: 'The longest substring that appears more than once.',
    complexity: 'O(n)',
    params: [],
  },
  {
    name: 'suffixes',
    summary: 'Read the sorted suffixes out, with what each shares with the one before.',
    complexity: 'O(n)',
    params: [],
  },
];

function err(code: OperationError['code'], message: string, hint?: string): OperationError {
  return { code, message, ...(hint === undefined ? {} : { hint }) };
}

class Instance implements PluginInstance {
  #text = '';
  /** `#order[r]` is where the r-th smallest suffix starts. */
  #order: number[] = [];
  /** `#shared[r]` is how much the r-th suffix shares with the one before it. */
  #shared: number[] = [];
  #rounds = 0;

  reset(): void {
    this.#text = '';
    this.#order = [];
    this.#shared = [];
    this.#rounds = 0;
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getWord(cmd, 'text'));
      case 'find': return this.#find(getWord(cmd, 'pattern'));
      case 'lrs': return this.#lrs();
      case 'suffixes': return this.#suffixes();
      default:
        return failed(err('PARSE_ERROR', `This plugin does not handle "${cmd.name}".`));
    }
  }

  /* ── Helpers ─────────────────────────────────────────────────────── */

  #ready(): OperationError | null {
    return this.#text.length === 0
      ? err('PRECONDITION_FAILED', 'Nothing has been built yet.', 'start with build, as in: build banana')
      : null;
  }

  #suffixAt(rank: number): string {
    return this.#text.slice(this.#order[rank] as number);
  }

  #short(suffix: string): string {
    return suffix.length <= LABEL_WIDTH ? suffix : `${suffix.slice(0, LABEL_WIDTH)}…`;
  }

  /* ── Construction ────────────────────────────────────────────────── */

  /**
   * Prefix doubling.
   *
   * `rank` always describes the first `k` characters of each suffix. Pairing a
   * suffix's rank with the rank of the suffix `k` further along describes the
   * first `2k`, and sorting on that pair produces the next round's ranks. A
   * suffix that runs off the end pairs with -1, which sorts before everything
   * - the right answer, because a shorter suffix that is otherwise equal comes
   * first.
   */
  #sort(): number {
    const n = this.#text.length;
    const order = Array.from({ length: n }, (_, i) => i);
    let rank = [...this.#text].map((ch) => ch.charCodeAt(0));
    let rounds = 0;

    for (let k = 1; k < n; k *= 2) {
      const second = (i: number): number => (i + k < n ? (rank[i + k] as number) : -1);
      order.sort((a, b) =>
        (rank[a] as number) - (rank[b] as number) || second(a) - second(b));

      // Re-rank: equal pairs keep equal ranks, so ties survive into the next
      // round and are broken by the wider window rather than by chance.
      const next = new Array<number>(n).fill(0);
      for (let i = 1; i < n; i += 1) {
        const prev = order[i - 1] as number;
        const cur = order[i] as number;
        const same = rank[prev] === rank[cur] && second(prev) === second(cur);
        next[cur] = (next[prev] as number) + (same ? 0 : 1);
      }
      rank = next;
      rounds += 1;

      // Every suffix has its own rank, so nothing wider can change the order.
      if ((rank[order[n - 1] as number] as number) === n - 1) break;
    }

    this.#order = order;
    return rounds;
  }

  /**
   * Kasai's method for the shared prefixes.
   *
   * Walks the suffixes in the order they appear in the string, not in sorted
   * order. Dropping the first character of a suffix shortens what it shares
   * with its neighbour by at most one, so the running length only ever falls
   * by one per step and the whole pass is linear.
   */
  #measure(): void {
    const n = this.#text.length;
    const where = new Array<number>(n).fill(0);
    for (let r = 0; r < n; r += 1) where[this.#order[r] as number] = r;

    const shared = new Array<number>(n).fill(0);
    let run = 0;
    for (let i = 0; i < n; i += 1) {
      const r = where[i] as number;
      if (r === 0) { run = 0; continue; }
      const previous = this.#order[r - 1] as number;
      while (i + run < n && previous + run < n
        && this.#text[i + run] === this.#text[previous + run]) run += 1;
      shared[r] = run;
      if (run > 0) run -= 1;
    }
    this.#shared = shared;
  }

  /* ── Commands ────────────────────────────────────────────────────── */

  #build(text: string): OperationResult {
    if (text.length > MAX_LENGTH) {
      return failed(err('BAD_ARGUMENT', `A word of ${text.length} letters is longer than this holds.`,
        `the longest is ${MAX_LENGTH}`));
    }

    this.reset();
    this.#text = text;
    this.#rounds = this.#sort();
    this.#measure();

    const events: SimEvent[] = [];
    const n = text.length;
    for (let r = 0; r < n; r += 1) {
      events.push({
        kind: 'NodeAllocated',
        node: r as NodeId,
        // The position it starts at, which is all the array actually stores.
        value: this.#order[r] as number,
        label: this.#short(this.#suffixAt(r)),
        role: 'suffix',
        // A linear layout stacks by depth and grows upward from zero, so the
        // smallest suffix is given the largest depth to put it at the top.
        // Saying 0 for all of them piles every suffix on one spot, which then
        // drops every edge between them for having no length.
        depth: n - 1 - r,
        slot: `r${r}`,
        origin: 0,
        // Sorted order is the structure, so it has to be in the log.
        order: r,
      });
    }
    for (let r = 1; r < n; r += 1) {
      events.push({
        kind: 'PointerSet',
        from: (r - 1) as NodeId,
        slot: 'next',
        to: r as NodeId,
        pointer: 'link',
        // The shared prefix belongs between two suffixes, not to either.
        weight: this.#shared[r] as number,
      });
    }
    events.push({ kind: 'RootsSet', roots: n === 0 ? [] : [0 as NodeId] });

    return {
      ok: true,
      value: {
        text, length: n,
        // log2(n) rounds at most, whatever the letters are.
        rounds: this.#rounds,
        distinctSubstrings: this.#distinct(),
      },
      events,
      statsDelta: { nodesAllocated: n, updates: 1 },
    };
  }

  /**
   * How many different substrings the word has.
   *
   * Every substring is a prefix of exactly one suffix, so the total is the sum
   * of each suffix's length minus what it repeats from its neighbour - which
   * is what the shared prefixes already say.
   */
  #distinct(): number {
    const n = this.#text.length;
    let total = 0;
    for (let r = 0; r < n; r += 1) {
      total += n - (this.#order[r] as number) - (this.#shared[r] as number);
    }
    return total;
  }

  #find(pattern: string): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);

    const events: SimEvent[] = [];
    const n = this.#order.length;
    const seen = new Set<number>();
    const probe = (rank: number): string => {
      if (!seen.has(rank)) {
        seen.add(rank);
        events.push({ kind: 'NodeVisited', node: rank as NodeId });
      }
      return this.#suffixAt(rank).slice(0, pattern.length);
    };

    /*
     * Two binary searches: the first rank whose suffix starts at or after the
     * pattern, and the first that starts after it. Everything between them
     * begins with the pattern, which is the property sorting bought.
     */
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (probe(mid) < pattern) lo = mid + 1; else hi = mid;
    }
    const first = lo;

    hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (probe(mid) === pattern) lo = mid + 1; else hi = mid;
    }
    const after = lo;

    const positions = this.#order.slice(first, after).slice().sort((a, b) => a - b);
    return {
      ok: true,
      value: {
        pattern,
        found: after > first,
        count: after - first,
        // One block of the sorted order, however many occurrences there are.
        ranks: after > first ? `${first}..${after - 1}` : null,
        positions,
        probes: seen.size,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: seen.size },
    };
  }

  #lrs(): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);

    const events: SimEvent[] = [];
    let best = 0;
    let at = 0;
    for (let r = 0; r < this.#shared.length; r += 1) {
      events.push({ kind: 'NodeVisited', node: r as NodeId });
      const here = this.#shared[r] as number;
      if (here > best) { best = here; at = r; }
    }

    /*
     * The longest repeat has to be a prefix of two suffixes that are next to
     * each other in sorted order - anything the two share, everything between
     * them shares too. So the answer is the largest entry of the LCP array,
     * and one pass over it finds it.
     */
    const text = best === 0 ? null : this.#suffixAt(at).slice(0, best);
    const where = best === 0 ? [] : [this.#order[at] as number, this.#order[at - 1] as number]
      .sort((a, b) => a - b);

    return {
      ok: true,
      value: { length: best, text, at: where, scanned: this.#shared.length },
      events,
      statsDelta: { queries: 1, nodeVisits: this.#shared.length },
    };
  }

  #suffixes(): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);

    const rows = this.#order.map((start, r) => ({
      rank: r,
      start,
      shares: this.#shared[r] as number,
      suffix: this.#short(this.#suffixAt(r)),
    }));

    return {
      ok: true,
      value: { order: [...this.#order], shared: [...this.#shared], rows },
      events: this.#order.map((_, r): SimEvent => ({ kind: 'NodeVisited', node: r as NodeId })),
      statsDelta: { queries: 1, nodeVisits: this.#order.length },
    };
  }

  /* ── Views ───────────────────────────────────────────────────────── */

  getStructure(): StructureGraph {
    const nodes: StructureNode[] = [];
    const edges: StructureEdge[] = [];

    for (let r = 0; r < this.#order.length; r += 1) {
      nodes.push({
        id: r as NodeId,
        label: this.#short(this.#suffixAt(r)),
        value: this.#order[r] as number,
        role: 'suffix',
        // A linear layout stacks by depth and grows upward from zero, so the
        // smallest suffix is given the largest depth to put it at the top.
        // Saying 0 for all of them piles every suffix on one spot, which then
        // drops every edge between them for having no length.
        depth: this.#order.length - 1 - r,
        slot: `r${r}`,
        origin: 0,
        order: r,
      });
      if (r > 0) {
        edges.push({
          from: (r - 1) as NodeId,
          to: r as NodeId,
          slot: 'next',
          reused: false,
          kind: 'link',
          weight: this.#shared[r] as number,
        });
      }
    }

    return {
      layout: 'linear',
      nodes,
      edges,
      roots: this.#order.length === 0 ? [] : [0 as NodeId],
    };
  }

  serialize(): SerializedState {
    return {
      schemaVersion: SCHEMA_VERSION,
      pluginId: 'suffix-array',
      data: { text: this.#text },
    };
  }
}

export const suffixArray: AlgorithmPlugin = {
  meta: {
    id: 'suffix-array',
    name: 'Suffix Array',
    category: 'Strings',
    summary: 'Every suffix in sorted order, so any pattern is one contiguous block.',
  },
  commands: COMMANDS,
  explain: explainSuffixArray,
  benchmark: {
    sizes: [8, 16, 32, 64, 128, 256],
    command: 'lrs',
    /**
     * A word with plenty of repetition, so the longest repeat is a real answer
     * rather than a single letter. The scan is over every suffix either way -
     * that is what is being measured.
     */
    setup: (n: number): readonly string[] => {
      const alphabet = 'abcd';
      let word = '';
      for (let i = 0; i < n; i += 1) word += alphabet[(i * i + i) % alphabet.length];
      return [`build ${word}`];
    },
    probes: (): readonly string[] => ['lrs'],
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
