/**
 * Why each event happened, in Fenwick terms.
 *
 * The thing worth explaining here is the index arithmetic: which cells a write
 * touches, and why, is the whole idea of the structure.
 */

import { getInt, type NodeId, type SceneState, type SimEvent } from '@algoverse/core';
import type { ExplainContext, Explainer } from '@algoverse/plugin-sdk';

const lowbit = (i: number): number => i & -i;

/** Slots are written `i<index>` by this plugin, so it can read them back. */
function indexOf(state: SceneState, id: NodeId): number | null {
  const slot = state.nodes.get(id)?.slot;
  if (slot === undefined || !slot.startsWith('i')) return null;
  const parsed = Number(slot.slice(1));
  return Number.isFinite(parsed) ? parsed : null;
}

const covers = (i: number): string => `${i - lowbit(i) + 1}..${i}`;

function argOf(ctx: ExplainContext, name: string): number | null {
  if (ctx.command === null) return null;
  try {
    return getInt(ctx.command, name);
  } catch {
    return null;
  }
}

export const explainBit: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;

  switch (event.kind) {
    case 'NodeAllocated': {
      const i = indexOf(ctx.after, event.node) ?? 0;
      const width = lowbit(i);
      if (command === 'build') {
        return width === 1
          ? `Cell ${i} covers only itself, so it holds a[${i}] = ${event.value}.`
          : `Cell ${i} covers ${covers(i)} - ${width} values - because its lowest set bit is ` +
            `${width}. It sums to ${event.value}.`;
      }
      const index = argOf(ctx, 'index');
      const delta = argOf(ctx, 'delta');
      if (index === null) return `Copy of cell ${i}, now ${event.value}.`;
      return i === index
        ? `Cell ${index} is copied first: it is where the write lands. ${delta ?? 0} is added ` +
          `to give ${event.value}.`
        : `Cell ${i} also covers index ${index} - its span ${covers(i)} contains it - so it is ` +
          `copied too, giving ${event.value}. The walk is i += lowbit(i).`;
    }

    case 'NodeVisited': {
      const i = indexOf(ctx.after, event.node) ?? 0;
      if (command === 'compare') {
        return `Cell ${i} is the same node in both versions, not a copy.`;
      }
      if (command === 'add') {
        return `Cell ${i} covers the index being written, so the old value is read before ` +
          `the copy is made.`;
      }
      if (command === 'kth') {
        return `Cell ${i} holds the sum of ${covers(i)}, a block ${lowbit(i)} wide. The descent ` +
          `tries the widest blocks first and takes each one it can still afford - which is the ` +
          `operation this shape gives away, and a plain array of prefix sums cannot do at all.`;
      }
      if (command === 'range') {
        return `Cell ${i} is on one of the two prefix walks. A Fenwick tree only knows prefixes, ` +
          `so a range is one subtracted from the other - and that subtraction is why this shape ` +
          `can total a range but cannot find its smallest value.`;
      }
      const k = argOf(ctx, 'k');
      return k === null
        ? `Reading cell ${i}.`
        : `Take cell ${i}, covering ${covers(i)}. The prefix walk then clears the low bit: ` +
          `${i} - ${lowbit(i)} = ${i - lowbit(i)}${i - lowbit(i) === 0 ? ', which ends it' : ''}.`;
    }

    case 'NodeReused': {
      const kid = indexOf(ctx.after, event.node);
      const parent = indexOf(ctx.after, event.by);
      return `Cell ${kid ?? '?'} does not cover the written index, so the copy of cell ` +
        `${parent ?? '?'} points at the existing node rather than duplicating it.`;
    }

    case 'VersionCommitted': {
      const n = event.roots.length;
      if (event.version === 0) {
        return n === 1
          ? `Version 0 is complete. The forest has a single root because the size is a power of two.`
          : `Version 0 is complete, with ${n} roots - a Fenwick forest only has one when its ` +
            `size is a power of two.`;
      }
      const fresh = [...ctx.after.nodes.values()].filter((x) => x.origin === event.version).length;
      return `Version ${event.version} is complete. It copied ${fresh} cells along one upward ` +
        `walk and shares the rest with v${event.version - 1}.`;
    }

    case 'PointerSet': {
      if (event.to === null) return null;
      const child = ctx.after.nodes.get(event.to);
      const parent = ctx.after.nodes.get(event.from);
      if (child === undefined || parent === undefined) return null;
      return child.origin < parent.origin
        ? `The copied cell keeps v${child.origin}'s subtree - one pointer instead of a copy.`
        : `The copied cell links to the child copied alongside it.`;
    }

    case 'RootsSet':
    case 'NodeDeleted':
      return null;

    default:
      return null;
  }
};
