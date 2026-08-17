/**
 * Why each event happened, in KMP terms.
 *
 * The thing worth explaining is that a border is not a trick - it is the exact
 * amount of already-read text that is still usable after a mismatch, so the
 * text pointer never has to move backwards.
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

export const explainKmp: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;

  switch (event.kind) {
    case 'NodeAllocated': {
      const letter = ctx.after.nodes.get(event.node)?.label ?? '?';
      return event.value === 0
        ? `"${letter}" ends a prefix with no border at all: nothing that starts this prefix also ` +
          `ends it, so a mismatch here has to begin again from the first letter.`
        : `"${letter}" ends a prefix whose first ${event.value} ` +
          `${event.value === 1 ? 'letter' : 'letters'} also finish it. A mismatch after this point ` +
          `can resume with those already matched, so nothing already read is read again.`;
    }

    case 'PointerSet': {
      if (event.to === null) return null;
      if (event.slot === 'next') return null;
      return `The failure link. On a mismatch here, the search continues as though it had matched ` +
        `just ${event.weight ?? '?'} ${event.weight === 1 ? 'letter' : 'letters'} - and following ` +
        `these links repeatedly lists every border of this prefix, each shorter than the last.`;
    }

    case 'NodeVisited': {
      const letter = ctx.after.nodes.get(event.node)?.label ?? '?';
      const border = ctx.after.nodes.get(event.node)?.value ?? 0;
      if (command === 'search') {
        const text = wordOf(ctx, 'text');
        return `Comparing the text against "${letter}". Whether this matches or not, the position ` +
          `in ${text === null ? 'the text' : `"${text}"`} moves forward - the only thing that ever ` +
          `moves back is how much of the pattern is considered matched, and it moves back to ` +
          `${border}.`;
      }
      if (command === 'borders') {
        return `The prefix ending at "${letter}" has a border of ${border}.`;
      }
      return `At "${letter}".`;
    }

    case 'RootsSet':
      return `The pattern is one run of letters with links back into itself. There is no text here ` +
        `at all - everything expensive was done before the text was even seen.`;

    case 'NodeReused':
    case 'NodeDeleted':
    case 'VersionCommitted':
      return null;

    default:
      return null;
  }
};
