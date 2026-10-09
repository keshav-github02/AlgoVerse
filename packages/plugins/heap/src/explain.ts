/**
 * Why each event happened, in heap terms.
 *
 * Every rule a heap keeps is one comparison between a position and its
 * parent, so most of what there is to say is which comparison just ran and
 * which way it went.
 */

import type { NodeId, SceneState, SimEvent } from '@algoverse/core';
import type { ExplainContext, Explainer } from '@algoverse/plugin-sdk';

const valueAt = (s: SceneState, id: NodeId): number | undefined => s.nodes.get(id)?.value;
const parentOf = (i: number): number => Math.floor((i - 1) / 2);

export const explainHeap: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const name = ctx.command?.name;
  switch (event.kind) {
    case 'NodeAllocated':
      return event.node === 0
        ? `${event.value} goes in at position 0, the root. A heap of one is already in order.`
        : `${event.value} goes in at position ${event.node}, the first free slot - a heap ` +
          `fills its levels left to right, which is what keeps it an array with no gaps.`;

    case 'PointerSet':
      if (event.to === null) return `Position ${event.from} lets go of its ${event.slot} child.`;
      return `Position ${event.to} hangs under ${event.from}, because ${event.from} = ` +
        `floor((${event.to} - 1) / 2). Nobody stores this pointer; the arithmetic is the pointer.`;

    case 'NodeVisited': {
      const v = valueAt(ctx.after, event.node);
      if (name === 'peek') return `The smallest value is always at the root: ${v}. Nothing else needs looking at.`;
      if (event.node === 0 && name === 'pop') return `${v} is at the root, so it is the minimum and the one to remove.`;
      if (name === 'set' && ctx.command?.args.get('index')?.kind === 'int'
        && (ctx.command.args.get('index') as { value: number }).value === event.node) {
        return `Position ${event.node} is the one being overwritten.`;
      }
      return `Compare against position ${event.node}, which holds ${v}.`;
    }

    case 'NodeUpdated': {
      if (event.value === undefined) return null;
      const i = event.node as number;
      if (name === 'pop' && i === 0 && ctx.after.nodes.size > 0) {
        return `The last value, ${event.value}, moves to the root. The shape stays complete; ` +
          `the order is now probably wrong, so it sifts down.`;
      }
      if (name === 'set') {
        return `Position ${i} now holds ${event.value}. If it is smaller than its parent it sifts ` +
          `up; if larger than a child, down. It cannot need both.`;
      }
      const parent = i === 0 ? null : valueAt(ctx.after, parentOf(i) as NodeId);
      return parent === null || parent === undefined
        ? `${event.value} moves into position ${i}.`
        : `${event.value} moves into position ${i}, below ${parent} - parent and child were out ` +
          `of order, so they swap.`;
    }

    case 'NodeDeleted':
      return name === 'build'
        ? `The old heap is cleared before the new one is built.`
        : `The last position is freed. It is the only one that can go without leaving a hole.`;

    case 'RootsSet':
      return event.roots.length === 0 ? `The heap is empty.` : `Position 0 is the root.`;

    default:
      return null;
  }
};
