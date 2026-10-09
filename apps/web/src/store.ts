/**
 * UI state only.
 *
 * Which plugin is loaded, what is selected, what is shown. The event log and
 * the current scene deliberately live in the engine - see `engine.ts`.
 */

import { create } from 'zustand';
import type { NodeId } from '@algoverse/core';

/**
 * `diff` compares two versions; `live` shows the structure as it stands.
 * `quiz` asks about the log already run; `challenge` asks for a structure.
 */
export type ViewMode = 'live' | 'diff' | 'complexity' | 'quiz' | 'challenge';

interface UiState {
  readonly pluginId: string;
  readonly selected: NodeId | null;
  readonly showLabels: boolean;
  readonly mode: ViewMode;
  /** Indices into the version list, resolved against the scene when drawing. */
  readonly diffA: number;
  readonly diffB: number;
  /** The challenge being played, when mode is `challenge`. */
  readonly challengeId: string | null;
  setPlugin: (id: string) => void;
  select: (id: NodeId | null) => void;
  toggleLabels: () => void;
  setMode: (mode: ViewMode) => void;
  setDiff: (a: number, b: number) => void;
  setChallenge: (id: string | null) => void;
}

export const useUi = create<UiState>((set) => ({
  pluginId: 'persistent-segment-tree',
  selected: null,
  showLabels: true,
  mode: 'live',
  diffA: 0,
  diffB: 1,
  challengeId: null,
  setPlugin: (pluginId) => set({ pluginId, selected: null, mode: 'live', diffA: 0, diffB: 1, challengeId: null }),
  select: (selected) => set({ selected }),
  toggleLabels: () => set((s) => ({ showLabels: !s.showLabels })),
  setMode: (mode) => set({ mode }),
  setDiff: (diffA, diffB) => set({ diffA, diffB }),
  setChallenge: (challengeId) => set({ challengeId }),
}));
