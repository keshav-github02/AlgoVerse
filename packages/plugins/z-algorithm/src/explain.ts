/**
 * Why each event happened, in Z terms.
 *
 * The thing worth explaining is the interval: one remembered match, reaching as
 * far right as anything has so far, is the entire reason this is linear.
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

export const explainZ: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;

  switch (event.kind) {
    case 'NodeAllocated': {
      const letter = ctx.after.nodes.get(event.node)?.label ?? '?';
      if (event.role === 'whole') {
        return `The first position matches the whole string against itself, which is the length. ` +
          `It is never used as an answer - it is the thing every other position is compared to.`;
      }
      if (event.role === 'copied') {
        return `"${letter}" begins a repeat of ${event.value} ` +
          `${event.value === 1 ? 'letter' : 'letters'}, and most of that was not compared for. ` +
          `This position sits inside a match already found, so it looks like an earlier position ` +
          `and can borrow its answer.`;
      }
      return event.value === 0
        ? `"${letter}" does not start the string again at all - it differs from the first letter, ` +
          `and one comparison settles it.`
        : `"${letter}" begins a repeat of ${event.value} ` +
          `${event.value === 1 ? 'letter' : 'letters'}, found by comparing. Every comparison here ` +
          `either ends this position or pushes the furthest match further right, and it only ever ` +
          `moves right - which is why the whole pass is linear.`;
    }

    case 'PointerSet': {
      if (event.to === null || event.slot === 'next') return null;
      return `Copied from position ${ctx.after.nodes.get(event.to)?.value ?? '?'}'s letter, ` +
        `because both sit the same distance into the same repeat. Nothing was compared to get ` +
        `the first ${event.weight ?? '?'} of it.`;
    }

    case 'NodeVisited': {
      const letter = ctx.after.nodes.get(event.node)?.label ?? '?';
      const z = ctx.after.nodes.get(event.node)?.value ?? 0;
      if (command === 'find') {
        const pattern = wordOf(ctx, 'pattern');
        return `Checking whether the pattern starts here. The pass ran over ` +
          `${pattern === null ? 'the pattern' : `"${pattern}"`}, a separator, and the text as one ` +
          `string - so an occurrence is just a position whose value reaches the pattern's length.`;
      }
      if (command === 'borders') {
        return `Turning this position's value into a border. A repeat that starts here and runs ` +
          `z letters means the prefix ending z - 1 further on begins and ends the same way.`;
      }
      return `Position "${letter}", which starts ${z} of the beginning again.`;
    }

    case 'RootsSet':
      return `One run of letters, each carrying a number. There is no tree - the array is the ` +
        `whole structure, and the links only record which answers were free.`;

    case 'NodeReused':
    case 'NodeDeleted':
    case 'VersionCommitted':
      return null;

    default:
      return null;
  }
};
