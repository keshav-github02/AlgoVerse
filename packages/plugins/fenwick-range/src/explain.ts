/**
 * Why each event happened, in difference-array terms.
 *
 * The thing worth explaining is that nothing here stores the array. It stores
 * how the array *changes* from one index to the next, which is why a range of
 * any width costs the same four writes - and why reading a sum back needs a
 * second array to undo the offsets.
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

export const explainFenwickRange: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;
  const lo = argOf(ctx, 'lo');
  const hi = argOf(ctx, 'hi');
  const delta = argOf(ctx, 'delta');

  switch (event.kind) {
    case 'NodeAllocated': {
      const correction = event.role === 'correction';
      if (command === 'build') {
        return correction
          ? `A correction cell. It holds how far into the array each difference starts, which is ` +
            `what a prefix needs to undo - a difference written at index l does not apply to the ` +
            `l - 1 entries before it.`
          : `A difference cell. It holds the running change from one index to the next, not the ` +
            `values themselves, so writing a whole range means touching only where it begins and ` +
            `where it ends.`;
      }
      if (correction) {
        return `The correction for ${lo ?? 'the range'}..${hi ?? '?'} is recorded, so that a ` +
          `prefix reading past this point subtracts the part of the change that had not started yet.`;
      }
      return `The difference at the edge of ${lo ?? 'the range'}..${hi ?? '?'} moves by ` +
        `${delta ?? 'the delta'}. Everything between the two edges is left completely alone - ` +
        `that is what makes a range of one and a range of a thousand cost the same.`;
    }

    case 'NodeReused':
      return `This cell is on neither of the chains being written, so the new version points at ` +
        `the one that is already there.`;

    case 'NodeVisited': {
      if (command === 'prefix' || command === 'range') {
        return `On one of the two walks. A prefix here is not a sum of stored values: it is the ` +
          `differences multiplied by how far along we are, minus the corrections. Both walks are ` +
          `ordinary Fenwick walks; only what they add up to is different.`;
      }
      if (command === 'at') {
        return `Reading one entry needs only the differences - their running total up to this ` +
          `index is the value here. The corrections exist for sums, not for single reads.`;
      }
      if (command === 'apply' || command === 'add') {
        return `The old cell is read before its copy is made, exactly as a point update does. ` +
          `A range write is four of these chains and never more, whatever the range covers.`;
      }
      if (command === 'compare') {
        return `This cell is in both versions, unchanged and pointed at twice.`;
      }
      return null;
    }

    case 'VersionCommitted':
      return `Version v${event.version} is committed. Both arrays move together: a version is a ` +
        `pair of forests, and neither half means anything without the other.`;

    case 'PointerSet':
    case 'RootsSet':
    case 'NodeDeleted':
      return null;

    default:
      return null;
  }
};
