/**
 * How a plugin describes its structure - semantically, never in pixels.
 *
 * This lives in core rather than plugin-sdk because layout and the renderer
 * both consume it, and neither may depend on the plugin contract.
 */

import type { NodeId } from './timeline.ts';

export type LayoutHint = 'tree' | 'dag' | 'force' | 'linear' | 'grid';

export interface StructureNode {
  readonly id: NodeId;
  readonly label: string;
  readonly value: number;
  /**
   * Several values, when one node holds more than a single key. A B-tree node
   * is the case this exists for; everything else leaves it absent.
   */
  readonly values?: readonly number[];
  readonly role: string;
  /**
   * Vertical level. Optional: a shared subtree can sit at different depths in
   * different versions, so no single number is true. Layout derives it from the
   * graph when it is absent.
   */
  readonly depth?: number;
  /**
   * Layout grouping key, opaque to layout - it only ever tests slots for
   * equality. Nodes sharing a slot occupy one logical position and are fanned
   * apart, which is how several versions of the same node stay aligned.
   */
  readonly slot: string;
  /**
   * The version that allocated this node, for provenance colouring. Always 0
   * in a structure without history.
   */
  readonly origin: number;
  /**
   * Which set this node belongs to - a chain, a component, a partition.
   *
   * Distinct from `origin`, and deliberately so. Origin says *when* a node was
   * allocated; a group says *what it is part of*. They are drawn the same way,
   * as colour, because no structure needs both at once: a partition is
   * interesting exactly when there is no history to show.
   */
  readonly group?: number;
  /**
   * Optional reading order along the layout axis. Layout otherwise derives x
   * from a depth-first walk, which assumes the structure's natural order is its
   * traversal order - true for a tree, false for anything indexed.
   */
  readonly order?: number;
}

export interface StructureEdge {
  readonly from: NodeId;
  readonly to: NodeId;
  /**
   * Names the pointer. Layout orders children by this, using a natural sort,
   * so a plugin should name slots in the order it wants them drawn.
   */
  readonly slot: string;
  /** True when the child predates the parent - a pointer into reused memory. */
  readonly reused: boolean;
  /**
   * Whether this pointer is part of the hierarchy.
   *
   * `child` is the default and the only kind that decides depth or ordering.
   * A `link` is a real pointer that is not a tree edge - a B+ tree's leaf
   * chain, a threaded tree's successor - and layout must ignore it when
   * working out levels, or the structure folds along its own sideways edges.
   */
  readonly kind?: 'child' | 'link';
  /** What the edge is worth, where that means something. Drawn beside it. */
  readonly weight?: number;
  /** One-way. Drawn with an arrowhead, because position cannot say it. */
  readonly directed?: boolean;
}

export interface StructureGraph {
  readonly layout: LayoutHint;
  readonly nodes: readonly StructureNode[];
  readonly edges: readonly StructureEdge[];
  readonly roots: readonly NodeId[];
}
