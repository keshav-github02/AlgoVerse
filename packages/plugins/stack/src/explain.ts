/**
 * Why each event happened, in stack terms.
 *
 * Short, because a stack has little to justify. It exists mostly to show that
 * the explainer contract fits a structure with no history and no tree.
 */

import type { SimEvent } from '@algoverse/core';
import type { ExplainContext, Explainer } from '@algoverse/plugin-sdk';

export const explainStack: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  switch (event.kind) {
    case 'NodeAllocated':
      return event.depth === 0
        ? `${event.value} goes in as the first cell, so it is both the top and the bottom.`
        : `${event.value} goes on top, at depth ${event.depth}.`;

    case 'PointerSet':
      if (event.to === null) return `The removed cell drops its link so nothing points into freed memory.`;
      return `The new cell points down at the previous top — a stack is a chain, and only the ` +
        `head of it moves.`;

    case 'NodeDeleted': {
      const remaining = ctx.after.nodes.size;
      return remaining === 0
        ? `The last cell is freed and the stack is now empty.`
        : `The top cell is freed; the ${remaining} cell${remaining === 1 ? '' : 's'} below ` +
          `${remaining === 1 ? 'is' : 'are'} untouched.`;
    }

    case 'NodeVisited':
      return ctx.command?.name === 'peek'
        ? `Peek reads the top cell and changes nothing — which is why it counts as a read, not a write.`
        : `The top cell is read before being removed.`;

    case 'RootsSet':
      return event.roots.length === 0
        ? `No entry point left: the stack is empty.`
        : `The top of the stack is now node ${event.roots[0]}. Being on top is being the root.`;

    case 'NodeReused':
    case 'VersionCommitted':
      return null;

    default:
      return null;
  }
};
