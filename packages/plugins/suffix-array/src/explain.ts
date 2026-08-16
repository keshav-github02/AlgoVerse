/**
 * Why each event happened, in suffix array terms.
 *
 * The thing worth explaining is that the structure is just a sorted list, and
 * that sorting is the whole of what makes searching cheap: every occurrence of
 * a pattern ends up next to every other, because the suffixes that begin with
 * it are exactly the ones that sort together.
 */

import { getWord, type SimEvent } from '@algoverse/core';
import type { ExplainContext, Explainer } from '@algoverse/plugin-sdk';

function wordOf(ctx: ExplainContext, name: string): string | null {
  if (ctx.command === null) return null;
  try {
    return getWord(ctx.command, name);
  } catch {
    return null;
  }
}

export const explainSuffixArray: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;
  const pattern = wordOf(ctx, 'pattern');

  switch (event.kind) {
    case 'NodeAllocated':
      return `The suffix starting at position ${event.value} takes its place in sorted order. ` +
        `Sorting them was not done by comparing suffixes - each round ranked twice as much of ` +
        `every suffix as the last, using the previous round's ranks as the letters of the next.`;

    case 'PointerSet': {
      if (event.to === null) return null;
      const shared = event.weight ?? 0;
      const here = ctx.after.nodes.get(event.to)?.value;
      const before = ctx.after.nodes.get(event.from)?.value;
      return shared === 0
        ? `The suffixes at ${before ?? '?'} and ${here ?? '?'} are neighbours in sorted order and ` +
          `share nothing at all - they part company on their very first letter.`
        : `The suffixes at ${before ?? '?'} and ${here ?? '?'} share their first ${shared} ` +
          `${shared === 1 ? 'letter' : 'letters'}. That number belongs between them rather than ` +
          `to either one, which is why it is drawn on the edge.`;
    }

    case 'NodeVisited': {
      const start = ctx.after.nodes.get(event.node)?.value;
      if (command === 'find') {
        return `Comparing the pattern "${pattern ?? '?'}" against the suffix at ${start ?? '?'}. ` +
          `The list is sorted, so each comparison throws away half of what is left, and the number ` +
          `of matches never enters into it.`;
      }
      if (command === 'lrs') {
        return `Checking what this suffix shares with the one before it. The longest repeat must ` +
          `be shared by two suffixes that are neighbours here - anything two suffixes share, ` +
          `everything sorted between them shares as well - so one pass over these numbers is enough.`;
      }
      if (command === 'suffixes') {
        return `The suffix starting at ${start ?? '?'}, read in sorted order.`;
      }
      return `Reading the suffix at ${start ?? '?'}.`;
    }

    case 'RootsSet':
      return `The array is one run from smallest suffix to largest. There is no tree here and no ` +
        `pointers to follow - the order itself is the structure.`;

    case 'NodeReused':
    case 'NodeDeleted':
    case 'VersionCommitted':
      return null;

    default:
      return null;
  }
};
