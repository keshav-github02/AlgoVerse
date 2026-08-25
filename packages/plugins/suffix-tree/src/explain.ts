/**
 * Why each event happened, in suffix tree terms.
 *
 * The thing worth explaining is that an edge is not a character. It is a run of
 * them that nothing ever branches inside, and compressing those runs is what
 * takes the tree from quadratic size down to linear.
 */

import type { SimEvent } from '@algoverse/core';
import type { ExplainContext, Explainer } from '@algoverse/plugin-sdk';

export const explainSuffixTree: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;

  switch (event.kind) {
    case 'NodeAllocated': {
      if (event.role === 'root') {
        return `The root, standing for the empty string. Every substring of the word is a path `
          + `down from here that stops wherever it likes - including part way along an edge.`;
      }
      if (event.role === 'suffix') {
        return `A leaf for suffix ${event.value}. Its edge is left open - it runs to wherever the `
          + `input has got to - so there is nothing to spell yet, and it is drawn by which suffix `
          + `it is. Leaving the end open is what stops every leaf having to be lengthened on every `
          + `character.`;
      }
      return `A branch at ${event.value} characters, reached by "${event.label}". Two suffixes `
        + `agree this far and then part company, so the path to here occurs at least twice - which `
        + `is the whole of what "repeated substring" means.`;
    }

    case 'NodeUpdated': {
      if (event.label === undefined) return null;
      return event.value === undefined
        ? `The surviving half of a split edge now spells only "${event.label}". Its path from the `
          + `root has not moved - the new node went in above it - but the front of its own edge `
          + `belongs to that node now.`
        : `Suffix ${event.value}'s edge is closed and spells "${event.label}". The input has `
          + `finished, so the open ends can be written down: this is the step that turns the `
          + `implicit tree into the explicit one, and it is one update per leaf.`;
    }

    case 'PointerSet': {
      if (event.to === null) return null;
      if (event.slot === 'link') {
        return `A suffix link, to the node ${event.weight} characters from the root. Drop the `
          + `first character of this node's path and that is where you land - so inserting the `
          + `next suffix starts from there instead of from the root, and the construction never `
          + `walks the same characters twice.`;
      }
      return `An edge beginning "${event.slot.slice(1)}". One per first character, so which way to `
        + `go is never a search.`;
    }

    case 'NodeVisited': {
      const label = ctx.after.nodes.get(event.node)?.label ?? '?';
      const depth = ctx.after.nodes.get(event.node)?.value ?? 0;
      switch (command) {
        case 'contains':
        case 'occurrences':
          return `Following the edge that spells "${label}", now ${depth} characters in. The `
            + `whole edge is compared in one step, which is why the cost is the length of the `
            + `question and not the depth of the tree.`;
        case 'repeated':
          return `Looking at the node reached by "${label}" - ${depth} characters deep. The `
            + `deepest branching one is the answer, and finding it is a look at every node rather `
            + `than a comparison of any two strings.`;
        default:
          return `At "${label}".`;
      }
    }

    case 'RootsSet':
      return `The tree is finished, in one pass over the word. Every suffix ends at a leaf of its `
        + `own, and every question about a substring is now a walk of at most the length of the `
        + `question.`;

    case 'NodeReused':
    case 'NodeDeleted':
    case 'VersionCommitted':
      return null;

    default:
      return null;
  }
};
