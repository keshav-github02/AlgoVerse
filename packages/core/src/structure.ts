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
  readonly role: string;
  readonly depth: number;
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
   * Optional reading order along the layout axis. Layout otherwise derives x
   * from a depth-first walk, which assumes the structure's natural order is its
   * traversal order — true for a tree, false for anything indexed.
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
}

export interface StructureGraph {
  readonly layout: LayoutHint;
  readonly nodes: readonly StructureNode[];
  readonly edges: readonly StructureEdge[];
  readonly roots: readonly NodeId[];
}
