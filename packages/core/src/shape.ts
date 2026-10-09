/**
 * What a structure looks like, with its identities taken away.
 *
 * Two runs that build the same tree by different routes allocate different
 * node ids, and a challenge has to accept both. So the canonical form names
 * nodes by the order a walk from the roots first reaches them, not by id, and
 * keeps only what is drawn: values, roles, and which slot points where.
 *
 * Labels are left out on purpose. Several plugins put an allocation counter
 * in the label, which would make two identical pictures compare unequal.
 *
 * Sharing survives the translation. A node reached twice is written once and
 * referred to by its walk index after that, so a persistent structure whose
 * versions share a subtree is distinct from one that copied it.
 */

import type { NodeId } from './timeline.ts';
import type { StructureEdge, StructureGraph, StructureNode } from './structure.ts';

/** "c2" before "c10", the same ordering layout uses for slots. */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

function describe(n: StructureNode): string {
  const values = n.values === undefined ? '' : `[${n.values.join(' ')}]`;
  return `${n.value}${values}:${n.role}`;
}

function pointer(e: StructureEdge): string {
  return `${e.slot}${e.kind === 'link' ? '~' : ''}${e.directed === true ? '>' : ''}` +
    `${e.weight === undefined ? '' : `@${e.weight}`}`;
}

export function shapeOf(graph: StructureGraph): string {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Map<NodeId, StructureEdge[]>();
  for (const e of graph.edges) {
    const list = out.get(e.from) ?? [];
    list.push(e);
    out.set(e.from, list);
  }
  for (const list of out.values()) list.sort((a, b) => naturalCompare(a.slot, b.slot));

  const index = new Map<NodeId, number>();
  const parts: string[] = [];

  // Iterative, because a long chain - a degenerate BST, a stack - is exactly
  // the kind of structure a learner builds on purpose.
  const visit = (start: NodeId): string => {
    const seen = index.get(start);
    if (seen !== undefined) return `#${seen}`;
    const stack: NodeId[] = [start];
    while (stack.length > 0) {
      const id = stack.pop() as NodeId;
      if (index.has(id)) continue;
      const node = byId.get(id);
      if (node === undefined) continue;
      index.set(id, index.size);
      const edges = out.get(id) ?? [];
      // Children are written by index, so every child needs one before its
      // parent's line is final; pushing in reverse visits them in slot order.
      for (let i = edges.length - 1; i >= 0; i -= 1) stack.push((edges[i] as StructureEdge).to);
    }
    return `#${index.get(start) ?? '?'}`;
  };

  const roots = graph.roots.map(visit);
  // Whatever no root reaches still counts: a graph's isolated vertex is part
  // of the picture. Ordered by content, since there is no walk to order it by.
  const stray = graph.nodes
    .filter((n) => !index.has(n.id))
    .sort((a, b) => naturalCompare(describe(a), describe(b)));
  for (const n of stray) visit(n.id);

  const ordered = [...index.entries()].sort((a, b) => a[1] - b[1]);
  for (const [id, i] of ordered) {
    const node = byId.get(id) as StructureNode;
    const kids = (out.get(id) ?? [])
      .filter((e) => index.has(e.to))
      .map((e) => `${pointer(e)}=#${index.get(e.to) as number}`);
    parts.push(`#${i} ${describe(node)}${kids.length === 0 ? '' : ` {${kids.join(' ')}}`}`);
  }
  return `${graph.layout} roots(${roots.join(' ')})\n${parts.join('\n')}`;
}
