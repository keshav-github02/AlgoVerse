/**
 * Why each event happened, in directed-graph terms.
 *
 * The thing worth explaining is that `scc` and `topo` are the same question
 * asked from either side: an order exists precisely when no group of vertices
 * can all reach each other, and the groups that can are what block it.
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

export const explainDirected: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;
  const start = argOf(ctx, 'from');

  switch (event.kind) {
    case 'NodeAllocated':
      return `Vertex ${event.value} joins the graph. It has no level and no parent - what it does ` +
        `have is a direction on each of its edges, which is the whole difference here.`;

    case 'PointerSet': {
      if (event.to === null) return null;
      const from = ctx.after.nodes.get(event.from)?.value;
      const to = ctx.after.nodes.get(event.to)?.value;
      return `An edge runs from ${from ?? '?'} to ${to ?? '?'}, and not back. In a tree the parent ` +
        `is simply the one drawn higher up; here the two vertices sit side by side, so the ` +
        `direction has to be drawn as an arrowhead or it is lost.`;
    }

    case 'NodeVisited': {
      const value = ctx.after.nodes.get(event.node)?.value;
      const out = ctx.after.nodes.get(event.node)?.pointers.size ?? 0;
      if (command === 'topo') {
        return `Vertex ${value ?? '?'} has nothing left pointing at it, so it can be placed now. ` +
          `Taking it removes its edges, which may free ${out === 0 ? 'nothing' : `its ${out} targets`} ` +
          `to follow.`;
      }
      if (command === 'scc') {
        return `The search reaches vertex ${value ?? '?'}. It is put on the stack and kept there ` +
          `until something proves whether it can get back to where it came from.`;
      }
      if (command === 'reach') {
        return `Vertex ${value ?? '?'} is reachable from ${start ?? 'the source'} by following ` +
          `arrows forwards. Reaching it says nothing about getting back.`;
      }
      return `Visiting vertex ${value ?? '?'}${out > 0 ? `, which has ${out} outgoing edges` : ''}.`;
    }

    case 'RootsSet':
      return `Every vertex is an entry point. Even a graph with one obvious start has vertices ` +
        `nothing points at, and a drawing has to place those too.`;

    case 'NodeReused':
    case 'NodeDeleted':
    case 'VersionCommitted':
      return null;

    default:
      return null;
  }
};
