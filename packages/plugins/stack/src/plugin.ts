/**
 * Stack.
 *
 * This plugin exists to keep the contract honest. It has no versions, no
 * tree, no ranges, and it *deletes* nodes — nothing the persistent segment
 * tree needed. Anything the contract assumed about trees or history shows up
 * here as a workaround.
 */

import {
  getInt,
  type CommandSpec, type NodeId, type OperationError, type ParsedCommand, type SimEvent,
} from '@algoverse/core';
import {
  failed,
  type AlgorithmPlugin, type EngineContext, type OperationResult,
  type PluginInstance, type SerializedState, type StructureEdge,
  type StructureGraph, type StructureNode,
} from '@algoverse/plugin-sdk';
import { explainStack } from './explain.ts';

const SCHEMA_VERSION = 1;

interface Cell {
  readonly id: NodeId;
  readonly value: number;
}

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'push',
    summary: 'Put a value on top.',
    complexity: 'O(1)',
    params: [{ name: 'value', kind: 'int' }],
  },
  { name: 'pop', summary: 'Remove and return the top value.', complexity: 'O(1)', params: [] },
  { name: 'peek', summary: 'Read the top value without removing it.', complexity: 'O(1)', params: [] },
];

function err(code: OperationError['code'], message: string, hint?: string): OperationError {
  return { code, message, ...(hint === undefined ? {} : { hint }) };
}

class Instance implements PluginInstance {
  /** Index 0 is the bottom of the stack. */
  #cells: Cell[] = [];
  #next = 0;

  reset(): void {
    this.#cells = [];
    this.#next = 0;
  }

  execute(cmd: ParsedCommand): OperationResult {
    switch (cmd.name) {
      case 'push': return this.#push(getInt(cmd, 'value'));
      case 'pop': return this.#pop();
      case 'peek': return this.#peek();
      default:
        return failed(err('PARSE_ERROR', `This plugin does not handle "${cmd.name}".`));
    }
  }

  #top(): Cell | undefined {
    return this.#cells[this.#cells.length - 1];
  }

  #rootsEvent(): SimEvent {
    const top = this.#top();
    return { kind: 'RootsSet', roots: top === undefined ? [] : [top.id] };
  }

  #empty(action: string): OperationError {
    return err('PRECONDITION_FAILED', `Cannot ${action} an empty stack.`, 'push a value first');
  }

  #push(value: number): OperationResult {
    const below = this.#top();
    const id = this.#next as NodeId;
    this.#next += 1;
    const depth = this.#cells.length;
    const events: SimEvent[] = [
      {
        kind: 'NodeAllocated',
        node: id,
        value,
        label: `s${depth}`,
        // Not "top": which cell is on top changes with every push, and a node's
        // role is fixed at allocation. Being the top is being the root.
        role: 'cell',
        depth,
        slot: `pos:${depth}`,
        origin: 0,
      },
    ];
    // A stack cell points down, not left and right. The slot name is the
    // plugin's own vocabulary; nothing in core interprets it.
    if (below !== undefined) events.push({ kind: 'PointerSet', from: id, slot: 'below', to: below.id });
    this.#cells.push({ id, value });
    events.push(this.#rootsEvent());

    return {
      ok: true,
      value: { pushed: value, depth: this.#cells.length },
      events,
      statsDelta: { updates: 1, nodesAllocated: 1, height: this.#cells.length },
    };
  }

  #pop(): OperationResult {
    const top = this.#top();
    if (top === undefined) return failed(this.#empty('pop'));

    const events: SimEvent[] = [
      { kind: 'NodeVisited', node: top.id },
      { kind: 'PointerSet', from: top.id, slot: 'below', to: null },
      { kind: 'NodeDeleted', node: top.id },
    ];
    this.#cells.pop();
    events.push(this.#rootsEvent());

    return {
      ok: true,
      value: { popped: top.value, depth: this.#cells.length },
      events,
      statsDelta: { updates: 1, nodeVisits: 1, height: this.#cells.length },
    };
  }

  #peek(): OperationResult {
    const top = this.#top();
    if (top === undefined) return failed(this.#empty('peek'));
    return {
      ok: true,
      value: { top: top.value, depth: this.#cells.length },
      events: [{ kind: 'NodeVisited', node: top.id }],
      statsDelta: { queries: 1, nodeVisits: 1 },
    };
  }

  getStructure(): StructureGraph {
    const nodes: StructureNode[] = this.#cells.map((c, i) => ({
      id: c.id,
      label: `s${i}`,
      value: c.value,
      role: 'cell',
      depth: i,
      // One cell per position, so slots never collide. No fanning to do.
      slot: `pos:${i}`,
      // No version history, so everything originates in the only generation.
      origin: 0,
    }));
    const edges: StructureEdge[] = [];
    for (let i = 1; i < this.#cells.length; i += 1) {
      edges.push({
        from: (this.#cells[i] as Cell).id,
        to: (this.#cells[i - 1] as Cell).id,
        slot: 'below',
        reused: false,
      });
    }
    const top = this.#top();
    return {
      layout: 'linear',
      nodes,
      edges,
      roots: top === undefined ? [] : [top.id],
    };
  }

  serialize(): SerializedState {
    return {
      schemaVersion: SCHEMA_VERSION,
      pluginId: 'stack',
      data: { values: this.#cells.map((c) => c.value) },
    };
  }
}

export const stack: AlgorithmPlugin = {
  meta: {
    id: 'stack',
    name: 'Stack',
    category: 'Linear structures',
    summary: 'Last in, first out. The simplest thing that can hold the plugin contract to account.',
  },
  commands: COMMANDS,
  explain: explainStack,
  createInstance: (_ctx: EngineContext): PluginInstance => new Instance(),
};
