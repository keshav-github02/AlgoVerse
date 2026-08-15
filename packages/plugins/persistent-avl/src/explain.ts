/**
 * Why each event happened, in AVL terms.
 *
 * Rotations are the thing worth narrating: they are the only place in the
 * project where a node's children are rearranged rather than copied straight
 * through, and the reason is always the same arithmetic on subtree heights.
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

export const explainAvl: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;
  const target = argOf(ctx, 'key');

  switch (event.kind) {
    case 'NodeAllocated': {
      const lean = event.role;
      if (command === 'build') {
        return lean === 'balanced'
          ? `Key ${event.value} sits with both sides the same height.`
          : `Key ${event.value} leans ${lean === 'left-heavy' ? 'left' : 'right'} by one level, ` +
            `which is the most an AVL tree allows before it rotates.`;
      }
      if (event.value === target) {
        return `Key ${event.value} is added as a leaf. Whether anything rotates depends on what ` +
          `its new height does to the nodes above it.`;
      }
      return `Key ${event.value} is rebuilt on the way back up, now ${lean}. Every node on the ` +
        `path is re-examined, because adding a leaf can change heights all the way to the root.`;
    }

    case 'NodeVisited': {
      const key = keyOf(ctx.after, event.node);
      if (command === 'compare') return `Key ${key ?? '?'} is the same node in both versions.`;
      if (command === 'find') {
        if (key === null || target === null) return `Looking at a node.`;
        if (key === target) return `Found key ${target}.`;
        return `${target} ${target < key ? 'is below' : 'is above'} ${key}, so the search goes ` +
          `${target < key ? 'left' : 'right'}. Balancing is what keeps this walk short.`;
      }
      return `Descending through key ${key ?? '?'}; it will be rebuilt, and possibly rotated, ` +
        `on the way back up.`;
    }

    case 'NodeReused': {
      const child = keyOf(ctx.after, event.node);
      const parent = keyOf(ctx.after, event.by);
      return `The subtree under key ${child ?? '?'} keeps its shape and its height, so the new ` +
        `node for key ${parent ?? '?'} points at it rather than copying it - including when that ` +
        `new node is the product of a rotation.`;
    }

    case 'VersionCommitted': {
      if (event.roots.length === 0) return `Version ${event.version} is empty.`;
      const rootKey = keyOf(ctx.after, event.roots[0] as NodeId);
      const leaning = [...ctx.after.nodes.values()].filter((n) => n.role !== 'balanced').length;
      return `Version ${event.version} is complete, rooted at key ${rootKey ?? '?'}. ` +
        `${leaning} node${leaning === 1 ? '' : 's'} lean by one level and none by more - ` +
        `that bound is what makes the height logarithmic.`;
    }

    case 'PointerSet': {
      if (event.to === null) return null;
      const child = ctx.after.nodes.get(event.to);
      const parent = ctx.after.nodes.get(event.from);
      if (child === undefined || parent === undefined) return null;
      return child.origin < parent.origin
        ? `The new node adopts v${child.origin}'s ${event.slot} subtree unchanged.`
        : `The new node links to its ${event.slot} child, rebuilt alongside it.`;
    }

    case 'RootsSet':
    case 'NodeDeleted':
      return null;

    default:
      return null;
  }
};
