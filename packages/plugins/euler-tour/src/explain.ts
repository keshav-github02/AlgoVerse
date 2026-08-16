/**
 * Why each event happened, in Euler tour terms.
 *
 * The thing worth explaining is that nothing here ever touches a tree. Every
 * operation is a split or a join of a sequence, and the tree changes shape as
 * a consequence.
 */

import { getInt, type SimEvent } from '@algoverse/core';
import type { ExplainContext, Explainer } from '@algoverse/plugin-sdk';

function argOf(ctx: ExplainContext, name: string): number | null {
  if (ctx.command === null) return null;
  try {
    return getInt(ctx.command, name);
  } catch {
    return null;
  }
}

export const explainEuler: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;
  const a = argOf(ctx, 'a');
  const b = argOf(ctx, 'b');

  switch (event.kind) {
    case 'NodeAllocated': {
      if (event.role === 'edge') {
        return `An occurrence of the edge is added to the tour. Every edge appears twice, once ` +
          `for each direction, and everything between those two occurrences is the subtree below ` +
          `it - which is what makes cutting an edge the same thing as lifting out a block.`;
      }
      return `Vertex ${event.value} joins the tour. A vertex appears exactly once, so a tree of k ` +
        `vertices is a sequence of 3k - 2 entries: k vertices and two per edge.`;
    }

    case 'NodeDeleted':
      return `An edge occurrence is dropped. With both of its occurrences gone, the two halves of ` +
        `the sequence either side rejoin, and the block that was between them is now a tour of ` +
        `its own - one tree has become two.`;

    case 'PointerSet': {
      if (event.to === null) return null;
      return `The treap rearranges. Position, not value, is what it is ordered by: the entries ` +
        `read left to right are the tour, and the shape above them only exists to make splitting ` +
        `and joining logarithmic.`;
    }

    case 'NodeVisited': {
      const value = ctx.after.nodes.get(event.node)?.value;
      if (command === 'connected') {
        return `Climbing from ${value ?? '?'} towards the top of its treap. Whether ${a ?? 'one'} ` +
          `and ${b ?? 'the other'} are in the same tree is exactly whether this walk and the other ` +
          `one end at the same place - the tree is never looked at.`;
      }
      if (command === 'tour') {
        return `Entry for ${value ?? '?'}, in the order the tour visits it.`;
      }
      if (command === 'cut') {
        return `Finding where the edge sits in its sequence, so the block between its two ` +
          `occurrences can be lifted out.`;
      }
      return `Reading entry ${value ?? '?'}.`;
    }

    case 'RootsSet':
      return `One entry point per tree. Two trees are two sequences, and there is no way to get ` +
        `from one to the other - which is the whole answer to whether their vertices are ` +
        `connected.`;

    case 'NodeReused':
    case 'VersionCommitted':
      return null;

    default:
      return null;
  }
};
