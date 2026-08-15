/**
 * Why each event happened, in splay-tree terms.
 *
 * The idea worth explaining is that the read is the write. Nothing here checks
 * a balance condition; the tree simply drags whatever you touched to the top,
 * and the cost argument is about sequences rather than single operations.
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

export const explainSplay: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;
  const target = argOf(ctx, 'key');

  switch (event.kind) {
    case 'NodeAllocated': {
      if (command === 'build') {
        return `Key ${event.value} goes in at the root. Every insert splays first, so the newest ` +
          `key is always the shallowest.`;
      }
      if (event.value === target) {
        return `Key ${event.value} arrives at the root — the place a splay tree puts whatever you ` +
          `last touched, on the bet that you will want it again.`;
      }
      return `Key ${event.value} is rewritten as the rotations carry ${target ?? 'the key'} past ` +
        `it. Reading this tree rebuilds the path it read.`;
    }

    case 'NodeVisited': {
      const key = keyOf(ctx.after, event.node);
      if (command === 'compare') return `Key ${key ?? '?'} is the same node in both versions.`;
      if (command === 'contains') {
        return `Checking key ${key ?? '?'} without splaying, so this version is left alone.`;
      }
      if (key === null || target === null) return `Walking the path.`;
      if (key === target) return `Found key ${target}. Now it gets rotated up to the root.`;
      return `${target} ${target < key ? 'is below' : 'is above'} ${key}. Nothing here is ` +
        `balanced — the walk can be long, and splaying is what stops it being long twice.`;
    }

    case 'NodeReused': {
      const child = keyOf(ctx.after, event.node);
      const parent = keyOf(ctx.after, event.by);
      return `The subtree under key ${child ?? '?'} is off the access path, so the rewritten ` +
        `node for key ${parent ?? '?'} points straight at it.`;
    }

    case 'VersionCommitted': {
      if (event.roots.length === 0) return `Version ${event.version} is empty.`;
      const rootKey = keyOf(ctx.after, event.roots[0] as NodeId);
      return command === 'access'
        ? `Version ${event.version} is the tree *after reading it*, now rooted at ` +
          `${rootKey ?? '?'}. A lookup made a new version — v${event.version - 1} still has its ` +
          `old shape, which is what makes the rearrangement visible rather than destructive.`
        : `Version ${event.version} is complete, rooted at key ${rootKey ?? '?'}.`;
    }

    case 'PointerSet': {
      if (event.to === null) return null;
      const child = ctx.after.nodes.get(event.to);
      const parent = ctx.after.nodes.get(event.from);
      if (child === undefined || parent === undefined) return null;
      return child.origin < parent.origin
        ? `The rewritten node keeps v${child.origin}'s ${event.slot} subtree untouched.`
        : `The rewritten node links to its ${event.slot} child from this same rotation.`;
    }

    case 'RootsSet':
    case 'NodeDeleted':
      return null;

    default:
      return null;
  }
};
