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
  CommandSpec, LayoutHint, OperationError, ParsedCommand, Rng, SceneState, SimEvent,
  StructureEdge, StructureGraph, StructureNode,
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

/** `height` is a level, not a tally - later values replace rather than add. */
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

/**
 * The structure types live in core, because layout and the renderer consume
 * them and neither may depend on this package. Re-exported so plugins have a
 * single import.
 */
export type { LayoutHint, StructureEdge, StructureGraph, StructureNode };

export interface SerializedState {
  readonly schemaVersion: number;
  readonly pluginId: string;
  readonly data: unknown;
}

/**
 * Events and stats are reported whether the operation succeeded or not - a
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

export interface ExplainContext {
  /** Scene state immediately after the event. */
  readonly after: SceneState;
  /** The command this event belongs to, so an explainer can cite its arguments. */
  readonly command: ParsedCommand | null;
  /** Index of the event in the whole log. */
  readonly step: number;
}

/**
 * Why an event happened, in the algorithm's own terms.
 *
 * A pure function of the event and the surrounding state - never generated at
 * execution time and stored. Keeping prose out of the log means the log stays
 * serialisable data, explanations can be rewritten without re-running anything,
 * and there is one obvious place to add other languages later.
 *
 * Return `null` for events not worth narrating; the generic description shows
 * through instead.
 */
export type Explainer = (event: SimEvent, ctx: ExplainContext) => string | null;

export interface AlgorithmPlugin {
  readonly meta: PluginMeta;
  readonly commands: readonly CommandSpec[];
  createInstance(ctx: EngineContext): PluginInstance;
  readonly explain?: Explainer;
}

/** Convenience for plugins returning a failure. */
export function failed(
  error: OperationError,
  events: readonly SimEvent[] = [],
  statsDelta: Partial<Statistics> = {},
): OperationResult {
  return { ok: false, error, events, statsDelta };
}
