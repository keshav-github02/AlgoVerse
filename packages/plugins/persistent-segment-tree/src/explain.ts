/**
 * Why each event happened, in segment-tree terms.
 *
 * Templates over events, not prose stored in the log. Every sentence is
 * reconstructed from the event, the scene, and the command that caused it, so
 * scrubbing to step 40 explains step 40 rather than replaying a recording.
 */

import { getInt, getVersion, type NodeId, type SceneState, type SimEvent } from '@algoverse/core';
import type { ExplainContext, Explainer } from '@algoverse/plugin-sdk';

/** Slots are written `depth:lo:hi` by this plugin, so it can read them back. */
function range(state: SceneState, id: NodeId): { lo: number; hi: number } | null {
  const slot = state.nodes.get(id)?.slot;
  if (slot === undefined) return null;
  const [, lo, hi] = slot.split(':');
  if (lo === undefined || hi === undefined) return null;
  return { lo: Number(lo), hi: Number(hi) };
}

const span = (r: { lo: number; hi: number }): string =>
  r.hi - r.lo === 1 ? `index ${r.lo}` : `range [${r.lo}, ${r.hi})`;

const size = (r: { lo: number; hi: number }): number => r.hi - r.lo;

function argOf(ctx: ExplainContext, name: string, read: 'int' | 'version'): number | null {
  if (ctx.command === null) return null;
  try {
    return read === 'int' ? getInt(ctx.command, name) : getVersion(ctx.command, name);
  } catch {
    return null;
  }
}

export const explainSegmentTree: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;

  switch (event.kind) {
    case 'NodeAllocated': {
      const r = { lo: 0, hi: 0 };
      const parsed = range(ctx.after, event.node);
      if (parsed !== null) { r.lo = parsed.lo; r.hi = parsed.hi; }

      if (command === 'build') {
        return size(r) === 1
          ? `Leaf for ${span(r)} holds the array value ${event.value}.`
          : `Internal node for ${span(r)} stores ${event.value}, the sum of its two children — ` +
            `so any query covering the whole range can stop here.`;
      }
      const idx = argOf(ctx, 'index', 'int');
      const from = argOf(ctx, 'version', 'version');
      const because = idx === null
        ? 'the write passes through it'
        : `the write to index ${idx} falls inside ${span(r)}`;
      return size(r) === 1
        ? `New leaf for ${span(r)} holding ${event.value}. The old leaf still belongs to ` +
          `v${from ?? 0}, which is why that version is unchanged.`
        : `Copy of ${span(r)}, because ${because}. Only nodes on this one root-to-leaf ` +
          `path are copied — everything else is shared.`;
    }

    case 'NodeReused': {
      const r = range(ctx.after, event.node);
      const under = range(ctx.after, event.by);
      const what = r === null ? 'this subtree' : span(r);
      const parent = under === null ? 'the new node' : `the copy of ${span(under)}`;
      return `${what} is untouched by this write, so ${parent} points straight at the ` +
        `existing node instead of copying it. This is where the memory saving comes from.`;
    }

    case 'NodeVisited': {
      const r = range(ctx.after, event.node);
      const where = r === null ? 'a node' : span(r);

      if (command === 'compare') {
        return `${where} is reachable from both versions — the same node, not a copy.`;
      }
      if (command === 'update') {
        const idx = argOf(ctx, 'index', 'int');
        if (idx === null) return `Walking down through ${where}.`;
        if (r !== null && size(r) === 1) {
          return `Arrived at index ${idx} — the leaf actually being written. ` +
            `The descent copied one node per level to get here.`;
        }
        return `Descending through ${where} on the way to index ${idx}. Every node on this ` +
          `path gets copied; nothing beside it does.`;
      }

      const lo = argOf(ctx, 'lo', 'int');
      const hi = argOf(ctx, 'hi', 'int');
      if (lo === null || hi === null || r === null) return `Reading ${where}.`;

      // Three cases, not two. A node that is merely "not contained" may be
      // wholly outside, and a leaf has no children to descend into.
      if (r.hi <= lo || hi <= r.lo) {
        return `${where} lies outside [${lo}, ${hi}) and contributes nothing, so this ` +
          `branch is abandoned.`;
      }
      if (lo <= r.lo && r.hi <= hi) {
        return `${where} sits entirely inside [${lo}, ${hi}), so its stored sum is taken ` +
          `whole and the descent stops here — this is why a query touches O(log n) nodes ` +
          `rather than the whole range.`;
      }
      return `${where} only partly overlaps [${lo}, ${hi}), so the search must descend ` +
        `into its children to find the pieces that count.`;
    }

    case 'VersionCommitted': {
      const fresh = [...ctx.after.nodes.values()].filter((n) => n.origin === event.version).length;
      if (event.version === 0) {
        return `Version 0 is complete with ${fresh} nodes — 2n−1 for n leaves.`;
      }
      return `Version ${event.version} is complete. It allocated ${fresh} nodes and shares ` +
        `everything else with v${event.version - 1}, which remains readable and unchanged.`;
    }

    case 'PointerSet': {
      if (event.to === null) return null;
      const child = ctx.after.nodes.get(event.to);
      const parent = ctx.after.nodes.get(event.from);
      if (child === undefined || parent === undefined) return null;
      if (child.origin < parent.origin) {
        return `The new node borrows v${child.origin}'s ${event.slot} subtree wholesale — ` +
          `one pointer instead of a copy.`;
      }
      return `The new node links to its freshly copied ${event.slot} child.`;
    }

    case 'RootsSet': {
      const n = event.roots.length;
      return `${n} version${n === 1 ? '' : 's'} now readable: ` +
        `${event.roots.map((_, i) => `v${i}`).join(', ')}. Every one of them still answers queries.`;
    }

    // A persistent structure never frees anything.
    case 'NodeDeleted':
      return null;

    default:
      return null;
  }
};
