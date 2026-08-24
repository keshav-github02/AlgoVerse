/**
 * Why each event happened, in link-cut terms.
 *
 * The thing worth explaining is that the picture is not the tree. It is the
 * forest of splay trees the tree is stored in, and almost every event is a
 * rearrangement of that storage rather than a change to the tree itself - the
 * tree only changes on link, cut and evert.
 */

import type { SimEvent } from '@algoverse/core';
import type { ExplainContext, Explainer } from '@algoverse/plugin-sdk';

export const explainLinkCut: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;
  const labelOf = (node: Parameters<typeof ctx.after.nodes.get>[0]): string =>
    ctx.after.nodes.get(node)?.label ?? '?';

  switch (event.kind) {
    case 'NodeAllocated':
      return `Vertex ${event.value}, in a preferred path of its own until something joins it to `
        + `another. A vertex on its own is a splay tree of one node, which is why nothing here `
        + `needs a special case for it.`;

    case 'PointerSet': {
      const from = labelOf(event.from);
      if (event.slot === 'path') {
        if (event.to === null) {
          return `${from}'s path-parent is dropped: this path is being spliced onto the one above `
            + `it, so it stops being a separate path and the pointer that said where it hung has `
            + `nothing left to say.`;
        }
        return `A path-parent, from the top of ${from}'s path to ${labelOf(event.to)} above it. `
          + `This is the only kind of edge that leaves a preferred path, and following these is `
          + `how a climb to the root gets from one splay tree to the next.`;
      }
      if (event.to === null) {
        return event.slot === 'right'
          ? `${from} lets go of everything deeper on its path. Whatever was there becomes a path `
            + `of its own - it is still in the same tree, just no longer the preferred way down.`
          : `${from} lets go of everything above it, which is what cutting an edge means: the `
            + `part of the path shallower than ${from} is now a separate tree.`;
      }
      return `${from} takes ${labelOf(event.to)} as its ${event.slot} child in the splay tree. `
        + `Left is shallower and right is deeper, so the in-order walk of a splay tree reads its `
        + `path from the top down - and that ordering is what makes a path aggregate a single read.`;
    }

    case 'NodeVisited': {
      const label = labelOf(event.node);
      switch (command) {
        case 'path':
          return `Splaying ${label} upward. The cost of this is the point of the whole structure: `
            + `the path may be long, but bringing its end to the root is logarithmic when `
            + `averaged over a run of queries, because each rotation shortens the way back down.`;
        case 'root':
        case 'connected':
          return `At ${label}, on the way to the shallowest vertex of the path - which, once the `
            + `path runs all the way up, is the root of the tree.`;
        case 'lca':
          return `At ${label} while climbing from the second vertex. Where this climb stops is `
            + `where it met the path made preferred a moment ago, and that meeting point is the `
            + `common ancestor.`;
        case 'evert':
          return `Reversing at ${label}: its two children swap, so the path that ran down through `
            + `it now runs up. Doing this to every node of the path is what makes the far end the `
            + `new root.`;
        case 'cut':
          return `At ${label}, finding which of the two vertices is the child - only the child `
            + `end of an edge can be detached, because a parent has no single edge to lose.`;
        default:
          return `At ${label}.`;
      }
    }

    case 'RootsSet':
      return `The splay forest after the operation: one entry point per preferred path. How many `
        + `there are, and which vertices they hold, is a record of what has been asked about - `
        + `not of the tree's shape, which may not have changed at all.`;

    case 'NodeReused':
    case 'NodeDeleted':
    case 'VersionCommitted':
      return null;

    default:
      return null;
  }
};
