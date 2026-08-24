/**
 * Why each event happened, in bridge and cut vertex terms.
 *
 * The thing worth explaining is the equals sign. A bridge needs the subtree to
 * be unable to reach its parent at all; a cut vertex needs only that it cannot
 * reach *past* the parent. One comparison differs, and that is the whole
 * difference between an edge mattering and a vertex mattering.
 */

import type { SimEvent } from '@algoverse/core';
import type { ExplainContext, Explainer } from '@algoverse/plugin-sdk';

export const explainBridges: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;

  switch (event.kind) {
    case 'NodeAllocated':
      return `Vertex ${event.value} joins the graph. Whether it matters is not a property of the ` +
        `vertex but of how the rest of the graph reaches it, which is what the walk works out.`;

    case 'PointerSet': {
      if (event.to === null) return null;
      const from = ctx.after.nodes.get(event.from)?.value;
      const to = ctx.after.nodes.get(event.to)?.value;
      return `An edge joins ${from ?? '?'} and ${to ?? '?'}. The search will use it in one of only ` +
        `two ways - descending through it, or finding it leads back to somewhere already seen. ` +
        `In an undirected graph there is no third possibility, and that is why one pass is enough.`;
    }

    case 'NodeVisited': {
      const value = ctx.after.nodes.get(event.node)?.value;
      if (command === 'bridges') {
        return `Reaching ${value ?? '?'} for the first time. If nothing below it can find a way ` +
          `back up to here or higher, the edge it was reached by is on no cycle at all - and an ` +
          `edge on no cycle is the only kind whose loss splits the graph.`;
      }
      if (command === 'cuts') {
        return `Reaching ${value ?? '?'}. The question for its parent is whether anything under ` +
          `here can get *past* the parent. Getting back to the parent itself is not enough: that ` +
          `saves the edge, because the cycle runs through it, but it does not save the vertex.`;
      }
      if (command === 'numbers') {
        return `Vertex ${value ?? '?'}, with when it was reached and how far back it can climb.`;
      }
      return `At vertex ${value ?? '?'}.`;
    }

    case 'RootsSet':
      return `Every vertex is an entry point, because the graph may come in pieces. The walk starts ` +
        `again at each one, and the vertex it starts from is the single exception to the rule - ` +
        `having no parent, it matters only if it holds two branches together.`;

    case 'NodeReused':
    case 'NodeDeleted':
    case 'VersionCommitted':
      return null;

    default:
      return null;
  }
};
