/**
 * The plugin contract.
 *
 * A plugin declares its commands as data and answers a single `execute`.
 * The engine never learns what algorithm it is driving: it parses against
 * `commands`, hands over a `ParsedCommand`, and files the returned events.
 *
 * Everything crossing this boundary is serialisable data. That is what keeps
 * a future WebAssembly implementation a drop-in swap rather than a rewrite.
 */

import type {
  CommandSpec, NodeId, OperationError, ParsedCommand, Rng, SimEvent,
} from '@algoverse/core';

export interface PluginMeta {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly summary: string;
}

/** Measured counters. Declared complexity lives on CommandSpec, not here. */
export interface Statistics {
  readonly versions: number;
  readonly updates: number;
  readonly queries: number;
  readonly nodesAllocated: number;
  readonly nodesReused: number;
  readonly nodeVisits: number;
  readonly height: number;
}

export const ZERO_STATS: Statistics = {
  versions: 0,
  updates: 0,
  queries: 0,
  nodesAllocated: 0,
  nodesReused: 0,
  nodeVisits: 0,
  height: 0,
};

/** `height` is a level, not a tally — later values replace rather than add. */
export function addStats(base: Statistics, delta: Partial<Statistics>): Statistics {
  return {
    versions: base.versions + (delta.versions ?? 0),
    updates: base.updates + (delta.updates ?? 0),
    queries: base.queries + (delta.queries ?? 0),
    nodesAllocated: base.nodesAllocated + (delta.nodesAllocated ?? 0),
    nodesReused: base.nodesReused + (delta.nodesReused ?? 0),
    nodeVisits: base.nodeVisits + (delta.nodeVisits ?? 0),
    height: delta.height ?? base.height,
  };
}

export type LayoutHint = 'tree' | 'dag' | 'force' | 'linear' | 'grid';

export interface StructureNode {
  readonly id: NodeId;
  readonly label: string;
  readonly value: number;
  readonly role: string;
  readonly depth: number;
  /**
   * Layout grouping key. Nodes sharing a slot occupy one logical position and
   * are fanned apart by the layout engine. For a persistent structure this is
   * how several versions of the same node stay aligned.
   */
  readonly slot: string;
  /** Which version allocated this node. Drives provenance colouring. */
  readonly origin: number;
}

export interface StructureEdge {
  readonly from: NodeId;
  readonly to: NodeId;
  readonly slot: string;
  /** True when the child predates the parent — a pointer into reused memory. */
  readonly reused: boolean;
}

export interface StructureGraph {
  readonly layout: LayoutHint;
  readonly nodes: readonly StructureNode[];
  readonly edges: readonly StructureEdge[];
  readonly roots: readonly NodeId[];
}

export interface SerializedState {
  readonly schemaVersion: number;
  readonly pluginId: string;
  readonly data: unknown;
}

/**
 * Events and stats are reported whether the operation succeeded or not — a
 * failed query may still have visited nodes worth showing.
 */
export type OperationResult =
  | {
      readonly ok: true;
      readonly value: unknown;
      readonly events: readonly SimEvent[];
      readonly statsDelta: Partial<Statistics>;
    }
  | {
      readonly ok: false;
      readonly error: OperationError;
      readonly events: readonly SimEvent[];
      readonly statsDelta: Partial<Statistics>;
    };

export interface EngineContext {
  readonly rng: Rng;
}

export interface PluginInstance {
  execute(cmd: ParsedCommand): OperationResult;
  getStructure(): StructureGraph;
  serialize(): SerializedState;
  reset(): void;
}

export interface AlgorithmPlugin {
  readonly meta: PluginMeta;
  readonly commands: readonly CommandSpec[];
  createInstance(ctx: EngineContext): PluginInstance;
}

/** Convenience for plugins returning a failure. */
export function failed(
  error: OperationError,
  events: readonly SimEvent[] = [],
  statsDelta: Partial<Statistics> = {},
): OperationResult {
  return { ok: false, error, events, statsDelta };
}
