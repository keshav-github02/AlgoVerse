/**
 * The engine, outside React.
 *
 * The event log and the per-step scene never enter a React store. Putting them
 * there would re-render the tree on every frame of playback. Components read
 * through `useSyncExternalStore` and pull what they need.
 */

import {
  Playback, SIMULATION_SCHEMA, Timeline, createRng, describeEvent, digestOf, layout,
  parseCommand,
  sceneToStructure,
  type LayoutHint, type NodeId, type OperationError, type ParsedCommand,
  type PositionedScene, type SceneState, type SimEvent, type SimulationFile,
} from '@algoverse/core';
import {
  ZERO_STATS, addStats,
  type AlgorithmPlugin, type PluginInstance, type Statistics,
} from '@algoverse/plugin-sdk';
import { persistentSegmentTree } from '@algoverse/plugin-persistent-segment-tree';
import { persistentBit } from '@algoverse/plugin-persistent-bit';
import { persistentTreap } from '@algoverse/plugin-persistent-treap';
import { persistentTrie } from '@algoverse/plugin-persistent-trie';
import { persistentBst } from '@algoverse/plugin-persistent-bst';
import { persistentAvl } from '@algoverse/plugin-persistent-avl';
import { persistentBtree } from '@algoverse/plugin-persistent-btree';
import { persistentSplay } from '@algoverse/plugin-persistent-splay';
import { persistentBplus } from '@algoverse/plugin-persistent-bplus';
import { graph } from '@algoverse/plugin-graph';
import { shortestPath } from '@algoverse/plugin-shortest-path';
import { stack } from '@algoverse/plugin-stack';

export const PLUGINS: readonly AlgorithmPlugin[] = [persistentSegmentTree, persistentBit, persistentTreap, persistentTrie, persistentBst, persistentAvl, persistentBtree, persistentSplay, persistentBplus, graph, shortestPath, stack];

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
  /** Parallel to timeline.marks: the command each operation ran. */
  #commands: ParsedCommand[] = [];
  #history: HistoryEntry[] = [];
  #stats: Statistics = ZERO_STATS;
  #hint: LayoutHint;
  #stable: PositionedScene;
  #version = 0;
  #listeners = new Set<() => void>();
  /** Commands that actually ran, in order - this is the save format. */
  #script: string[] = [];
  readonly #seed: number;

  constructor(plugin: AlgorithmPlugin, seed = 1) {
    this.plugin = plugin;
    this.#seed = seed;
    this.#instance = plugin.createInstance({ rng: createRng(seed) });
    this.#hint = this.#instance.getStructure().layout;
    this.#stable = layout(sceneToStructure(this.#timeline.stateAt(0), this.#hint));
    this.playback = new Playback(this.#timeline);
    this.playback.subscribe(() => this.#bump());
  }

  get layoutHint(): LayoutHint {
    return this.#hint;
  }

  get script(): readonly string[] {
    return this.#script;
  }

  get seed(): number {
    return this.#seed;
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

  /** Snapshot for useSyncExternalStore - a counter, not an object. */
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
    if (result.events.length > 0) this.#commands.push(parsed.command);
    // Only successful commands are worth replaying; a rejected one changed
    // nothing, so putting it in the save would just reproduce the error.
    if (result.ok) this.#script.push(trimmed);
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
    this.#commands = [];
    this.#script = [];
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

  /* ── Saving ──────────────────────────────────────────────────────── */

  toFile(): SimulationFile {
    return {
      schemaVersion: SIMULATION_SCHEMA,
      pluginId: this.plugin.meta.id,
      seed: this.#seed,
      commands: [...this.#script],
      digest: digestOf(this.#instance.serialize()),
    };
  }

  /**
   * Rebuild by replaying. The whole timeline comes back, so a loaded
   * simulation scrubs exactly like a fresh one.
   *
   * Returns a warning rather than failing when the replayed state disagrees
   * with the digest: the file is still the user's work, and refusing to open
   * it would be worse than opening it with a caveat.
   */
  static load(
    file: SimulationFile,
    plugins: readonly AlgorithmPlugin[],
  ): { session: Session; warning: string | null } | OperationError {
    const plugin = plugins.find((p) => p.meta.id === file.pluginId);
    if (plugin === undefined) {
      return {
        code: 'PARSE_ERROR',
        message: `This simulation needs the "${file.pluginId}" structure, which this build does not have.`,
        hint: `available: ${plugins.map((p) => p.meta.id).join(', ')}`,
      };
    }

    const session = new Session(plugin, file.seed);
    for (const line of file.commands) session.run(line);

    const rejected = session.history.filter((h) => !h.ok).length;
    if (rejected > 0) {
      return {
        session,
        warning: `${rejected} of ${file.commands.length} saved commands no longer run.`,
      };
    }
    if (file.digest !== null && digestOf(session.#instance.serialize()) !== file.digest) {
      return {
        session,
        warning: 'Replaying produced a different structure than when this was saved - '
          + 'the algorithm has changed since.',
      };
    }
    return { session, warning: null };
  }

  /**
   * Why the current step happened. The plugin's explainer gets the command
   * that caused the event, so it can cite the actual arguments; where it
   * declines, the generic description shows through.
   */
  explanation(): string {
    const step = this.playback.step;
    const event = this.#timeline.eventAt(step - 1);
    if (event === undefined) return 'Run a command to begin.';

    const marks = this.#timeline.marks;
    const which = marks.findIndex((m) => step <= m.index);
    const command = which === -1 ? null : this.#commands[which] ?? null;

    const own = this.plugin.explain?.(event, {
      after: this.playback.scene(),
      command,
      step,
    });
    return own ?? describeEvent(event);
  }
}
