/**
 * Knuth-Morris-Pratt.
 *
 * The suffix array sorts a text so any pattern can be found by bisection. This
 * takes the opposite approach: it preprocesses the *pattern* instead, and then
 * reads the text once, never going back.
 *
 * The thing it precomputes is the **border** of every prefix of the pattern -
 * the longest piece that is both a proper prefix and a suffix of it. Borders
 * are what make backtracking unnecessary. If the first i characters have
 * matched and the next one does not, everything already read still matches the
 * pattern's border, so the next attempt can start from there rather than from
 * the beginning. Nothing in the text is ever looked at twice.
 *
 * A border is also why the failure links form a structure worth drawing: from
 * each position, one link back to where a mismatch would resume. Following
 * those links from any position enumerates every border of that prefix, each
 * shorter than the last, which is exactly what the inner loop does.
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
import { explainKmp } from './explain.ts';

const SCHEMA_VERSION = 1;

const MAX_LENGTH = 4096;

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Work out the border of every prefix of a pattern.',
    complexity: 'O(n)',
    params: [{ name: 'pattern', kind: 'word' }],
  },
  {
    name: 'search',
    summary: 'Read a text once, reporting every occurrence of the pattern.',
    complexity: 'O(n)',
    params: [{ name: 'text', kind: 'word' }],
  },
  {
    name: 'borders',
    summary: 'The border of each prefix, and the chain of borders from the whole pattern.',
    complexity: 'O(n)',
    params: [],
  },
];

function err(code: OperationError['code'], message: string, hint?: string): OperationError {
  return { code, message, ...(hint === undefined ? {} : { hint }) };
}

class Instance implements PluginInstance {
  #pattern = '';
  /** `#border[i]` is the longest proper border of `pattern[0..i]`. */
  #border: number[] = [];

  reset(): void {
    this.#pattern = '';
    this.#border = [];
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getWord(cmd, 'pattern'));
      case 'search': return this.#search(getWord(cmd, 'text'));
      case 'borders': return this.#borders();
      default:
        return failed(err('PARSE_ERROR', `This plugin does not handle "${cmd.name}".`));
    }
  }

  #ready(): OperationError | null {
    return this.#pattern.length === 0
      ? err('PRECONDITION_FAILED', 'No pattern has been built yet.',
        'start with build, as in: build ababaca')
      : null;
  }

  /* ── The border function ─────────────────────────────────────────── */

  /**
   * One pass, and `k` never rises by more than one per character.
   *
   * `k` is the length of the border being extended. When the next character
   * does not continue it, the search falls back to the border *of that border*
   * - which is what `#border[k - 1]` is - and tries again. That fallback can
   * happen many times for one character, but only ever undoes rises that have
   * already been paid for, so the whole pass is linear rather than quadratic.
   */
  #compute(): void {
    const m = this.#pattern.length;
    const border = new Array<number>(m).fill(0);
    let k = 0;
    for (let i = 1; i < m; i += 1) {
      while (k > 0 && this.#pattern[i] !== this.#pattern[k]) k = border[k - 1] as number;
      if (this.#pattern[i] === this.#pattern[k]) k += 1;
      border[i] = k;
    }
    this.#border = border;
  }

  /* ── Commands ────────────────────────────────────────────────────── */

  #build(pattern: string): OperationResult {
    if (pattern.length > MAX_LENGTH) {
      return failed(err('BAD_ARGUMENT', `A pattern of ${pattern.length} letters is too long.`,
        `the longest is ${MAX_LENGTH}`));
    }

    this.reset();
    this.#pattern = pattern;
    this.#compute();

    const events: SimEvent[] = [];
    const m = pattern.length;
    for (let i = 0; i < m; i += 1) {
      events.push({
        kind: 'NodeAllocated',
        node: i as NodeId,
        // The border length is the number worth reading off; the letter is
        // what it belongs to.
        value: this.#border[i] as number,
        label: pattern[i] as string,
        role: (this.#border[i] as number) > 0 ? 'bordered' : 'plain',
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
        kind: 'PointerSet', from: (i - 1) as NodeId, slot: 'next', to: i as NodeId, pointer: 'link',
      });
    }
    for (let i = 0; i < m; i += 1) {
      const b = this.#border[i] as number;
      if (b === 0) continue;
      events.push({
        kind: 'PointerSet',
        from: i as NodeId,
        slot: 'fail',
        // Where a mismatch after this position resumes: having matched the
        // border, which ends at position b - 1.
        to: (b - 1) as NodeId,
        pointer: 'link',
        directed: true,
        weight: b,
      });
    }
    events.push({ kind: 'RootsSet', roots: m === 0 ? [] : [0 as NodeId] });

    return {
      ok: true,
      value: {
        pattern, length: m,
        borders: [...this.#border],
        longestBorder: Math.max(0, ...this.#border),
      },
      events,
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

    const events: SimEvent[] = [];
    const m = this.#pattern.length;
    const found: number[] = [];
    let k = 0;
    let comparisons = 0;
    let fallbacks = 0;

    for (let i = 0; i < text.length; i += 1) {
      // Each fallback shortens the match by at least one, and the match only
      // ever grew one per character, so the total is bounded by the text.
      while (k > 0 && text[i] !== this.#pattern[k]) {
        comparisons += 1;
        fallbacks += 1;
        events.push({ kind: 'NodeVisited', node: k as NodeId });
        k = this.#border[k - 1] as number;
      }
      comparisons += 1;
      events.push({ kind: 'NodeVisited', node: k as NodeId });
      if (text[i] === this.#pattern[k]) k += 1;

      if (k === m) {
        found.push(i - m + 1);
        // Carry on from the pattern's own border rather than starting over,
        // which is what lets overlapping occurrences be found in one pass.
        k = this.#border[m - 1] as number;
      }
    }

    return {
      ok: true,
      value: {
        text, pattern: this.#pattern,
        count: found.length,
        positions: found,
        comparisons,
        fallbacks,
        // Never more than twice the text, whatever the pattern looks like.
        readsPerLetter: text.length === 0 ? 0 : Math.round((comparisons / text.length) * 100) / 100,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: events.length },
    };
  }

  #borders(): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);

    /*
     * Following the links from the last position lists every border of the
     * whole pattern, longest first. Each is a border of the one before it,
     * which is why one link per position is enough to enumerate them all.
     */
    const chain: number[] = [];
    let k = this.#border[this.#pattern.length - 1] as number;
    while (k > 0) {
      chain.push(k);
      k = this.#border[k - 1] as number;
    }

    return {
      ok: true,
      value: {
        pattern: this.#pattern,
        borders: [...this.#border],
        chain,
        // A pattern whose whole self is a border of itself does not exist, but
        // one where every prefix borders is a single repeated letter.
        periodic: chain.length > 0,
      },
      events: this.#border.map((_, i): SimEvent => ({ kind: 'NodeVisited', node: i as NodeId })),
      statsDelta: { queries: 1, nodeVisits: this.#border.length },
    };
  }

  /* ── Views ───────────────────────────────────────────────────────── */

  getStructure(): StructureGraph {
    const nodes: StructureNode[] = [];
    const edges: StructureEdge[] = [];
    const m = this.#pattern.length;

    for (let i = 0; i < m; i += 1) {
      const b = this.#border[i] as number;
      nodes.push({
        id: i as NodeId,
        label: this.#pattern[i] as string,
        value: b,
        role: b > 0 ? 'bordered' : 'plain',
        depth: m - 1 - i,
        slot: `p${i}`,
        origin: 0,
        order: i,
      });
      if (i > 0) {
        edges.push({
          from: (i - 1) as NodeId, to: i as NodeId, slot: 'next', reused: false, kind: 'link',
        });
      }
      if (b > 0) {
        edges.push({
          from: i as NodeId, to: (b - 1) as NodeId, slot: 'fail',
          reused: false, kind: 'link', directed: true, weight: b,
        });
      }
    }

    return { layout: 'linear', nodes, edges, roots: m === 0 ? [] : [0 as NodeId] };
  }

  serialize(): SerializedState {
    return {
      schemaVersion: SCHEMA_VERSION,
      pluginId: 'kmp',
      data: { pattern: this.#pattern },
    };
  }
}

export const kmp: AlgorithmPlugin = {
  meta: {
    id: 'kmp',
    name: 'Knuth-Morris-Pratt',
    category: 'Strings',
    summary: 'Preprocess the pattern into borders, then read the text once without ever going back.',
  },
  commands: COMMANDS,
  explain: explainKmp,
  benchmark: {
    sizes: [8, 16, 32, 64, 128, 256],
    command: 'search',
    /**
     * A pattern that keeps almost matching, over a text made of the same
     * letters. That is the case a naive search does badly on, and the one the
     * borders exist for - so it is the honest thing to measure.
     */
    setup: (): readonly string[] => ['build aaab'],
    probes: (n: number): readonly string[] => [`search ${'a'.repeat(n)}`],
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
