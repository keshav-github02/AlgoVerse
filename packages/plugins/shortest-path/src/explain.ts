/**
 * Why each event happened, in shortest-path terms.
 *
 * The idea worth explaining is why Dijkstra can settle a vertex and never look
 * at it again: once the nearest unsettled vertex is chosen, no later route can
 * be shorter, because every edge only ever adds.
 */

import type { SimEvent } from '@algoverse/core';
import type { ExplainContext, Explainer } from '@algoverse/plugin-sdk';

export const explainShortestPath: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;

  switch (event.kind) {
    case 'NodeAllocated':
      return `Vertex ${event.value} joins the graph.`;

    case 'PointerSet': {
      if (event.to === null) return null;
      const from = ctx.after.nodes.get(event.from)?.value;
      const to = ctx.after.nodes.get(event.to)?.value;
      return `${from ?? '?'} and ${to ?? '?'} are joined at a cost of ${event.weight ?? '?'}. ` +
        `The weight is on the edge, not on either vertex, which is what makes it a shortest-path ` +
        `problem rather than a reachability one.`;
    }

    case 'NodeVisited': {
      const value = ctx.after.nodes.get(event.node)?.value;
      if (command === 'path') {
        return `Vertex ${value ?? '?'} is read while looking for the nearest unsettled one. ` +
          `Finding the route means settling the graph first; the route is read backwards afterwards.`;
      }
      return `Vertex ${value ?? '?'} is read while scanning for the nearest unsettled vertex. ` +
        `Every scan reads every remaining vertex, which is the whole of the O(V²) - a heap would ` +
        `read one.`;
    }

    case 'RootsSet':
      return `Every vertex is an entry point; a weighted graph has no root either.`;

    case 'NodeReused':
    case 'NodeDeleted':
    case 'VersionCommitted':
      return null;

    default:
      return null;
  }
};
