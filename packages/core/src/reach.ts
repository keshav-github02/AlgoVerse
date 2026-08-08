/**
 * Reachability over a structure graph.
 *
 * Purely structural: follow edges from a root. Nothing here knows what a
 * version is, which is why the same code answers "what does this version see"
 * for a persistent tree and "what is still linked" for anything else.
 */

import type { StructureGraph } from './structure.ts';
import type { NodeId } from './timeline.ts';

function adjacency(graph: StructureGraph): ReadonlyMap<NodeId, readonly NodeId[]> {
  const adj = new Map<NodeId, NodeId[]>();
  for (const e of graph.edges) {
    const list = adj.get(e.from) ?? [];
    list.push(e.to);
    adj.set(e.from, list);
  }
  return adj;
}

function walk(
  adj: ReadonlyMap<NodeId, readonly NodeId[]>,
  roots: readonly NodeId[],
): Set<NodeId> {
  const seen = new Set<NodeId>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop() as NodeId;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of adj.get(id) ?? []) stack.push(next);
  }
  return seen;
}

export function reachableFrom(graph: StructureGraph, roots: readonly NodeId[]): ReadonlySet<NodeId> {
  return walk(adjacency(graph), roots);
}

/** Where a node stands relative to two roots. */
export type Membership = 'shared' | 'onlyA' | 'onlyB' | 'neither';

export interface RootDiff {
  readonly shared: readonly NodeId[];
  readonly onlyA: readonly NodeId[];
  readonly onlyB: readonly NodeId[];
  readonly membership: ReadonlyMap<NodeId, Membership>;
  /** Fraction of B's nodes that were reused rather than allocated for it. */
  readonly sharedRatio: number;
}

export function diffRoots(
  graph: StructureGraph,
  a: readonly NodeId[],
  b: readonly NodeId[],
): RootDiff {
  const adj = adjacency(graph);
  const sa = walk(adj, a);
  const sb = walk(adj, b);

  const shared: NodeId[] = [];
  const onlyA: NodeId[] = [];
  const onlyB: NodeId[] = [];
  const membership = new Map<NodeId, Membership>();

  for (const n of graph.nodes) {
    const inA = sa.has(n.id);
    const inB = sb.has(n.id);
    const where: Membership = inA && inB ? 'shared' : inA ? 'onlyA' : inB ? 'onlyB' : 'neither';
    membership.set(n.id, where);
    if (where === 'shared') shared.push(n.id);
    else if (where === 'onlyA') onlyA.push(n.id);
    else if (where === 'onlyB') onlyB.push(n.id);
  }

  return {
    shared,
    onlyA,
    onlyB,
    membership,
    sharedRatio: sb.size === 0 ? 0 : shared.length / sb.size,
  };
}
