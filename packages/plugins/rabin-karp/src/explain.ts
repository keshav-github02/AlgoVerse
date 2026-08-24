/**
 * Why each event happened, in Rabin-Karp terms.
 *
 * The thing worth explaining is that a hash comparison is evidence and not
 * proof, so every visit to the pattern during a search is a verification -
 * the algorithm checking whether the number it trusted was telling the truth.
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

export const explainRabinKarp: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;

  switch (event.kind) {
    case 'NodeAllocated': {
      const letter = ctx.after.nodes.get(event.node)?.label ?? '?';
      return event.order === 0
        ? `The first letter, so the hash so far is just "${letter}" itself, as a number: `
          + `${event.value}.`
        : `Everything hashed so far is shifted up by one place and "${letter}" is added at the `
          + `bottom, giving ${event.value}. Shifting is what makes position matter - without it, `
          + `any rearrangement of the same letters would hash alike.`;
    }

    case 'PointerSet':
      return event.to === null
        ? null
        : `One step along the pattern multiplies the running hash by ${event.weight ?? '?'}. `
          + `Running it backwards is what lets a window be rolled: the leaving letter is worth `
          + `that factor raised to the pattern's length, so it can be subtracted off.`;

    case 'NodeReused':
      return `Rehashed under the new modulus. The pattern has not changed, but its hash has - so `
        + `it has to be recomputed, or a search would compare the old number against new windows `
        + `and find nothing.`;

    case 'NodeVisited': {
      const letter = ctx.after.nodes.get(event.node)?.label ?? '?';
      if (command === 'search') {
        const text = wordOf(ctx, 'text');
        return `A window's hash matched the pattern's, so the letters are being checked: `
          + `is this one really "${letter}"? Every one of these comparisons is the price of `
          + `trusting a number${text === null ? '' : ` about "${text}"`}, and a hash that lies `
          + `costs the full length of the pattern before it is caught.`;
      }
      if (command === 'hashes') {
        return `Position holding "${letter}", whose running hash is `
          + `${ctx.after.nodes.get(event.node)?.value ?? 0}.`;
      }
      if (command === 'modulus') {
        return `"${letter}" again, under the new modulus.`;
      }
      return `At "${letter}".`;
    }

    case 'RootsSet':
      return `The pattern is one run of letters, and the only thing carried forward from it is a `
        + `single number. That is why one pass can hunt for many patterns at once - a set of `
        + `numbers costs no more to consult than one.`;

    case 'NodeDeleted':
    case 'VersionCommitted':
      return null;

    default:
      return null;
  }
};
