/**
 * Version comparison logic, kept out of the component so it can be checked
 * without a browser - and so the rule below lives somewhere testable.
 */

import {
  diffRoots, sceneToStructure,
  type LayoutHint, type NodeId, type RootDiff, type SceneState,
} from '@algoverse/core';
import type { Emphasis } from '@algoverse/renderer';

export interface DiffResult {
  readonly diff: RootDiff;
  readonly emphasis: ReadonlyMap<NodeId, Emphasis>;
  readonly rootsA: readonly NodeId[];
  readonly rootsB: readonly NodeId[];
}

/**
 * Shared nodes read loudest. The reuse is the point of the comparison - the
 * handful of nodes that differ are the cheap part to see.
 */
export function computeDiff(
  state: SceneState,
  hint: LayoutHint,
  a: number,
  b: number,
): DiffResult | null {
  const rootsA = state.versions[a];
  const rootsB = state.versions[b];
  if (rootsA === undefined || rootsB === undefined) return null;

  const diff = diffRoots(sceneToStructure(state, hint), rootsA, rootsB);
  const emphasis = new Map<NodeId, Emphasis>();
  for (const [id, where] of diff.membership) {
    emphasis.set(id, where === 'shared' ? 'primary' : where === 'neither' ? 'muted' : 'secondary');
  }
  return { diff, emphasis, rootsA, rootsB };
}
