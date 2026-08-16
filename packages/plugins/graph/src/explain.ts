/**
 * Why each event happened, in graph terms.
 *
 * The thing worth explaining is that depth first and breadth first differ by
 * one line - which end of the pending list you read from - and that every
 * consequence people quote about them follows from just that.
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

export const explainGraph: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;
  const start = argOf(ctx, 'from');

  switch (event.kind) {
    case 'NodeAllocated':
      return `Vertex ${event.value} joins the graph. It has no parent and no level - a graph is ` +
        `only vertices and the edges between them.`;

    case 'PointerSet': {
      if (event.to === null) return null;
      const from = ctx.after.nodes.get(event.from)?.value;
      const to = ctx.after.nodes.get(event.to)?.value;
      return `An edge joins ${from ?? '?'} and ${to ?? '?'}. Neither end owns the other, so this ` +
        `is a link rather than a tree edge, and layout will not read a level into it.`;
    }

    case 'NodeVisited': {
      const value = ctx.after.nodes.get(event.node)?.value;
      const degree = ctx.after.nodes.get(event.node)?.pointers.size ?? 0;
      if (command === 'components') {
        return `Vertex ${value ?? '?'} belongs to the piece being counted. Anything the walk ` +
          `cannot reach is a separate component.`;
      }
      if (command === 'dfs') {
        return `Vertex ${value ?? '?'} comes off the back of the stack, so the walk goes as deep ` +
          `as it can before it comes back for anything else.`;
      }
      if (command === 'bfs') {
        return `Vertex ${value ?? '?'} comes off the front of the queue, so everything one step ` +
          `from ${start ?? 'the start'} is seen before anything two steps away.`;
      }
      return `Visiting vertex ${value ?? '?'}${degree > 0 ? `, which has ${degree} edges` : ''}.`;
    }

    case 'RootsSet':
      return `Every vertex is an entry point: with no root, there is nowhere else for a drawing ` +
        `to start.`;

    case 'NodeReused':
    case 'NodeDeleted':
    case 'VersionCommitted':
      return null;

    default:
      return null;
  }
};
