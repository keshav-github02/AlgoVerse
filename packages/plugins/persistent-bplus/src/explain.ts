/**
 * Why each event happened, in B+ tree terms.
 *
 * The distinction worth explaining is between a key and a separator. A B-tree
 * stores data everywhere; a B+ tree keeps data in the leaves and uses the
 * interior only for directions, which is what makes the leaf chain possible.
 */

import { getInt, type SimEvent } from '@algoverse/core';
import type { ExplainContext, Explainer } from '@algoverse/plugin-sdk';
import { ORDER } from './plugin.ts';

const show = (keys: readonly number[] | undefined): string =>
  keys === undefined || keys.length === 0 ? 'an empty node' : `[${keys.join(' ')}]`;

function argOf(ctx: ExplainContext, name: string): number | null {
  if (ctx.command === null) return null;
  try {
    return getInt(ctx.command, name);
  } catch {
    return null;
  }
}

export const explainBplus: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;
  const target = argOf(ctx, 'key');

  switch (event.kind) {
    case 'NodeAllocated': {
      const keys = event.values;
      const leaf = event.role === 'leaf';
      if (command === 'build') {
        return leaf
          ? `${show(keys)} is a leaf, and leaves are the only place a key is actually stored.`
          : `${show(keys)} holds separators, not data. Each one only says which way to go.`;
      }
      return leaf
        ? `${show(keys)} is the rewritten leaf. A node may hold ${ORDER - 1} keys before it splits.`
        : `${show(keys)} is rewritten with new separators after the split below it.`;
    }

    case 'NodeVisited': {
      const node = ctx.after.nodes.get(event.node);
      const keys = node?.values;
      if (command === 'compare') return `${show(keys)} is shared by both versions.`;
      if (command === 'range') {
        return node?.role === 'leaf'
          ? `Reading ${show(keys)} along the chain. No second descent: once the first leaf is ` +
            `found, the rest are neighbours.`
          : `Descending through ${show(keys)} to find where the range starts.`;
      }
      if (node?.role === 'leaf') {
        return `${show(keys)} is a leaf, so the search ends here whether or not ` +
          `${target ?? 'the key'} is present. Every lookup costs the full height.`;
      }
      return `${show(keys)} points the way: ${target ?? 'the key'} decides which child to take.`;
    }

    case 'NodeReused': {
      const keys = ctx.after.nodes.get(event.node)?.values;
      return `${show(keys)} is off the insert path, so the rewritten parent points at it ` +
        `rather than copying it.`;
    }

    case 'VersionCommitted': {
      const leaves = [...ctx.after.nodes.values()].filter((n) => n.role === 'leaf').length;
      return event.version === 0
        ? `Version 0 is complete, with every key in one of its ${leaves} leaves.`
        : `Version ${event.version} is complete, sharing every node the insert did not touch ` +
          `with v${event.version - 1}.`;
    }

    case 'PointerSet': {
      if (event.to === null) return null;
      const child = ctx.after.nodes.get(event.to);
      const parent = ctx.after.nodes.get(event.from);
      if (child === undefined || parent === undefined) return null;
      return child.origin < parent.origin
        ? `The rewritten node keeps v${child.origin}'s child in slot ${event.slot}.`
        : `The rewritten node links to its child in slot ${event.slot}.`;
    }

    case 'RootsSet':
    case 'NodeDeleted':
      return null;

    default:
      return null;
  }
};
