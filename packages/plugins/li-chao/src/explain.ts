/**
 * Why each event happened, in Li Chao terms.
 *
 * The thing worth explaining is that every decision the structure makes comes
 * from one fact about straight lines: two of them cross at most once. Knowing
 * which is better at two points is therefore enough to know which half of the
 * range the other one could still win.
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

export const explainLiChao: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;
  const x = argOf(ctx, 'x');

  switch (event.kind) {
    case 'NodeAllocated': {
      const line = ctx.after.nodes.get(event.node)?.label ?? 'the line';
      if (event.role === 'leaf') {
        return `At a single x there is no half to push anything into, so the better of the two ` +
          `lines is kept and the other is dropped. ${line} wins here.`;
      }
      return `${line} is kept for this range: of the two lines compared, it is the lower one at ` +
        `the midpoint. The other is not thrown away - it is pushed into whichever half it could ` +
        `still be winning in.`;
    }

    case 'NodeVisited': {
      const line = ctx.after.nodes.get(event.node)?.label ?? '?';
      if (command === 'query') {
        return `${line} is one of the candidates at x = ${x ?? '?'}. Every line that could be ` +
          `lowest here sits somewhere on this one path, which is why the answer needs a walk ` +
          `down and no search.`;
      }
      if (command === 'compare') {
        return `This node is in both versions - the same node, not a copy.`;
      }
      return `Comparing against ${line}, the line already held here. Two comparisons decide ` +
        `everything: at the midpoint, to see which to keep, and at the left edge, to see which ` +
        `half the loser could still win.`;
    }

    case 'NodeReused':
      return `The loser went down the other side, so this half is untouched and the new version ` +
        `points straight at it. Adding a line costs one path, exactly like writing one index.`;

    case 'PointerSet':
      return null;

    case 'VersionCommitted':
      return event.roots.length === 0
        ? `An empty tree over the range. A Li Chao tree allocates nothing until a line arrives - ` +
          `there is no shape to build in advance, only a range to build it over.`
        : `Version v${event.version} is committed. The lines from every earlier version are still ` +
          `in it: nothing here is ever removed, because a line that has been beaten everywhere ` +
          `simply stops being the answer anywhere.`;

    case 'RootsSet':
    case 'NodeDeleted':
      return null;

    default:
      return null;
  }
};
