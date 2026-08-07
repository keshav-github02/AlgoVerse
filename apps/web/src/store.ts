/**
 * UI state only.
 *
 * Which plugin is loaded, what is selected, what is shown. The event log and
 * the current scene deliberately live in the engine — see `engine.ts`.
 */

import { create } from 'zustand';
import type { NodeId } from '@algoverse/core';

interface UiState {
  readonly pluginId: string;
  readonly selected: NodeId | null;
  readonly showLabels: boolean;
  setPlugin: (id: string) => void;
  select: (id: NodeId | null) => void;
  toggleLabels: () => void;
}

export const useUi = create<UiState>((set) => ({
  pluginId: 'persistent-segment-tree',
  selected: null,
  showLabels: true,
  setPlugin: (pluginId) => set({ pluginId, selected: null }),
  select: (selected) => set({ selected }),
  toggleLabels: () => set((s) => ({ showLabels: !s.showLabels })),
}));
