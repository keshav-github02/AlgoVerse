/**
 * Why each event happened, in merge sort tree terms.
 *
 * The thing worth explaining is where the second logarithm comes from. It is
 * not in how the traversal is written - that part is an ordinary segment tree
 * walk. It is that a node knows the *order* of its values and nothing else, so
 * every question about them has to be bisected for.
 */

import type { SimEvent } from '@algoverse/core';
import type { ExplainContext, Explainer } from '@algoverse/plugin-sdk';

export const explainMergeSort: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;

  switch (event.kind) {
    case 'NodeAllocated': {
      const span = ctx.after.nodes.get(event.node)?.label ?? '?';
      if (event.role === 'position') {
        return `Position ${span}, holding its one value. A run of one is sorted already, which is `
          + `where every merge below starts from.`;
      }
      return event.role === 'root'
        ? `The root: positions ${span}, the whole sequence sorted. A merge sort would have made `
          + `exactly this list and then discarded everything under it.`
        : `Positions ${span}, sorted - the merge of the two runs below. Keeping it is the only `
          + `difference between this and a merge sort that throws its work away.`;
    }

    case 'PointerSet':
      return event.to === null
        ? null
        : `The ${event.slot} half of this block of positions. The tree over positions is an `
          + `ordinary segment tree; all that is unusual is how much each node holds.`;

    case 'NodeVisited': {
      const span = ctx.after.nodes.get(event.node)?.label ?? '?';
      switch (command) {
        case 'atmost':
        case 'count':
          return `Consulting positions ${span}. Each of these is one step of a bisection through `
            + `that node's sorted run: the node knows the order of its values and nothing more, so `
            + `the count has to be searched for. A logarithm of nodes, a logarithm inside each.`;
        case 'kth':
          return `Consulting positions ${span}, inside a counting query, inside a binary search `
            + `for the answer. Three logarithms - and the wavelet tree answers the same question `
            + `in a single descent, because splitting by value tells it which values are there.`;
        case 'runs':
          return `Positions ${span}.`;
        default:
          return `At positions ${span}.`;
      }
    }

    case 'RootsSet':
      return `Built, and nothing will change again. Every level holds the whole sequence, so the `
        + `space is n numbers per level - the cost of keeping the merges rather than the answer.`;

    case 'NodeReused':
    case 'NodeDeleted':
    case 'VersionCommitted':
      return null;

    default:
      return null;
  }
};
