/**
 * Why each event happened, in spanning tree terms.
 *
 * The thing worth explaining is the cut property, because both algorithms are
 * the same one idea applied differently: the cheapest edge across any split of
 * the vertices is safe to take, and neither ever has to reconsider.
 */

import type { SimEvent } from '@algoverse/core';
import type { ExplainContext, Explainer } from '@algoverse/plugin-sdk';

export const explainMst: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;

  switch (event.kind) {
    case 'NodeAllocated':
      return `Vertex ${event.value} joins the graph. Nothing about it is a tree yet - a spanning ` +
        `tree is chosen from the edges, and the vertices are simply what has to be held together.`;

    case 'PointerSet': {
      if (event.to === null) return null;
      const from = ctx.after.nodes.get(event.from)?.value;
      const to = ctx.after.nodes.get(event.to)?.value;
      return `An edge joins ${from ?? '?'} and ${to ?? '?'} at a cost of ${event.weight ?? '?'}. ` +
        `Both directions are the same edge here: a spanning tree has no sense of direction.`;
    }

    case 'NodeVisited': {
      const value = ctx.after.nodes.get(event.node)?.value;
      if (command === 'prim') {
        return `Looking at what it would cost to reach ${value ?? '?'} from the tree so far. The ` +
          `cheapest of these is the cheapest edge crossing the line between reached and ` +
          `unreached, and the cut property says such an edge is always safe to take.`;
      }
      if (command === 'kruskal') {
        return `An end of the next cheapest edge. The only question asked about ${value ?? '?'} is ` +
          `which piece it is currently in - if the two ends are in different pieces, this edge is ` +
          `the cheapest across the split between them, and so it is safe.`;
      }
      return `At vertex ${value ?? '?'}.`;
    }

    case 'RootsSet':
      return `Every vertex is an entry point. The graph may come in several pieces, and then there ` +
        `is no spanning tree at all - only one tree per piece, which is a forest.`;

    case 'NodeReused':
    case 'NodeDeleted':
    case 'VersionCommitted':
      return null;

    default:
      return null;
  }
};
