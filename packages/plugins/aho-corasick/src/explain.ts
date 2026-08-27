/**
 * Why each event happened, in Aho-Corasick terms.
 *
 * The thing worth explaining is that a failure link is not a fallback in the
 * sense of a retry. It is a statement about the text already read: everything
 * matched so far still matches, just less of it, and the link says how much.
 */

import type { SimEvent } from '@algoverse/core';
import type { ExplainContext, Explainer } from '@algoverse/plugin-sdk';

export const explainAhoCorasick: Explainer = (
  event: SimEvent, ctx: ExplainContext,
): string | null => {
  const command = ctx.command?.name ?? null;

  switch (event.kind) {
    case 'NodeAllocated':
      return event.value === 0
        ? `The root: no letters read yet, and where the walk returns when a letter appears in no `
          + `word at all.`
        : `A state for "${event.label}" at depth ${event.value}. It stands for one string - the `
          + `letters on the way down to it - and it is shared by every word beginning that way, `
          + `which is the only reason a trie is smaller than the words it holds.`;

    case 'NodeUpdated':
      return `This state is the end of a word now. It was drawn as an ordinary state because it `
        + `was one until this letter arrived: whether a state finishes a word is not known while `
        + `the word is still being read, and it changes what the state is rather than merely what `
        + `it holds.`;

    case 'PointerSet': {
      if (event.to === null) return null;
      if (event.slot === 'fail') {
        return event.weight === undefined || event.weight === 0
          ? `The failure link goes to the root: no proper suffix of this state's string begins any `
            + `word, so a mismatch here leaves nothing of what was read still usable.`
          : `The failure link, to a state ${event.weight} ${event.weight === 1 ? 'letter' : 'letters'} `
            + `long. That is the longest suffix of what has been read which is also the start of `
            + `some word - so on a mismatch the text pointer does not move back, only the amount `
            + `considered matched does.`;
      }
      if (event.slot === 'out') {
        return `An output link, skipping straight to the next state along the failure chain that `
          + `actually ends a word. Without it, listing what matches at a position means walking `
          + `the whole chain and finding nothing most of the way.`;
      }
      return `A trie edge on "${event.slot.slice(1)}". Following these from the root spells out `
        + `the prefixes of the words, one letter at a time.`;
    }

    case 'NodeVisited': {
      const depth = ctx.after.nodes.get(event.node)?.value ?? 0;
      const letter = ctx.after.nodes.get(event.node)?.label ?? '?';
      if (command === 'search' || command === 'count') {
        return depth === 0
          ? `Back at the root. Nothing read so far is the beginning of any word, so the walk `
            + `starts again from here - but the text pointer has not moved back at all.`
          : `At the state for a ${depth}-letter string, arrived at by "${letter}". This is the `
            + `longest prefix of any word that ends where the text has been read to.`;
      }
      if (command === 'links') {
        return `The state for a ${depth}-letter string.`;
      }
      return `At "${letter}".`;
    }

    case 'RootsSet':
      return `The automaton is finished, and the words are not looked at again. Everything after `
        + `this is one pass over a text, and its cost does not depend on how many words there `
        + `were - only on how long the text is.`;

    case 'NodeReused':
    case 'NodeDeleted':
    case 'VersionCommitted':
      return null;

    default:
      return null;
  }
};
