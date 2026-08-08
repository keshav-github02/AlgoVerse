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
  readonly rootA: NodeId;
  readonly rootB: NodeId;
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
  const rootA = state.versions[a];
  const rootB = state.versions[b];
  if (rootA === undefined || rootB === undefined) return null;

  const diff = diffRoots(sceneToStructure(state, hint), rootA, rootB);
  const emphasis = new Map<NodeId, Emphasis>();
  for (const [id, where] of diff.membership) {
    emphasis.set(id, where === 'shared' ? 'primary' : where === 'neither' ? 'muted' : 'secondary');
  }
  return { diff, emphasis, rootA, rootB };
}
