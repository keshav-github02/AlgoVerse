/**
 * Persistent Li Chao tree.
 *
 * A segment tree over the x axis that holds *lines* instead of numbers, and
 * answers "of everything added so far, which is lowest at this x".
 *
 * The idea it turns on is that two straight lines cross at most once. So over
 * any interval, one of them is better on the left of the crossing and the
 * other on the right - and if you know which is better at the midpoint, the
 * loser can only be winning on one side. That is the whole algorithm:
 *
 *   - compare the two lines at the node's midpoint, and keep the winner here;
 *   - compare them at the node's left edge. If the answer is the same as at
 *     the midpoint, the loser can only win to the right; if it differs, only
 *     to the left. Push it there.
 *
 * One line per node, one child visited per level. Adding a line costs a path,
 * and so does asking about an x: walk from the root to the leaf holding that
 * x and take the best of the lines met on the way. Nothing is ever removed,
 * and nothing needs to be - a line that has been beaten everywhere simply
 * stops being the answer anywhere.
 *
 * Path copying then makes it persistent for free, which is worth having here:
 * the interesting question about a set of lines is usually how the lower
 * envelope *changed* when one more was added.
 */

import {
  diffRoots, getInt, getVersion,
  type CommandSpec, type NodeId, type OperationError, type ParsedCommand, type SimEvent,
} from '@algoverse/core';
import {
  failed,
  type AlgorithmPlugin, type EngineContext, type OperationResult,
  type PluginInstance, type SerializedState,
  type StructureEdge, type StructureGraph, type StructureNode,
} from '@algoverse/plugin-sdk';
import { explainLiChao } from './explain.ts';

const SCHEMA_VERSION = 1;

/** The widest x range worth drawing, and deep enough for any teaching example. */
const MAX_SPAN = 1 << 20;

interface Node {
  readonly id: NodeId;
  /** Inclusive x range this node speaks for. */
  readonly lo: number;
  readonly hi: number;
  /** The line kept here: y = m*x + c. */
  readonly m: number;
  readonly c: number;
  readonly left: NodeId | null;
  readonly right: NodeId | null;
  readonly origin: number;
  readonly depth: number;
}

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Open an empty tree over an inclusive range of x.',
    complexity: 'O(1)',
    params: [
      { name: 'lo', kind: 'int' },
      { name: 'hi', kind: 'int' },
    ],
  },
  {
    name: 'add',
    summary: 'Add the line y = m*x + c, producing a new version.',
    complexity: 'O(log n)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'm', kind: 'int' },
      { name: 'c', kind: 'int' },
    ],
  },
  {
    name: 'query',
    summary: 'The lowest value any line reaches at x, and which line it is.',
    complexity: 'O(log n)',
    params: [
      { name: 'version', kind: 'version' },
      { name: 'x', kind: 'int' },
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

const show = (m: number, c: number): string =>
  `${m}x${c < 0 ? '' : '+'}${c}`;

class Instance implements PluginInstance {
  #nodes = new Map<NodeId, Node>();
  #roots: (NodeId | null)[] = [];
  #lo = 0;
  #hi = 0;
  #next = 0;
  /** Every line ever added, per version, for reporting only. */
  #lines: [number, number][][] = [];

  reset(): void {
    this.#nodes = new Map();
    this.#roots = [];
    this.#lines = [];
    this.#lo = 0;
    this.#hi = 0;
    this.#next = 0;
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getInt(cmd, 'lo'), getInt(cmd, 'hi'));
      case 'add': return this.#add(getVersion(cmd, 'version'), getInt(cmd, 'm'), getInt(cmd, 'c'));
      case 'query': return this.#query(getVersion(cmd, 'version'), getInt(cmd, 'x'));
      case 'compare': return this.#compare(getVersion(cmd, 'a'), getVersion(cmd, 'b'));
      default:
        return failed(err('PARSE_ERROR', `This plugin does not handle "${cmd.name}".`));
    }
  }

  /* ── Helpers ─────────────────────────────────────────────────────── */

  #get(id: NodeId): Node {
    const node = this.#nodes.get(id);
    if (node === undefined) throw new Error(`missing node ${id}`);
    return node;
  }

  #available(): string {
    return this.#roots.length === 0
      ? 'nothing is built yet - start with build'
      : `versions available: ${this.#roots.map((_, i) => `v${i}`).join(', ')}`;
  }

  /** Midpoint, floored - and floored the same way for a range that is negative. */
  #mid(lo: number, hi: number): number {
    return Math.floor((lo + hi) / 2);
  }

  #alloc(
    lo: number, hi: number, m: number, c: number,
    left: NodeId | null, right: NodeId | null,
    origin: number, depth: number, events: SimEvent[],
  ): Node {
    const id = this.#next as NodeId;
    this.#next += 1;
    const node: Node = { id, lo, hi, m, c, left, right, origin, depth };
    this.#nodes.set(id, node);
    events.push({
      kind: 'NodeAllocated',
      node: id,
      // What this node's line is worth in the middle of its own range, which
      // is the comparison the whole algorithm is decided by.
      value: m * this.#mid(lo, hi) + c,
      label: show(m, c),
      role: lo === hi ? 'leaf' : 'internal',
      depth,
      // Nodes for the same x range line up across versions.
      slot: `${lo}:${hi}`,
      origin,
    });
    if (left !== null) events.push({ kind: 'PointerSet', from: id, slot: 'left', to: left });
    if (right !== null) events.push({ kind: 'PointerSet', from: id, slot: 'right', to: right });
    return node;
  }

  /**
   * Puts a line into the subtree for [lo, hi], copying the path it takes.
   *
   * The two comparisons - at the midpoint and at the left edge - are the whole
   * of it. Because two lines cross at most once, agreeing at both points means
   * the loser cannot overtake before the midpoint, so its only chance is the
   * right half; disagreeing means the crossing is to the left of the midpoint,
   * so its only chance is the left.
   */
  #insert(
    id: NodeId | null, lo: number, hi: number,
    m: number, c: number, depth: number, version: number, events: SimEvent[],
  ): NodeId {
    if (id === null) {
      return this.#alloc(lo, hi, m, c, null, null, version, depth, events).id;
    }

    const node = this.#get(id);
    events.push({ kind: 'NodeVisited', node: id });

    const mid = this.#mid(lo, hi);
    const at = (mm: number, cc: number, x: number): number => mm * x + cc;

    let keepM = node.m;
    let keepC = node.c;
    let passM = m;
    let passC = c;

    const newWinsLeft = at(m, c, lo) < at(node.m, node.c, lo);
    const newWinsMid = at(m, c, mid) < at(node.m, node.c, mid);
    if (newWinsMid) {
      keepM = m;
      keepC = c;
      passM = node.m;
      passC = node.c;
    }

    // A single x has no halves to push anything into: the better line wins.
    if (lo === hi) {
      return this.#alloc(lo, hi, keepM, keepC, null, null, version, depth, events).id;
    }

    let left = node.left;
    let right = node.right;
    if (newWinsLeft !== newWinsMid) {
      left = this.#insert(node.left, lo, mid, passM, passC, depth + 1, version, events);
    } else {
      right = this.#insert(node.right, mid + 1, hi, passM, passC, depth + 1, version, events);
    }

    const made = this.#alloc(lo, hi, keepM, keepC, left, right, version, depth, events);
    // Whichever side the loser did not go down is shared, not copied.
    for (const [was, now] of [[node.left, left], [node.right, right]] as const) {
      if (was !== null && was === now) {
        events.push({ kind: 'NodeReused', node: was, by: made.id });
      }
    }
    return made.id;
  }

  /* ── Commands ────────────────────────────────────────────────────── */

  #build(lo: number, hi: number): OperationResult {
    if (lo > hi) {
      return failed(err('INVALID_RANGE', `The range ${lo}..${hi} runs backwards.`,
        'lo must be no greater than hi, and both ends are included'));
    }
    if (hi - lo + 1 > MAX_SPAN) {
      return failed(err('BAD_ARGUMENT',
        `A span of ${hi - lo + 1} values is wider than this will hold.`,
        `the widest range is ${MAX_SPAN}`));
    }

    this.reset();
    this.#lo = lo;
    this.#hi = hi;
    const events: SimEvent[] = [];
    // No lines yet, so no nodes yet: a Li Chao tree is built as it is used.
    this.#roots.push(null);
    this.#lines.push([]);
    events.push({ kind: 'VersionCommitted', version: 0, roots: [] });
    events.push({ kind: 'RootsSet', roots: [] });

    return {
      ok: true,
      value: { version: 0, lo, hi, span: hi - lo + 1, lines: 0 },
      events,
      statsDelta: { versions: 1 },
    };
  }

  #add(v: number, m: number, c: number): OperationResult {
    if (v < 0 || v >= this.#roots.length) {
      return failed(err('UNKNOWN_VERSION', `Version v${v} does not exist.`, this.#available()));
    }

    const events: SimEvent[] = [];
    const version = this.#roots.length;
    const before = this.#nodes.size;
    const root = this.#insert(
      this.#roots[v] as NodeId | null, this.#lo, this.#hi, m, c, 0, version, events);

    this.#roots.push(root);
    this.#lines.push([...(this.#lines[v] as [number, number][]), [m, c]]);
    events.push({ kind: 'VersionCommitted', version, roots: [root] });
    events.push({ kind: 'RootsSet', roots: this.#roots.filter((r): r is NodeId => r !== null) });

    const allocated = this.#nodes.size - before;
    return {
      ok: true,
      value: {
        version, line: show(m, c),
        lines: (this.#lines[version] as [number, number][]).length,
        allocated,
      },
      events,
      statsDelta: { versions: 1, updates: 1, nodesAllocated: allocated },
    };
  }

  #query(v: number, x: number): OperationResult {
    if (v < 0 || v >= this.#roots.length) {
      return failed(err('UNKNOWN_VERSION', `Version v${v} does not exist.`, this.#available()));
    }
    if (x < this.#lo || x > this.#hi) {
      return failed(err('INDEX_OUT_OF_RANGE',
        `x = ${x} is outside ${this.#lo}..${this.#hi}.`,
        'the range was fixed by build, because the tree is shaped around it'));
    }
    const root = this.#roots[v];
    if (root === undefined || root === null) {
      return failed(err('PRECONDITION_FAILED', `v${v} holds no lines yet.`,
        'add one with add, then ask again'));
    }

    /*
     * Straight down to the leaf for x, taking the best line met on the way.
     * Every line that could be lowest at x is on this path - that is what the
     * insertion rule guarantees, and why nothing has to be searched for.
     */
    const events: SimEvent[] = [];
    let cursor: NodeId | null = root;
    let lo = this.#lo;
    let hi = this.#hi;
    let best = Infinity;
    let bestLine = '';
    let visits = 0;

    while (cursor !== null) {
      const node = this.#get(cursor);
      events.push({ kind: 'NodeVisited', node: cursor });
      visits += 1;
      const here = node.m * x + node.c;
      if (here < best) {
        best = here;
        bestLine = show(node.m, node.c);
      }
      if (lo === hi) break;
      const mid = this.#mid(lo, hi);
      if (x <= mid) { cursor = node.left; hi = mid; } else { cursor = node.right; lo = mid + 1; }
    }

    return {
      ok: true,
      value: { x, min: best, line: bestLine, visits },
      events,
      statsDelta: { queries: 1, nodeVisits: visits },
    };
  }

  #compare(a: number, b: number): OperationResult {
    for (const v of [a, b]) {
      if (v < 0 || v >= this.#roots.length) {
        return failed(err('UNKNOWN_VERSION', `Version v${v} does not exist.`, this.#available()));
      }
    }
    const ra = this.#roots[a] as NodeId | null;
    const rb = this.#roots[b] as NodeId | null;
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

    for (const n of this.#nodes.values()) {
      nodes.push({
        id: n.id,
        label: show(n.m, n.c),
        value: n.m * this.#mid(n.lo, n.hi) + n.c,
        role: n.lo === n.hi ? 'leaf' : 'internal',
        depth: n.depth,
        slot: `${n.lo}:${n.hi}`,
        origin: n.origin,
      });
      for (const [slot, child] of [['left', n.left], ['right', n.right]] as const) {
        if (child === null) continue;
        edges.push({ from: n.id, to: child, slot, reused: this.#get(child).origin < n.origin });
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
      pluginId: 'li-chao',
      data: {
        lo: this.#lo,
        hi: this.#hi,
        versions: this.#lines.map((lines) => lines.map(([m, c]) => [m, c])),
      },
    };
  }
}

export const liChao: AlgorithmPlugin = {
  meta: {
    id: 'li-chao',
    name: 'Li Chao Tree',
    category: 'Advanced',
    summary: 'A segment tree of lines, answering which one is lowest at any x.',
  },
  commands: COMMANDS,
  explain: explainLiChao,
  benchmark: {
    sizes: [8, 16, 32, 64, 128, 256],
    command: 'query',
    /**
     * Tangents to a parabola: the line for a is y = -2a*x + a^2, which is the
     * lowest of them at x = a and nowhere else. Every x therefore has its own
     * winner, and the losers fill the tree down to the leaves.
     *
     * A fixed handful of lines instead would leave the path a query walks
     * almost empty - the first attempt here used twelve, and a query over a
     * span of 1024 visited one node at every size, which measures a constant
     * and says nothing about the structure.
     */
    setup: (n: number): readonly string[] => [
      `build 0 ${n - 1}`,
      ...Array.from({ length: n }, (_, a) => `add v${a} ${-2 * a} ${a * a}`),
    ],
    probes: (n: number): readonly string[] => [`query v${n} ${Math.floor(n / 2)}`],
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
