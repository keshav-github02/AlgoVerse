/**
 * Why each event happened, in treap terms.
 *
 * The thing worth explaining is the priority: a treap is balanced because its
 * priorities are random, not because anything rebalances it. Every sentence
 * about shape ultimately points back at a coin flip.
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

export const explainTreap: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;

  switch (event.kind) {
    case 'NodeAllocated': {
      const target = argOf(ctx, 'key');
      if (command === 'build') {
        return `Key ${event.value} enters the tree. Its position left to right is fixed by ` +
          `the key; how deep it sits is fixed by a random priority.`;
      }
      if (event.value === target) {
        return `Key ${event.value} is the new node. Its random priority decides how high it ` +
          `floats - nothing rebalances afterwards.`;
      }
      return `Key ${event.value} is copied because the walk to ${target ?? 'the key'} passed ` +
        `through it. Only this path is duplicated; the subtrees hanging off it are shared.`;
    }

    case 'NodeVisited': {
      const key = keyOf(ctx.after, event.node);
      const target = argOf(ctx, 'key');
      if (command === 'compare') {
        return `Key ${key ?? '?'} is the same node in both versions, not a copy.`;
      }
      if (command === 'find') {
        if (key === null || target === null) return `Looking at key ${key ?? '?'}.`;
        if (key === target) return `Found key ${target}.`;
        return `${target} ${target < key ? 'is below' : 'is above'} ${key}, so the search goes ` +
          `${target < key ? 'left' : 'right'}.`;
      }
      return `Splitting at key ${key ?? '?'}: this node is on the path, so it will be copied ` +
        `rather than moved.`;
    }

    case 'NodeReused': {
      const child = keyOf(ctx.after, event.node);
      const parent = keyOf(ctx.after, event.by);
      return `The subtree under key ${child ?? '?'} is unchanged by this operation, so the copy ` +
        `of key ${parent ?? '?'} points at the existing node instead of duplicating it.`;
    }

    case 'VersionCommitted': {
      if (event.roots.length === 0) return `Version ${event.version} is empty.`;
      const rootKey = keyOf(ctx.after, event.roots[0] as NodeId);
      const fresh = [...ctx.after.nodes.values()].filter((n) => n.origin === event.version).length;
      if (event.version === 0) {
        return `Version 0 is complete, rooted at key ${rootKey ?? '?'} - the key that happened ` +
          `to draw the highest priority.`;
      }
      return `Version ${event.version} is complete, rooted at key ${rootKey ?? '?'}. It ` +
        `allocated ${fresh} nodes and shares the rest with v${event.version - 1}.`;
    }

    case 'PointerSet': {
      if (event.to === null) return null;
      const child = ctx.after.nodes.get(event.to);
      const parent = ctx.after.nodes.get(event.from);
      if (child === undefined || parent === undefined) return null;
      return child.origin < parent.origin
        ? `The copy keeps v${child.origin}'s ${event.slot} subtree whole - one pointer, no copy.`
        : `The copy links to its ${event.slot} child, rebuilt alongside it.`;
    }

    case 'RootsSet':
    case 'NodeDeleted':
      return null;

    default:
      return null;
  }
};
