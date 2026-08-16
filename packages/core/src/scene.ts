/**
 * Replayed log to drawable structure.
 *
 * This is the join that makes the architecture's central claim true: the
 * picture is derived from the event log, not read out of the plugin. Scrub to
 * step 40 and what you see is what the structure was at step 40, reconstructed
 * rather than remembered.
 *
 * A plugin's `getStructure()` is the same shape, which is exactly why the
 * conformance kit can demand the two agree.
 */

import type { LayoutHint, StructureEdge, StructureGraph, StructureNode } from './structure.ts';
import type { SceneState } from './timeline.ts';

export function sceneToStructure(scene: SceneState, layoutHint: LayoutHint): StructureGraph {
  const nodes: StructureNode[] = [];
  const edges: StructureEdge[] = [];

  for (const [id, n] of scene.nodes) {
    nodes.push({
      id,
      label: n.label,
      value: n.value,
      ...(n.values === undefined ? {} : { values: n.values }),
      role: n.role,
      ...(n.depth === undefined ? {} : { depth: n.depth }),
      slot: n.slot,
      origin: n.origin,
    });
    for (const [slot, p] of n.pointers) {
      const target = scene.nodes.get(p.to);
      // A pointer to a deleted node is not drawable. Mid-operation states can
      // hold one briefly, so skip rather than fail.
      if (target === undefined) continue;
      edges.push({
        from: id,
        to: p.to,
        slot,
        reused: p.kind === 'child' && target.origin < n.origin,
        kind: p.kind,
        ...(p.weight === undefined ? {} : { weight: p.weight }),
        ...(p.directed === undefined ? {} : { directed: p.directed }),
      });
    }
  }

  return {
    layout: layoutHint,
    nodes,
    edges,
    roots: scene.roots.filter((r) => scene.nodes.has(r)),
  };
}
