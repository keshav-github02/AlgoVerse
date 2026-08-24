/**
 * Why each event happened, in suffix automaton terms.
 *
 * The thing worth explaining is that a state is not a position and not a
 * string. It is a set of strings that nothing can tell apart from here on, and
 * every operation makes sense only once that is believed.
 */

import type { SimEvent } from '@algoverse/core';
import type { ExplainContext, Explainer } from '@algoverse/plugin-sdk';

export const explainSuffixAutomaton: Explainer = (
  event: SimEvent, ctx: ExplainContext,
): string | null => {
  const command = ctx.command?.name ?? null;

  switch (event.kind) {
    case 'NodeAllocated': {
      if (event.value === 0) {
        return `The start state, standing for the empty string. Every substring of the word is a `
          + `walk from here, and nothing else is.`;
      }
      if (event.role === 'split') {
        return `A state from a split. The one it was cut out of was standing for strings of `
          + `several lengths that used to end in the same places; they do not any more, so the `
          + `shorter ones - up to ${event.value} letters - move here, and keep every transition `
          + `the original had.`;
      }
      return `A state for the word read so far, ${event.value} letters of it. Its class will grow `
        + `to hold every string that ends where this one does, which is why there are fewer states `
        + `than substrings.`;
    }

    case 'PointerSet': {
      if (event.to === null) return null;
      if (event.slot === 'link') {
        return event.weight === 0
          ? `The suffix link goes to the start state: no shorter suffix of this string is in a `
            + `class of its own, because none of them has been seen before.`
          : `The suffix link, to the class of the longest suffix that belongs somewhere else - `
            + `${event.weight} letters. Walking these from any state lists the suffixes of its `
            + `strings, each shorter than the last, and that is the walk the construction uses.`;
      }
      return `A transition on "${event.slot.slice(1)}". Adding it while walking back through the `
        + `suffixes is what the construction spends its time on, and every one added stays - which `
        + `is why reading the whole word costs one pass and not one per letter.`;
    }

    case 'NodeVisited': {
      const len = ctx.after.nodes.get(event.node)?.value ?? 0;
      if (command === 'build') {
        return len === 0
          ? `Back at the start state: every suffix of what was read is missing this letter, so `
            + `there is nothing shorter left to try.`
          : `At the class of a ${len}-letter string, walking back through shorter and shorter `
            + `suffixes. The walk stops at the first one that already has this letter, and what `
            + `is found there decides whether a state has to be split.`;
      }
      if (command === 'contains' || command === 'occurrences') {
        return `One letter further in, now at the class of a ${len}-letter string. There is no `
          + `backtracking here at all - a substring either walks or it does not.`;
      }
      return `A class whose longest string is ${len} letters.`;
    }

    case 'RootsSet':
      return `Finished, in one pass over the word. The automaton accepts exactly the substrings, `
        + `and every question about them is now a walk of at most the length of the question.`;

    case 'NodeReused':
    case 'NodeDeleted':
    case 'VersionCommitted':
      return null;

    default:
      return null;
  }
};
