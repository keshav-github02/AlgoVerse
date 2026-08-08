/**
 * The engine, outside React.
 *
 * The event log and the per-step scene never enter a React store. Putting them
 * there would re-render the tree on every frame of playback. Components read
 * through `useSyncExternalStore` and pull what they need.
 */

import {
  Playback, Timeline, createRng, layout, parseCommand, sceneToStructure,
  type LayoutHint, type NodeId, type OperationError, type PositionedScene,
  type SceneState, type SimEvent,
} from '@algoverse/core';
import {
  ZERO_STATS, addStats,
  type AlgorithmPlugin, type PluginInstance, type Statistics,
} from '@algoverse/plugin-sdk';
import { persistentSegmentTree } from '@algoverse/plugin-persistent-segment-tree';
import { stack } from '@algoverse/plugin-stack';

export const PLUGINS: readonly AlgorithmPlugin[] = [persistentSegmentTree, stack];

export interface HistoryEntry {
  readonly line: string;
  readonly ok: boolean;
  readonly text: string;
  readonly error: OperationError | null;
}

export interface View {
  readonly scene: PositionedScene;
  readonly state: SceneState;
  readonly visited: readonly NodeId[];
}

export class Session {
  readonly plugin: AlgorithmPlugin;
  readonly playback: Playback;

  #instance: PluginInstance;
  #timeline = new Timeline();
  #events: SimEvent[] = [];
  #history: HistoryEntry[] = [];
  #stats: Statistics = ZERO_STATS;
  #hint: LayoutHint;
  #stable: PositionedScene;
  #version = 0;
  #listeners = new Set<() => void>();

  constructor(plugin: AlgorithmPlugin) {
    this.plugin = plugin;
    this.#instance = plugin.createInstance({ rng: createRng(1) });
    this.#hint = this.#instance.getStructure().layout;
    this.#stable = layout(sceneToStructure(this.#timeline.stateAt(0), this.#hint));
    this.playback = new Playback(this.#timeline);
    this.playback.subscribe(() => this.#bump());
  }

  get layoutHint(): LayoutHint {
    return this.#hint;
  }

  get history(): readonly HistoryEntry[] {
    return this.#history;
  }

  get stats(): Statistics {
    return this.#stats;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  };

  /** Snapshot for useSyncExternalStore — a counter, not an object. */
  getVersion = (): number => this.#version;

  #bump(): void {
    this.#version += 1;
    for (const fn of this.#listeners) fn();
  }

  run(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;

    const parsed = parseCommand(trimmed, this.plugin.commands);
    if (!parsed.ok) {
      this.#history.push({ line: trimmed, ok: false, text: parsed.error.message, error: parsed.error });
      this.#bump();
      return;
    }

    const result = this.#instance.execute(parsed.command);
    this.#timeline.append(result.events, trimmed);
    this.#events.push(...result.events);
    this.#stats = addStats(this.#stats, result.statsDelta);
    this.#history.push(
      result.ok
        ? { line: trimmed, ok: true, text: JSON.stringify(result.value), error: null }
        : { line: trimmed, ok: false, text: result.error.message, error: result.error },
    );

    this.#relayout();
    this.playback.last();
    this.#bump();
  }

  reset(): void {
    this.#instance.reset();
    this.#timeline = new Timeline();
    this.#events = [];
    this.#history = [];
    this.#stats = ZERO_STATS;
    this.#relayout();
    // Playback holds the old timeline, so the caller replaces the session.
    this.#bump();
  }

  /**
   * Layout runs over every node that ever existed, not the current frame.
   * Per-frame layout would slide surviving nodes sideways whenever a
   * neighbour appeared.
   */
  #relayout(): void {
    const union = new Timeline();
    union.append(this.#events.filter((e) => e.kind !== 'NodeDeleted'));
    this.#stable = layout(sceneToStructure(union.stateAt(union.length), this.#hint));
  }

  view(): View {
    const state = this.playback.scene();
    const present = new Set<NodeId>(state.nodes.keys());
    return {
      state,
      scene: {
        nodes: this.#stable.nodes.filter((n) => present.has(n.node.id)),
        edges: this.#stable.edges.filter((e) => present.has(e.from) && present.has(e.to)),
        width: Math.max(this.#stable.width, 1),
        height: Math.max(this.#stable.height, 1),
      },
      visited: [...state.visits.keys()].filter((id) => present.has(id)),
    };
  }

  /** What the last event did, for the status line. */
  currentEvent(): SimEvent | undefined {
    return this.#timeline.eventAt(this.playback.step - 1);
  }
}

export function describeEvent(e: SimEvent | undefined): string {
  if (e === undefined) return 'ready';
  switch (e.kind) {
    case 'NodeAllocated': return `allocate ${e.label} = ${e.value}`;
    case 'NodeDeleted': return `free node ${e.node}`;
    case 'PointerSet': return e.to === null
      ? `clear ${e.slot} of node ${e.from}`
      : `point ${e.slot} of node ${e.from} at node ${e.to}`;
    case 'NodeReused': return `reuse node ${e.node} under node ${e.by}`;
    case 'NodeVisited': return `visit node ${e.node}`;
    case 'RootsSet': return `entry points: ${e.roots.length === 0 ? 'none' : e.roots.join(', ')}`;
    case 'VersionCommitted': return `commit v${e.version}`;
    default: return '';
  }
}
