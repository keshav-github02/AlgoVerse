/**
 * Why each event happened, in wavelet tree terms.
 *
 * The thing worth explaining is that a descent is not a search. Nothing is
 * compared against the query on the way down; the range of positions is
 * *recomputed* at each step from a count, and the answer is wherever it ends
 * up.
 */

import type { SimEvent } from '@algoverse/core';
import type { ExplainContext, Explainer } from '@algoverse/plugin-sdk';

export const explainWavelet: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;

  switch (event.kind) {
    case 'NodeAllocated': {
      const span = ctx.after.nodes.get(event.node)?.label ?? '?';
      if (event.role === 'value') {
        return `A leaf for the single value ${span}. Everything that reached it is equal, so the `
          + `width of a block of positions here is a count of occurrences and nothing more has to `
          + `be stored.`;
      }
      return event.role === 'root'
        ? `The root holds the whole sequence and the whole range of values, ${span}. Every level `
          + `below holds the same ${event.value} elements, cut into more pieces.`
        : `Values ${span}: the ${event.value} elements of the sequence that fall in this half, `
          + `still in the order they appeared. Keeping that order is the entire trick - it is why `
          + `a block of positions above is a block of positions here.`;
    }

    case 'PointerSet':
      return event.to === null
        ? null
        : `The ${event.slot} half. Splitting by value rather than by position is what lets a `
          + `question about which values are present be answered at all - a summary of a `
          + `contiguous block of positions could never say it.`;

    case 'NodeVisited': {
      const span = ctx.after.nodes.get(event.node)?.label ?? '?';
      switch (command) {
        case 'kth':
          return `At values ${span}. Counting how many of the elements in the current block went `
            + `left says whether the answer is below the midpoint. If it is not, the rank drops by `
            + `that count - every one of them is smaller than the answer, so they can all be `
            + `stepped over at once.`;
        case 'atmost':
          return `At values ${span}. Only one side is ever descended into: going right means every `
            + `element that went left is already known to qualify, and going left means nothing on `
            + `the right can.`;
        case 'count':
          return `At values ${span}, following the one path the value can be on. When the leaf is `
            + `reached the block of positions has narrowed to exactly its occurrences.`;
        case 'levels':
          return `Values ${span}.`;
        default:
          return `At values ${span}.`;
      }
    }

    case 'RootsSet':
      return `Built. Nothing in the tree will change again - the sequence is held once, and every `
        + `question is a walk from here of one step per level.`;

    case 'NodeReused':
    case 'NodeDeleted':
    case 'VersionCommitted':
      return null;

    default:
      return null;
  }
};
