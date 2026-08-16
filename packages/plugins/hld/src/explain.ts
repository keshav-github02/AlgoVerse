/**
 * Why each event happened, in decomposition terms.
 *
 * The thing worth explaining is that one rule - the edge to the largest child
 * is heavy - produces the whole logarithmic bound, and that it does so for a
 * reason anyone can check: stepping down a light edge at least halves the
 * subtree you are standing in.
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

export const explainHld: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;
  const a = argOf(ctx, 'a');
  const b = argOf(ctx, 'b');

  switch (event.kind) {
    case 'NodeAllocated': {
      if (event.role === 'chain head') {
        return `Vertex ${event.value} starts a chain. It is here because the edge from its parent ` +
          `is light - it is not its parent's largest child - and every light edge begins a new ` +
          `chain.`;
      }
      return `Vertex ${event.value} continues the chain above it, reached by a heavy edge. A whole ` +
        `chain is laid down before any light child is started, which is what puts it in one ` +
        `unbroken run of the array.`;
    }

    case 'PointerSet': {
      if (event.to === null) return null;
      const child = ctx.after.nodes.get(event.to)?.value;
      const parent = ctx.after.nodes.get(event.from)?.value;
      if (event.slot === 'heavy') {
        return `${parent ?? '?'} to ${child ?? '?'} is the heavy edge: of ${parent ?? '?'}'s ` +
          `children, ${child ?? '?'} has the largest subtree. There is exactly one per vertex.`;
      }
      return `${parent ?? '?'} to ${child ?? '?'} is a light edge. ${child ?? '?'} is not the ` +
        `largest child, so its subtree is less than half of ${parent ?? '?'}'s - if it were more, ` +
        `it would have been the largest. That halving is why no path crosses more than log2(n) ` +
        `light edges.`;
    }

    case 'NodeVisited': {
      const value = ctx.after.nodes.get(event.node)?.value;
      if (command === 'chains') {
        return `Vertex ${value ?? '?'} sits at its place in the flattened array. Reading the array ` +
          `end to end reads the chains one after another.`;
      }
      if (command === 'lca') {
        return `Climbing past ${value ?? '?'}. Each step jumps over a whole chain at once and ` +
          `crosses one light edge, so ${a ?? 'one'} and ${b ?? 'the other'} meet in a logarithmic ` +
          `number of steps however deep the tree is.`;
      }
      if (command === 'path') {
        return `Vertex ${value ?? '?'} is inside one of the ranges the path decomposed into. The ` +
          `range is contiguous in the array, so the segment tree answers all of it at once - the ` +
          `walk shown here is what the decomposition avoids having to do.`;
      }
      if (command === 'set') {
        return `Vertex ${value ?? '?'} has one position in the array, so changing its value is one ` +
          `segment tree update and nothing about the decomposition changes.`;
      }
      return `Visiting vertex ${value ?? '?'}.`;
    }

    case 'RootsSet':
      return `The tree is rooted at its lowest label. A decomposition needs a root: heavy and ` +
        `light only mean something once every edge has a parent end and a child end.`;

    case 'NodeReused':
    case 'NodeDeleted':
    case 'VersionCommitted':
      return null;

    default:
      return null;
  }
};
