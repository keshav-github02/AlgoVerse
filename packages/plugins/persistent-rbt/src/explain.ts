/**
 * Why each event happened, in red-black terms.
 *
 * The thing worth explaining is that the colour is not decoration. A new node
 * is red because black would break the counting rule at once, and everything
 * the algorithm then does is repairing the one rule red can break.
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

export const explainRbt: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;
  const key = argOf(ctx, 'key');

  switch (event.kind) {
    case 'NodeAllocated': {
      const red = event.role === 'red';
      if (red) {
        return `Node ${event.value} is allocated red. A new node is always red: black would add ` +
          `one to the count of black nodes on its path and no others, which breaks the rule that ` +
          `every path holds the same number. Red risks only the weaker rule - no red under red - ` +
          `and that one is repairable on the way back up.`;
      }
      return `Node ${event.value} is allocated black, as part of a repair. Turning a node black ` +
        `is how a red-under-red pair is settled: the pair becomes one black node with two red ` +
        `children, which leaves every path's black count exactly as it was.`;
    }

    case 'PointerSet': {
      if (event.to === null) return null;
      const child = ctx.after.nodes.get(event.to)?.value;
      const parent = ctx.after.nodes.get(event.from)?.value;
      return `${parent ?? '?'} points ${event.slot} at ${child ?? '?'}. Only the nodes along the ` +
        `path being written are new; everything hanging off to the side is the same memory the ` +
        `earlier version is still using.`;
    }

    case 'NodeReused':
      return `This subtree is untouched, so it is shared rather than copied. A write costs the ` +
        `path it rewrites and nothing else, which is what makes keeping every version affordable.`;

    case 'NodeVisited': {
      const value = ctx.after.nodes.get(event.node)?.value;
      if (command === 'find') {
        return `Comparing ${key ?? 'the key'} against ${value ?? '?'}. The depth is bounded at ` +
          `twice the shortest path, so this walk is logarithmic however the keys arrived.`;
      }
      if (command === 'compare') {
        return `Node ${value ?? '?'} is in both versions - one node, pointed at twice.`;
      }
      if (command === 'erase') {
        return `Walking past ${value ?? '?'} on the way to ${key ?? 'the key'}. Removing a black ` +
          `node leaves its path one black short, and that shortfall has to be carried back up ` +
          `through here.`;
      }
      return `Walking past ${value ?? '?'} to find where ${key ?? 'the key'} belongs.`;
    }

    case 'VersionCommitted':
      return `Version v${event.version} is committed, and its root is painted black. Blackening ` +
        `the root can never break anything: it adds one to every path's count at once.`;

    case 'RootsSet':
    case 'NodeDeleted':
      return null;

    default:
      return null;
  }
};
