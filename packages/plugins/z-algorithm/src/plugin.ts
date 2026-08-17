/**
 * Z algorithm.
 *
 * For every position of a string, how much of the string's own beginning starts
 * again there. That array is the same self-similarity KMP's borders describe,
 * written from the other end: a border says "this prefix ends where it begins",
 * a Z value says "the beginning happens again here". Either can be turned into
 * the other, which is a useful thing to be able to check.
 *
 * ## Why it is linear
 *
 * The work is saved by remembering one thing: the match that reached furthest
 * to the right so far, as an interval [l, r). Inside that interval the string
 * is known to repeat its own beginning, so position i looks exactly like
 * position i - l did - and its Z value is already known, up to where the
 * interval ends. Only the part beyond r has to be compared letter by letter,
 * and every such comparison either fails once or pushes r further right. r
 * only ever moves forward, so the total is linear.
 *
 * That interval is the whole algorithm, and it is what the drawing shows: each
 * position carries its Z value, and a position that copied its answer from
 * earlier says where it copied from.
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
import { explainZ } from './explain.ts';

const SCHEMA_VERSION = 1;

const MAX_LENGTH = 4096;

interface Cell {
  /** How much of the string's beginning starts again here. */
  readonly z: number;
  /**
   * The position this answer was copied from, when it was. Null when the
   * comparison had to be made letter by letter.
   */
  readonly copiedFrom: number | null;
}

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'For every position, how much of the beginning starts again there.',
    complexity: 'O(n)',
    params: [{ name: 'text', kind: 'word' }],
  },
  {
    name: 'find',
    summary: 'Every occurrence of a pattern, by running the same pass over pattern then text.',
    complexity: 'O(n)',
    params: [{ name: 'pattern', kind: 'word' }],
  },
  {
    name: 'values',
    summary: 'Read the whole array out, and say which entries were copied.',
    complexity: 'O(n)',
    params: [],
  },
  {
    name: 'borders',
    summary: 'The same information as KMP borders, derived from the Z values.',
    complexity: 'O(n)',
    params: [],
  },
];

function err(code: OperationError['code'], message: string, hint?: string): OperationError {
  return { code, message, ...(hint === undefined ? {} : { hint }) };
}

/**
 * The Z array of a string, and where each entry came from.
 *
 * Kept as a free function because `find` needs it over a string that is not
 * the one that was built - the pattern followed by the text.
 */
function zOf(s: string): Cell[] {
  const n = s.length;
  const cells: Cell[] = new Array<Cell>(n);
  if (n === 0) return cells;
  cells[0] = { z: n, copiedFrom: null };

  let l = 0;
  let r = 0;
  for (let i = 1; i < n; i += 1) {
    let z = 0;
    let copiedFrom: number | null = null;
    if (i < r) {
      // Inside the furthest match: this position looks like i - l did.
      z = Math.min(r - i, cells[i - l]?.z ?? 0);
      copiedFrom = i - l;
    }
    while (i + z < n && s[z] === s[i + z]) z += 1;
    if (i + z > r) { l = i; r = i + z; }
    cells[i] = { z, copiedFrom: z > 0 ? copiedFrom : null };
  }
  return cells;
}

class Instance implements PluginInstance {
  #text = '';
  #cells: Cell[] = [];

  reset(): void {
    this.#text = '';
    this.#cells = [];
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getWord(cmd, 'text'));
      case 'find': return this.#find(getWord(cmd, 'pattern'));
      case 'values': return this.#values();
      case 'borders': return this.#borders();
      default:
        return failed(err('PARSE_ERROR', `This plugin does not handle "${cmd.name}".`));
    }
  }

  #ready(): OperationError | null {
    return this.#text.length === 0
      ? err('PRECONDITION_FAILED', 'Nothing has been built yet.',
        'start with build, as in: build aabxaayaab')
      : null;
  }

  /* ── Commands ────────────────────────────────────────────────────── */

  #build(text: string): OperationResult {
    if (text.length > MAX_LENGTH) {
      return failed(err('BAD_ARGUMENT', `A word of ${text.length} letters is too long.`,
        `the longest is ${MAX_LENGTH}`));
    }

    this.reset();
    this.#text = text;
    this.#cells = zOf(text);

    const events: SimEvent[] = [];
    const n = text.length;
    for (let i = 0; i < n; i += 1) {
      const cell = this.#cells[i] as Cell;
      events.push({
        kind: 'NodeAllocated',
        node: i as NodeId,
        value: cell.z,
        label: text[i] as string,
        role: i === 0 ? 'whole' : cell.copiedFrom !== null ? 'copied' : 'compared',
        // A linear layout grows upward from zero, so the first letter takes the
        // largest depth to sit at the top.
        depth: n - 1 - i,
        slot: `i${i}`,
        origin: 0,
        order: i,
      });
    }
    for (let i = 1; i < n; i += 1) {
      events.push({
        kind: 'PointerSet', from: (i - 1) as NodeId, slot: 'next', to: i as NodeId, pointer: 'link',
      });
    }
    for (let i = 1; i < n; i += 1) {
      const cell = this.#cells[i] as Cell;
      if (cell.copiedFrom === null) continue;
      events.push({
        kind: 'PointerSet',
        from: i as NodeId,
        slot: 'copy',
        to: cell.copiedFrom as NodeId,
        pointer: 'link',
        directed: true,
        weight: cell.z,
      });
    }
    events.push({ kind: 'RootsSet', roots: n === 0 ? [] : [0 as NodeId] });

    const copied = this.#cells.filter((c) => c.copiedFrom !== null).length;
    return {
      ok: true,
      value: {
        text, length: n,
        z: this.#cells.map((c) => c.z),
        // How much of the work the furthest-match interval saved outright.
        copied,
        longestRepeat: Math.max(0, ...this.#cells.slice(1).map((c) => c.z)),
      },
      events,
      statsDelta: { nodesAllocated: n, updates: 1 },
    };
  }

  #find(pattern: string): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);

    /*
     * The trick that makes one array enough for searching: run the same pass
     * over the pattern followed by the text. A position in the text whose Z
     * value reaches the pattern's whole length is an occurrence, because the
     * pattern is what the combined string begins with.
     *
     * The two halves need something between them that cannot appear in either,
     * or a long run could match across the join. Words here are letters, so a
     * digit will never collide with one.
     */
    const joined = `${pattern}0${this.#text}`;
    const cells = zOf(joined);
    const events: SimEvent[] = [];
    const found: number[] = [];
    const offset = pattern.length + 1;

    for (let i = offset; i < joined.length; i += 1) {
      const at = i - offset;
      events.push({ kind: 'NodeVisited', node: at as NodeId });
      if ((cells[i] as Cell).z >= pattern.length) found.push(at);
    }

    return {
      ok: true,
      value: {
        pattern, text: this.#text,
        count: found.length,
        positions: found,
        // One pass over pattern, separator and text together.
        scanned: joined.length,
      },
      events,
      statsDelta: { queries: 1, nodeVisits: events.length },
    };
  }

  #values(): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);

    return {
      ok: true,
      value: {
        text: this.#text,
        z: this.#cells.map((c) => c.z),
        rows: this.#cells.map((c, i) => ({
          at: i,
          letter: this.#text[i] as string,
          z: c.z,
          copiedFrom: c.copiedFrom,
        })),
      },
      events: this.#cells.map((_, i): SimEvent => ({ kind: 'NodeVisited', node: i as NodeId })),
      statsDelta: { queries: 1, nodeVisits: this.#cells.length },
    };
  }

  #borders(): OperationResult {
    const problem = this.#ready();
    if (problem !== null) return failed(problem);

    /*
     * The same self-similarity, converted. If the beginning starts again at i
     * and runs for z letters, then the prefix ending at i + z - 1 has a border
     * of at least z. Taking the largest such claim per position, and then
     * noting that a border of length b at one position implies at least b - 1
     * at the one before it, gives exactly KMP's array.
     */
    const n = this.#cells.length;
    const border = new Array<number>(n).fill(0);
    for (let i = n - 1; i >= 1; i -= 1) {
      const z = (this.#cells[i] as Cell).z;
      if (z === 0) continue;
      const end = i + z - 1;
      border[end] = Math.max(border[end] as number, z);
    }
    for (let i = n - 2; i >= 1; i -= 1) {
      border[i] = Math.max(border[i] as number, (border[i + 1] as number) - 1);
    }

    return {
      ok: true,
      value: { text: this.#text, borders: border },
      events: border.map((_, i): SimEvent => ({ kind: 'NodeVisited', node: i as NodeId })),
      statsDelta: { queries: 1, nodeVisits: n },
    };
  }

  /* ── Views ───────────────────────────────────────────────────────── */

  getStructure(): StructureGraph {
    const nodes: StructureNode[] = [];
    const edges: StructureEdge[] = [];
    const n = this.#cells.length;

    for (let i = 0; i < n; i += 1) {
      const cell = this.#cells[i] as Cell;
      nodes.push({
        id: i as NodeId,
        label: this.#text[i] as string,
        value: cell.z,
        role: i === 0 ? 'whole' : cell.copiedFrom !== null ? 'copied' : 'compared',
        depth: n - 1 - i,
        slot: `i${i}`,
        origin: 0,
        order: i,
      });
      if (i > 0) {
        edges.push({
          from: (i - 1) as NodeId, to: i as NodeId, slot: 'next', reused: false, kind: 'link',
        });
        if (cell.copiedFrom !== null) {
          edges.push({
            from: i as NodeId, to: cell.copiedFrom as NodeId, slot: 'copy',
            reused: false, kind: 'link', directed: true, weight: cell.z,
          });
        }
      }
    }

    return { layout: 'linear', nodes, edges, roots: n === 0 ? [] : [0 as NodeId] };
  }

  serialize(): SerializedState {
    return {
      schemaVersion: SCHEMA_VERSION,
      pluginId: 'z-algorithm',
      data: { text: this.#text },
    };
  }
}

export const zAlgorithm: AlgorithmPlugin = {
  meta: {
    id: 'z-algorithm',
    name: 'Z Algorithm',
    category: 'Strings',
    summary: 'How much of the beginning starts again at each position, in one pass.',
  },
  commands: COMMANDS,
  explain: explainZ,
  benchmark: {
    sizes: [8, 16, 32, 64, 128, 256],
    command: 'values',
    /**
     * A single repeated letter, which is the case where the furthest-match
     * interval does the most work - every position after the first copies its
     * answer rather than comparing for it.
     */
    setup: (n: number): readonly string[] => [`build ${'a'.repeat(n)}`],
    probes: (): readonly string[] => ['values'],
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
