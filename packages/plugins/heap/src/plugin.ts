/**
 * Binary heap.
 *
 * A min-heap kept in an array, drawn as the tree the array implies: the
 * children of position i sit at 2i+1 and 2i+2. A node here is a *position*,
 * not a value. Sifting moves values between positions and leaves the positions
 * where they are, which is exactly what the array does - so a swap is two
 * `NodeUpdated` events rather than two nodes trading places.
 *
 * No history: a heap is the structure people reach for when they want the
 * smallest thing next and nothing about the past.
 */

import {
  getInt, getIntList,
  type CommandSpec, type NodeId, type OperationError, type ParsedCommand, type SimEvent,
} from '@algoverse/core';
import {
  failed,
  type AlgorithmPlugin, type EngineContext, type OperationResult,
  type PluginInstance, type SerializedState, type StructureEdge,
  type StructureGraph, type StructureNode,
} from '@algoverse/plugin-sdk';
import { explainHeap } from './explain.ts';

const SCHEMA_VERSION = 1;

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'build',
    summary: 'Replace the heap with these values, heapified bottom-up.',
    complexity: 'O(n)',
    params: [{ name: 'values', kind: 'int-list' }],
  },
  {
    name: 'push',
    summary: 'Add a value at the end and sift it up.',
    complexity: 'O(log n)',
    params: [{ name: 'value', kind: 'int' }],
  },
  {
    name: 'pop',
    summary: 'Remove the smallest value; the last one takes its place and sifts down.',
    complexity: 'O(log n)',
    params: [],
  },
  { name: 'peek', summary: 'Read the smallest value.', complexity: 'O(1)', params: [] },
  {
    name: 'set',
    summary: 'Overwrite the value at a position, then sift whichever way restores order.',
    complexity: 'O(log n)',
    params: [
      { name: 'index', kind: 'int' },
      { name: 'value', kind: 'int' },
    ],
  },
];

const parentOf = (i: number): number => Math.floor((i - 1) / 2);
const depthOf = (i: number): number => Math.floor(Math.log2(i + 1));
/** "left" sorts before "right", which is the order layout draws slots in. */
const slotOf = (i: number): 'left' | 'right' => (i % 2 === 1 ? 'left' : 'right');
/** Positions are the nodes, so a position's index is its identity. */
const idOf = (i: number): NodeId => i as NodeId;

function err(code: OperationError['code'], message: string, hint?: string): OperationError {
  return { code, message, ...(hint === undefined ? {} : { hint }) };
}

class Instance implements PluginInstance {
  #values: number[] = [];

  reset(): void {
    this.#values = [];
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'build': return this.#build(getIntList(cmd, 'values'));
      case 'push': return this.#push(getInt(cmd, 'value'));
      case 'pop': return this.#pop();
      case 'peek': return this.#peek();
      case 'set': return this.#set(getInt(cmd, 'index'), getInt(cmd, 'value'));
      default:
        return failed(err('PARSE_ERROR', `This plugin does not handle "${cmd.name}".`));
    }
  }

  #height(): number {
    return this.#values.length === 0 ? 0 : depthOf(this.#values.length - 1) + 1;
  }

  #roots(): SimEvent {
    return { kind: 'RootsSet', roots: this.#values.length === 0 ? [] : [idOf(0)] };
  }

  /** A new position at the end, hooked under its parent. */
  #allocate(i: number, value: number, events: SimEvent[]): void {
    events.push({
      kind: 'NodeAllocated',
      node: idOf(i),
      value,
      label: `h[${i}]`,
      role: 'entry',
      depth: depthOf(i),
      slot: `i${i}`,
      origin: 0,
    });
    if (i > 0) events.push({ kind: 'PointerSet', from: idOf(parentOf(i)), slot: slotOf(i), to: idOf(i) });
  }

  #swap(a: number, b: number, events: SimEvent[]): void {
    const va = this.#values[a] as number;
    const vb = this.#values[b] as number;
    this.#values[a] = vb;
    this.#values[b] = va;
    events.push({ kind: 'NodeUpdated', node: idOf(a), value: vb });
    events.push({ kind: 'NodeUpdated', node: idOf(b), value: va });
  }

  /** Returns the number of positions compared, which is the operation's cost. */
  #siftUp(i: number, events: SimEvent[]): number {
    let visits = 0;
    while (i > 0) {
      const p = parentOf(i);
      events.push({ kind: 'NodeVisited', node: idOf(p) });
      visits += 1;
      if ((this.#values[p] as number) <= (this.#values[i] as number)) break;
      this.#swap(p, i, events);
      i = p;
    }
    return visits;
  }

  #siftDown(i: number, events: SimEvent[]): number {
    const n = this.#values.length;
    let visits = 0;
    for (;;) {
      let smallest = i;
      for (const c of [2 * i + 1, 2 * i + 2]) {
        if (c >= n) continue;
        events.push({ kind: 'NodeVisited', node: idOf(c) });
        visits += 1;
        if ((this.#values[c] as number) < (this.#values[smallest] as number)) smallest = c;
      }
      if (smallest === i) return visits;
      this.#swap(i, smallest, events);
      i = smallest;
    }
  }

  #build(values: readonly number[]): OperationResult {
    const events: SimEvent[] = [];
    // Building replaces, so the old positions go first - deepest first, so no
    // pointer is ever left aimed at a freed node.
    for (let i = this.#values.length - 1; i >= 0; i -= 1) {
      if (i > 0) events.push({ kind: 'PointerSet', from: idOf(parentOf(i)), slot: slotOf(i), to: null });
      events.push({ kind: 'NodeDeleted', node: idOf(i) });
    }
    this.#values = [...values];
    for (let i = 0; i < values.length; i += 1) this.#allocate(i, values[i] as number, events);
    events.push(this.#roots());

    // Floyd's heapify: every leaf is already a heap of one, so start at the
    // last parent and sift down. Most positions are near the bottom and sift
    // a short way, which is where O(n) rather than O(n log n) comes from.
    let visits = 0;
    for (let i = parentOf(values.length - 1); i >= 0; i -= 1) visits += this.#siftDown(i, events);

    return {
      ok: true,
      value: { size: values.length, min: values.length === 0 ? null : this.#values[0] },
      events,
      statsDelta: { updates: 1, nodesAllocated: values.length, nodeVisits: visits, height: this.#height() },
    };
  }

  #push(value: number): OperationResult {
    const events: SimEvent[] = [];
    const i = this.#values.length;
    this.#values.push(value);
    this.#allocate(i, value, events);
    if (i === 0) events.push(this.#roots());
    const visits = this.#siftUp(i, events);
    return {
      ok: true,
      value: { pushed: value, size: this.#values.length, min: this.#values[0] },
      events,
      statsDelta: { updates: 1, nodesAllocated: 1, nodeVisits: visits, height: this.#height() },
    };
  }

  #empty(action: string): OperationError {
    return err('PRECONDITION_FAILED', `Cannot ${action} an empty heap.`, 'push a value first');
  }

  #pop(): OperationResult {
    if (this.#values.length === 0) return failed(this.#empty('pop'));
    const events: SimEvent[] = [{ kind: 'NodeVisited', node: idOf(0) }];
    const min = this.#values[0] as number;
    const last = this.#values.length - 1;
    const moved = this.#values[last] as number;

    // The last position is the only one that can disappear without leaving a
    // hole, so its value moves to the root and the position itself goes.
    if (last > 0) {
      this.#values[0] = moved;
      events.push({ kind: 'NodeUpdated', node: idOf(0), value: moved });
      events.push({ kind: 'PointerSet', from: idOf(parentOf(last)), slot: slotOf(last), to: null });
    }
    events.push({ kind: 'NodeDeleted', node: idOf(last) });
    this.#values.pop();
    if (this.#values.length === 0) events.push(this.#roots());
    const visits = 1 + this.#siftDown(0, events);

    return {
      ok: true,
      value: { popped: min, size: this.#values.length },
      events,
      statsDelta: { updates: 1, nodeVisits: visits, height: this.#height() },
    };
  }

  #peek(): OperationResult {
    if (this.#values.length === 0) return failed(this.#empty('peek'));
    return {
      ok: true,
      value: { min: this.#values[0], size: this.#values.length },
      events: [{ kind: 'NodeVisited', node: idOf(0) }],
      statsDelta: { queries: 1, nodeVisits: 1 },
    };
  }

  #set(index: number, value: number): OperationResult {
    const n = this.#values.length;
    if (index < 0 || index >= n) {
      return failed(err('INDEX_OUT_OF_RANGE', `Position ${index} is not in a heap of ${n}.`,
        n === 0 ? 'push a value first' : `positions run from 0 to ${n - 1}`));
    }
    const before = this.#values[index] as number;
    this.#values[index] = value;
    const events: SimEvent[] = [
      { kind: 'NodeVisited', node: idOf(index) },
      { kind: 'NodeUpdated', node: idOf(index), value },
    ];
    // Smaller can only be out of order with the parent, larger only with the
    // children - so exactly one direction ever needs sifting.
    const visits = 1 + (value < before ? this.#siftUp(index, events) : this.#siftDown(index, events));
    return {
      ok: true,
      value: { was: before, now: value, min: this.#values[0] },
      events,
      statsDelta: { updates: 1, nodeVisits: visits },
    };
  }

  getStructure(): StructureGraph {
    const nodes: StructureNode[] = this.#values.map((v, i) => ({
      id: idOf(i),
      label: `h[${i}]`,
      value: v,
      role: 'entry',
      depth: depthOf(i),
      slot: `i${i}`,
      origin: 0,
    }));
    const edges: StructureEdge[] = [];
    for (let i = 1; i < this.#values.length; i += 1) {
      edges.push({ from: idOf(parentOf(i)), to: idOf(i), slot: slotOf(i), reused: false });
    }
    return { layout: 'dag', nodes, edges, roots: this.#values.length === 0 ? [] : [idOf(0)] };
  }

  serialize(): SerializedState {
    return { schemaVersion: SCHEMA_VERSION, pluginId: 'heap', data: { values: [...this.#values] } };
  }
}

export const heap: AlgorithmPlugin = {
  meta: {
    id: 'heap',
    name: 'Binary Heap',
    category: 'Trees',
    summary: 'A min-heap in an array. The smallest value is always at the root, and nothing else is promised.',
  },
  commands: COMMANDS,
  explain: explainHeap,
  benchmark: {
    sizes: [8, 16, 32, 64, 128, 256],
    command: 'push',
    // Ascending pushes never sift, so setup is cheap; each probe is smaller than
    // everything already there and has to climb the whole height.
    setup: (n: number): readonly string[] => Array.from({ length: n }, (_, i) => `push ${i}`),
    probes: (): readonly string[] => Array.from({ length: 8 }, (_, i) => `push ${-1 - i}`),
  },
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
