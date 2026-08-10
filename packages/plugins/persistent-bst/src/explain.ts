/**
 * Why each event happened, in search-tree terms.
 *
 * The thing worth explaining here is what is *missing*: nothing rebalances, so
 * every sentence about shape traces back to the order the keys arrived in.
 */

import { getInt, type NodeId, type SceneState, type SimEvent } from '@algoverse/core';
import type { ExplainContext, Explainer } from '@algoverse/plugin-sdk';

/** Slots are written `k<key>` by this plugin, so it can read them back. */
function keyOf(state: SceneState, id: NodeId): number | null {
  const slot = state.nodes.get(id)?.slot;
  if (slot === undefined || !slot.startsWith('k')) return null;
  const parsed = Number(slot.slice(1));
  return Number.isFinite(parsed) ? parsed : null;
}

function argOf(ctx: ExplainContext, name: string): number | null {
  if (ctx.command === null) return null;
  try {
    return getInt(ctx.command, name);
  } catch {
    return null;
  }
}

export const explainBst: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;
  const target = argOf(ctx, 'key');

  switch (event.kind) {
    case 'NodeAllocated': {
      if (command === 'build') {
        return `Key ${event.value} takes the first free spot on its search path. Nothing ` +
          `rebalances afterwards, so where it lands is decided entirely by the keys before it.`;
      }
      if (event.value === target) {
        return `Key ${event.value} is added as a leaf, wherever the search for it ended.`;
      }
      return `Key ${event.value} is copied because the walk to ${target ?? 'the key'} passed ` +
        `through it. Only this path is duplicated; the subtrees beside it are shared.`;
    }

    case 'NodeVisited': {
      const key = keyOf(ctx.after, event.node);
      if (command === 'compare') return `Key ${key ?? '?'} is the same node in both versions.`;
      if (key === null || target === null) return `Looking at a node.`;
      if (key === target) return `Found key ${target}.`;
      return `${target} ${target < key ? 'is below' : 'is above'} ${key}, so the search goes ` +
        `${target < key ? 'left' : 'right'}. Each step costs one node, however many remain.`;
    }

    case 'NodeReused': {
      const child = keyOf(ctx.after, event.node);
      const parent = keyOf(ctx.after, event.by);
      return `The subtree under key ${child ?? '?'} is untouched, so the copy of key ` +
        `${parent ?? '?'} points at the existing node instead of duplicating it.`;
    }

    case 'VersionCommitted': {
      if (event.roots.length === 0) return `Version ${event.version} is empty.`;
      const rootKey = keyOf(ctx.after, event.roots[0] as NodeId);
      const reachable = ctx.after.nodes.size;
      return `Version ${event.version} is complete, rooted at key ${rootKey ?? '?'}. ` +
        `${reachable > 0 ? 'Nothing rotated; the shape is whatever the insertion order made it.' : ''}`;
    }

    case 'PointerSet': {
      if (event.to === null) return null;
      const child = ctx.after.nodes.get(event.to);
      const parent = ctx.after.nodes.get(event.from);
      if (child === undefined || parent === undefined) return null;
      return child.origin < parent.origin
        ? `The copy keeps v${child.origin}'s ${event.slot} subtree whole.`
        : `The copy links to its ${event.slot} child, rebuilt alongside it.`;
    }

    case 'RootsSet':
    case 'NodeDeleted':
      return null;

    default:
      return null;
  }
};
