/**
 * Why each event happened, in B-tree terms.
 *
 * Splitting is the thing worth narrating. Everything a B-tree does to stay
 * shallow follows from one rule - a node may hold at most ORDER-1 keys - and
 * every sentence here traces back to it.
 */

import { getInt, type NodeId, type SceneState, type SimEvent } from '@algoverse/core';
import type { ExplainContext, Explainer } from '@algoverse/plugin-sdk';
import { ORDER } from './plugin.ts';

/** Slots are written `k<first key>` by this plugin, so it can read them back. */
function firstKeyOf(state: SceneState, id: NodeId): number | null {
  const slot = state.nodes.get(id)?.slot;
  if (slot === undefined || !slot.startsWith('k')) return null;
  const parsed = Number(slot.slice(1));
  return Number.isFinite(parsed) ? parsed : null;
}

const describe = (keys: readonly number[] | undefined): string =>
  keys === undefined || keys.length === 0 ? 'an empty node' : `[${keys.join(' ')}]`;

function argOf(ctx: ExplainContext, name: string): number | null {
  if (ctx.command === null) return null;
  try {
    return getInt(ctx.command, name);
  } catch {
    return null;
  }
}

export const explainBtree: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;
  const target = argOf(ctx, 'key');

  switch (event.kind) {
    case 'NodeAllocated': {
      const keys = event.values;
      const held = keys?.length ?? 0;
      if (command === 'build') {
        return `${describe(keys)} holds ${held} key${held === 1 ? '' : 's'}; a node may hold ` +
          `${ORDER - 1} before it has to split.`;
      }
      if (held === 1 && event.role === 'internal') {
        return `${describe(keys)} is a new root. A B-tree only grows taller when the old root ` +
          `splits and its middle key has nowhere to go but upward.`;
      }
      return `${describe(keys)} is written out with ${held} key${held === 1 ? '' : 's'}, ` +
        `rebuilt because the insert of ${target ?? 'the key'} passed through it.`;
    }

    case 'NodeVisited': {
      const first = firstKeyOf(ctx.after, event.node);
      const keys = ctx.after.nodes.get(event.node)?.values;
      if (command === 'compare') return `The node starting at ${first ?? '?'} is shared by both versions.`;
      if (command === 'find') {
        return `Reading ${describe(keys)}. One node read compares several keys at once, which is ` +
          `why a B-tree is shallow: fan-out does the work.`;
      }
      return `Descending through ${describe(keys)} towards ${target ?? 'the key'}.`;
    }

    case 'NodeReused': {
      const first = firstKeyOf(ctx.after, event.node);
      return `The subtree starting at ${first ?? '?'} is untouched by this insert, so the ` +
        `rebuilt parent points at it rather than copying it. A node has up to ${ORDER} children ` +
        `and at most one of them is ever on the path.`;
    }

    case 'VersionCommitted': {
      const fresh = [...ctx.after.nodes.values()].filter((n) => n.origin === event.version).length;
      return event.version === 0
        ? `Version 0 is complete with ${ctx.after.nodes.size} nodes.`
        : `Version ${event.version} is complete, having written ${fresh} node` +
          `${fresh === 1 ? '' : 's'} and shared the rest with v${event.version - 1}.`;
    }

    case 'PointerSet': {
      if (event.to === null) return null;
      const child = ctx.after.nodes.get(event.to);
      const parent = ctx.after.nodes.get(event.from);
      if (child === undefined || parent === undefined) return null;
      return child.origin < parent.origin
        ? `The rebuilt node keeps v${child.origin}'s child in slot ${event.slot}.`
        : `The rebuilt node links to its child in slot ${event.slot}.`;
    }

    case 'RootsSet':
    case 'NodeDeleted':
      return null;

    default:
      return null;
  }
};
