/**
 * Rabin-Karp.
 *
 * KMP and the Z algorithm are both exact: they compare letters, and when they
 * report a match there is a match. This one is different in kind. It compares
 * *numbers* - a hash of the pattern against a hash of each window of the text -
 * and a hash comparison can be wrong.
 *
 * That is not a flaw to hide. It is the whole idea, and it buys two things
 * neither exact matcher has. A window's hash is computed from the previous
 * one's in constant time, whatever the pattern's length, by removing the
 * letter that left and adding the letter that arrived. And because the
 * comparison is a single number, the same pass can look for many patterns at
 * once by holding their hashes in a set.
 *
 * The price is that every hash hit has to be **verified** letter by letter. A
 * hit that survives is an occurrence; one that does not is a *spurious hit*,
 * and the number of them is the difference between this being linear and being
 * quadratic. The modulus is what controls that, so it is a command here rather
 * than a constant - setting it small enough to force collisions is the clearest
 * way to see what verification is protecting against.
 */

import {
  getInt, getWord,
  type CommandSpec, type NodeId, type OperationError, type ParsedCommand, type SimEvent,
} from '@algoverse/core';
import {
  failed,
  type AlgorithmPlugin, type EngineContext, type OperationResult,
  type PluginInstance, type SerializedState,
  type StructureEdge, type StructureGraph, type StructureNode,
} from '@algoverse/plugin-sdk';
import { explainRabinKarp } from './explain.ts';

const SCHEMA_VERSION = 1;

const MAX_LENGTH = 4096;

/**
 * One more than the alphabet, so that no letter maps to zero. A letter worth
 * zero would make "a" and "aa" hash alike, since leading zeros add nothing.
 */
const BASE = 27;

/**
 * Large enough that BASE * MODULUS still fits exactly in a double, so no
 * multiplication in the roll can silently lose precision. 2^53 / 27 is about
 * 3.3e14, and this prime is comfortably under it.
 */
const DEFAULT_MODULUS = 1_000_000_007;

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Hash a pattern, one letter at a time.',
    complexity: 'O(n)',
    params: [{ name: 'pattern', kind: 'word' }],
  },
  {
    name: 'search',
    summary: 'Roll a window over a text, verifying every hash hit.',
    complexity: 'O(n + m)',
    params: [{ name: 'text', kind: 'word' }],
  },
  {
    name: 'hashes',
    summary: 'The hash of every window of a text, each rolled from the one before it.',
    complexity: 'O(n)',
    params: [{ name: 'text', kind: 'word' }],
  },
  {
    name: 'modulus',
    summary: 'Set the modulus. A small one forces collisions, which is worth seeing.',
    complexity: 'O(1)',
    params: [{ name: 'value', kind: 'int' }],
  },
];

function err(code: OperationError['code'], message: string, hint?: string): OperationError {
  return { code, message, ...(hint === undefined ? {} : { hint }) };
}

/** 1..26, never 0. */
const codeOf = (letter: string): number => letter.charCodeAt(0) - 96;

class Instance implements PluginInstance {
  #pattern = '';
  #modulus = DEFAULT_MODULUS;
  /** `#prefix[i]` is the hash of `pattern[0..i]`, kept for the picture. */
  #prefix: number[] = [];

  reset(): void {
    this.#pattern = '';
    this.#prefix = [];
    // The modulus survives a reset on purpose: it is a setting, not data. A
    // build after `modulus 7` should still be working modulo 7.
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getWord(cmd, 'pattern'));
      case 'search': return this.#search(getWord(cmd, 'text'));
      case 'hashes': return this.#hashes(getWord(cmd, 'text'));
      case 'modulus': return this.#setModulus(getInt(cmd, 'value'));
      default:
        return failed(err('PARSE_ERROR', `This plugin does not handle "${cmd.name}".`));
    }
  }

  #ready(): OperationError | null {
    return this.#pattern.length === 0
      ? err('PRECONDITION_FAILED', 'No pattern has been built yet.',
        'start with build, as in: build abc')
      : null;
  }

  /* ── The hash ────────────────────────────────────────────────────── */

  /** Horner, left to right: each letter shifts everything before it up. */
  #hashOf(s: string): number {
    let h = 0;
    for (const letter of s) h = (h * BASE + codeOf(letter)) % this.#modulus;
    return h;
  }

  /** BASE^(m-1), the weight of the letter about to leave the window. */
  #topWeight(m: number): number {
    let w = 1;
    for (let i = 1; i < m; i += 1) w = (w * BASE) % this.#modulus;
    return w;
  }

  /**
   * Remove the letter that left, shift up, add the letter that arrived.
   *
   * The subtraction is done before the multiplication and brought back into
   * range with an addition, because a negative intermediate would make the
   * remainder negative in this language and the hash would stop matching.
   */
  #roll(previous: number, leaving: string, arriving: string, top: number): number {
    const withoutLeading = (previous - ((codeOf(leaving) * top) % this.#modulus) + this.#modulus)
      % this.#modulus;
    return (withoutLeading * BASE + codeOf(arriving)) % this.#modulus;
  }

  /* ── The picture ─────────────────────────────────────────────────── */

  /**
   * Every letter with the running hash it produced, linked in reading order.
   *
   * Emitted by a build, which genuinely brings the nodes into being. A change
   * of modulus does not: it changes every number and nothing else, and there is
   * an event for that - see `#revalue`. This used to be emitted for both, which
   * meant re-allocating nodes that had not moved and re-stating every pointer
   * between them.
   */
  #picture(): SimEvent[] {
    const m = this.#pattern.length;
    const events: SimEvent[] = [];
    for (let i = 0; i < m; i += 1) {
      events.push({
        kind: 'NodeAllocated',
        node: i as NodeId,
        // The running hash is the number worth reading off a position; the
        // letter is what produced it.
        value: this.#prefix[i] as number,
        label: this.#pattern[i] as string,
        role: 'letter',
        // A linear layout grows upward from zero, so the first letter is given
        // the largest depth to put it at the top.
        depth: m - 1 - i,
        slot: `p${i}`,
        origin: 0,
        order: i,
      });
    }
    for (let i = 1; i < m; i += 1) {
      events.push({
        kind: 'PointerSet',
        from: (i - 1) as NodeId,
        slot: 'next',
        to: i as NodeId,
        pointer: 'link',
        directed: true,
        // Each step multiplies everything so far by the base. Drawing that on
        // the edge is what makes the running hashes readable as a sequence
        // rather than as unrelated numbers.
        weight: BASE,
      });
    }
    if (m > 0) events.push({ kind: 'RootsSet', roots: [0 as NodeId] });
    return events;
  }

  /**
   * The same letters in the same places, holding different numbers.
   *
   * A new modulus changes every running hash and nothing else - not which
   * letter is where, not the reading order, not what points at what. Saying
   * only that is both smaller and truer than drawing the whole thing again:
   * a redraw would have the log claim the nodes were made afresh, which is a
   * different thing from their contents changing.
   */
  #revalue(): SimEvent[] {
    return this.#pattern.split('').map((_, i): SimEvent => ({
      kind: 'NodeUpdated',
      node: i as NodeId,
      value: this.#prefix[i] as number,
    }));
  }

  /* ── Commands ────────────────────────────────────────────────────── */

  #setModulus(value: number): OperationResult {
    if (value < 1) {
      return failed(err('BAD_ARGUMENT', `A modulus of ${value} is not usable.`,
        'it has to be at least 1; try 1 to make every hash collide, or a large prime to make '
        + 'collisions vanishingly unlikely'));
    }
    const ceiling = Math.floor(Number.MAX_SAFE_INTEGER / BASE);
    if (value > ceiling) {
      return failed(err('BAD_ARGUMENT', `A modulus of ${value} is too large to be exact.`,
        `the roll multiplies by ${BASE}, so anything above ${ceiling} would lose precision and `
        + 'the hash would disagree with itself'));
    }

    this.#modulus = value;
    // Rehash whatever is already built, so the setting and the state cannot
    // drift apart. Without this, `search` after `modulus` would compare a
    // pattern hash taken under the old one against windows taken under the new.
    for (let i = 0; i < this.#pattern.length; i += 1) {
      this.#prefix[i] = this.#hashOf(this.#pattern.slice(0, i + 1));
    }
    const events = this.#revalue();

    return {
      ok: true,
      value: {
        modulus: value,
        pattern: this.#pattern,
        hash: this.#pattern.length === 0 ? null : this.#prefix[this.#pattern.length - 1],
        // What the birthday problem says to expect: a window collides with the
        // pattern about once every `modulus` windows, whatever the letters are.
        spuriousPerWindow: Math.round((1 / value) * 1e6) / 1e6,
      },
      events,
      // Nothing new was allocated: the same nodes are holding different
      // numbers, which is an update and should be counted as one.
      statsDelta: { updates: 1 },
    };
  }

  #build(pattern: string): OperationResult {
    if (pattern.length === 0) {
      return failed(err('BAD_ARGUMENT', 'An empty pattern has nothing to hash.',
        'give at least one letter'));
    }
    if (pattern.length > MAX_LENGTH) {
      return failed(err('BAD_ARGUMENT', `A pattern of ${pattern.length} letters is too long.`,
        `the longest is ${MAX_LENGTH}`));
    }

    this.reset();
    this.#pattern = pattern;

    const m = pattern.length;
    let h = 0;
    for (let i = 0; i < m; i += 1) {
      h = (h * BASE + codeOf(pattern[i] as string)) % this.#modulus;
      this.#prefix[i] = h;
    }

    return {
      ok: true,
      value: {
        pattern,
        length: m,
        hash: h,
        modulus: this.#modulus,
        runningHashes: [...this.#prefix],
      },
      events: this.#picture(),
      statsDelta: { nodesAllocated: m, updates: 1 },
    };
  }

  #search(text: string): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);
    if (text.length > MAX_LENGTH) {
      return failed(err('BAD_ARGUMENT', `A text of ${text.length} letters is too long.`,
        `the longest is ${MAX_LENGTH}`));
    }

    const m = this.#pattern.length;
    const target = this.#prefix[m - 1] as number;
    const events: SimEvent[] = [];
    const found: number[] = [];
    let windows = 0;
    let hits = 0;
    let spurious = 0;
    let comparisons = 0;

    if (m <= text.length) {
      const top = this.#topWeight(m);
      let window = this.#hashOf(text.slice(0, m));

      for (let start = 0; ; start += 1) {
        windows += 1;
        if (window === target) {
          hits += 1;
          /*
           * The hash said yes; the letters have the final word. This is the
           * only place the pattern is read during a search, which is why the
           * events land on the pattern's own nodes.
           */
          let same = true;
          for (let k = 0; k < m; k += 1) {
            comparisons += 1;
            events.push({ kind: 'NodeVisited', node: k as NodeId });
            if (text[start + k] !== this.#pattern[k]) { same = false; break; }
          }
          if (same) found.push(start);
          else spurious += 1;
        }
        if (start + m >= text.length) break;
        window = this.#roll(
          window, text[start] as string, text[start + m] as string, top,
        );
      }
    }

    return {
      ok: true,
      value: {
        text,
        pattern: this.#pattern,
        modulus: this.#modulus,
        count: found.length,
        positions: found,
        windows,
        // Hits, of which the spurious ones are the cost of hashing at all.
        hits,
        spurious,
        comparisons,
        /*
         * The number that decides whether this was linear. One comparison per
         * window means the hash did all the work; m per window means it did
         * none, and the search degenerated into the naive scan it replaces.
         */
        comparisonsPerWindow: windows === 0 ? 0 : Math.round((comparisons / windows) * 100) / 100,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: events.length },
    };
  }

  #hashes(text: string): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);
    if (text.length > MAX_LENGTH) {
      return failed(err('BAD_ARGUMENT', `A text of ${text.length} letters is too long.`,
        `the longest is ${MAX_LENGTH}`));
    }

    const m = this.#pattern.length;
    const rows: { start: number; window: string; hash: number; matchesPattern: boolean }[] = [];

    if (m <= text.length) {
      const top = this.#topWeight(m);
      let window = this.#hashOf(text.slice(0, m));
      for (let start = 0; ; start += 1) {
        rows.push({
          start,
          window: text.slice(start, start + m),
          hash: window,
          matchesPattern: window === (this.#prefix[m - 1] as number),
        });
        if (start + m >= text.length) break;
        window = this.#roll(window, text[start] as string, text[start + m] as string, top);
      }
    }

    /*
     * Distinct hashes against distinct windows: the gap between them is
     * exactly how many collisions this modulus produced on this text, which is
     * the thing a modulus is chosen to keep at zero.
     */
    const distinctHashes = new Set(rows.map((r) => r.hash)).size;
    const distinctWindows = new Set(rows.map((r) => r.window)).size;

    return {
      ok: true,
      value: {
        text,
        width: m,
        modulus: this.#modulus,
        rows,
        distinctHashes,
        distinctWindows,
        collisions: distinctWindows - distinctHashes,
      },
      events: this.#prefix.map((_, i): SimEvent => ({ kind: 'NodeVisited', node: i as NodeId })),
      statsDelta: { queries: 1, nodeVisits: this.#prefix.length },
    };
  }

  /* ── Views ───────────────────────────────────────────────────────── */

  getStructure(): StructureGraph {
    const m = this.#pattern.length;
    const nodes: StructureNode[] = [];
    const edges: StructureEdge[] = [];

    for (let i = 0; i < m; i += 1) {
      nodes.push({
        id: i as NodeId,
        label: this.#pattern[i] as string,
        value: this.#prefix[i] as number,
        role: 'letter',
        depth: m - 1 - i,
        slot: `p${i}`,
        origin: 0,
        order: i,
      });
      if (i > 0) {
        edges.push({
          from: (i - 1) as NodeId,
          to: i as NodeId,
          slot: 'next',
          reused: false,
          kind: 'link',
          directed: true,
          weight: BASE,
        });
      }
    }

    return { layout: 'linear', nodes, edges, roots: m === 0 ? [] : [0 as NodeId] };
  }

  serialize(): SerializedState {
    return {
      schemaVersion: SCHEMA_VERSION,
      pluginId: 'rabin-karp',
      data: { pattern: this.#pattern, modulus: this.#modulus },
    };
  }
}

export const rabinKarp: AlgorithmPlugin = {
  meta: {
    id: 'rabin-karp',
    name: 'Rabin-Karp',
    category: 'Strings',
    summary: 'Compare hashes instead of letters, roll each window from the last, and verify '
      + 'every hit.',
  },
  commands: COMMANDS,
  explain: explainRabinKarp,
  benchmark: {
    sizes: [8, 16, 32, 64, 128, 256],
    command: 'search',
    /**
     * A pattern that occurs at every other position, so the verification work
     * grows with the text.
     *
     * The obvious choice - KMP's adversarial `aaab` over a run of `a` - cannot
     * be used here, and the reason is worth stating. Cost is counted in nodes
     * touched, and with a large modulus no window ever collides with the
     * pattern, so that search touches the pattern **zero** times at every
     * size. That is the whole advantage over KMP, which touches it once per
     * letter, and a check next door asserts exactly that - but a flat zero is
     * not a growth curve, and using it as the benchmark would be measuring
     * nothing and calling the result linear.
     *
     * What the log can see is verification, and here there is a real
     * occurrence to verify every second window: `2 * (n / 2) = n` comparisons.
     */
    setup: (): readonly string[] => ['build ab'],
    probes: (n: number): readonly string[] => [`search ${'ab'.repeat(n / 2)}`],
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
