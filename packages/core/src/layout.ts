/**
 * Layout: semantic structure in, coordinates out.
 *
 * Sits between the plugin and the renderer so plugins never do pixel maths
 * and the renderer never learns what a version is. Slots are opaque here -
 * layout compares them, it never parses them.
 *
 * Deterministic: the same graph and options always give the same coordinates.
 */

import type { NodeId } from './timeline.ts';
import type { StructureGraph, StructureNode } from './structure.ts';

export interface LayoutOptions {
  readonly nodeWidth: number;
  readonly nodeHeight: number;
  /** Vertical gap between depths. */
  readonly levelGap: number;
  /** Horizontal gap between neighbouring slots. */
  readonly siblingGap: number;
  /** Horizontal gap between versions sharing one slot. */
  readonly fanGap: number;
  readonly margin: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  nodeWidth: 58,
  nodeHeight: 46,
  levelGap: 80,
  siblingGap: 26,
  fanGap: 8,
  margin: 40,
};

export interface PositionedNode {
  readonly node: StructureNode;
  /** Centre of the node box. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PositionedEdge {
  readonly from: NodeId;
  readonly to: NodeId;
  readonly slot: string;
  readonly reused: boolean;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface PositionedScene {
  readonly nodes: readonly PositionedNode[];
  readonly edges: readonly PositionedEdge[];
  readonly width: number;
  readonly height: number;
}

/** "c2" before "c10". Alphabetical ordering would not survive a B-tree. */
function naturalCompare(a: string, b: string): number {
  const split = (s: string): (string | number)[] =>
    s.split(/(\d+)/).filter((p) => p !== '').map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const pa = split(a);
  const pb = split(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y;
    } else if (String(x) !== String(y)) {
      return String(x) < String(y) ? -1 : 1;
    }
  }
  return 0;
}

interface Slot {
  readonly key: string;
  readonly members: readonly StructureNode[];
  readonly depth: number;
  readonly halfWidth: number;
  x: number;
}

/**
 * Levels from the graph itself, for plugins that cannot name one.
 *
 * A shared subtree sits at different depths in different versions, so a node
 * has no single true depth; breadth-first from the roots gives the shallowest,
 * which is where it first appears and where it reads most naturally.
 */
function deriveDepths(graph: StructureGraph): ReadonlyMap<NodeId, number> {
  const adj = new Map<NodeId, NodeId[]>();
  for (const e of graph.edges) {
    const list = adj.get(e.from) ?? [];
    list.push(e.to);
    adj.set(e.from, list);
  }
  const depth = new Map<NodeId, number>();
  let frontier = [...graph.roots];
  for (const id of frontier) depth.set(id, 0);
  let level = 0;
  while (frontier.length > 0) {
    level += 1;
    const next: NodeId[] = [];
    for (const id of frontier) {
      for (const child of adj.get(id) ?? []) {
        if (depth.has(child)) continue;
        depth.set(child, level);
        next.push(child);
      }
    }
    frontier = next;
  }
  // Anything unreachable still needs a row.
  for (const n of graph.nodes) if (!depth.has(n.id)) depth.set(n.id, 0);
  return depth;
}

function buildSlots(
  graph: StructureGraph,
  o: LayoutOptions,
  depthOf: ReadonlyMap<NodeId, number>,
): Map<string, Slot> {
  const grouped = new Map<string, StructureNode[]>();
  for (const n of graph.nodes) {
    const list = grouped.get(n.slot) ?? [];
    list.push(n);
    grouped.set(n.slot, list);
  }
  const slots = new Map<string, Slot>();
  for (const [key, members] of grouped) {
    // Version order is the drawing order, so provenance reads left to right.
    members.sort((a, b) => (a.origin !== b.origin ? a.origin - b.origin : a.id - b.id));
    const span = members.length * o.nodeWidth + (members.length - 1) * o.fanGap;
    slots.set(key, {
      key,
      members,
      depth: Math.min(...members.map((m) => m.depth ?? depthOf.get(m.id) ?? 0)),
      halfWidth: span / 2,
      x: 0,
    });
  }
  return slots;
}

/** Depth-first from the roots, collecting childless slots in visit order. */
function orderLeafSlots(
  graph: StructureGraph,
  slots: Map<string, Slot>,
  childSlots: Map<string, readonly string[]>,
): readonly string[] {
  const slotOf = new Map<NodeId, string>();
  for (const n of graph.nodes) slotOf.set(n.id, n.slot);

  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    const kids = childSlots.get(key) ?? [];
    if (kids.length === 0) {
      order.push(key);
      return;
    }
    for (const k of kids) visit(k);
  };

  for (const root of graph.roots) {
    const key = slotOf.get(root);
    if (key !== undefined) visit(key);
  }
  // Anything unreachable from a root still needs a position.
  for (const key of slots.keys()) visit(key);
  return order;
}

function layered(graph: StructureGraph, o: LayoutOptions): PositionedScene {
  const slots = buildSlots(graph, o, deriveDepths(graph));
  const slotOf = new Map<NodeId, string>();
  for (const n of graph.nodes) slotOf.set(n.id, n.slot);

  // Slot-level child lists, deduplicated, ordered by pointer name.
  const childRefs = new Map<string, { slot: string; via: string }[]>();
  for (const e of graph.edges) {
    const from = slotOf.get(e.from);
    const to = slotOf.get(e.to);
    if (from === undefined || to === undefined || from === to) continue;
    const list = childRefs.get(from) ?? [];
    if (!list.some((r) => r.slot === to)) list.push({ slot: to, via: e.slot });
    childRefs.set(from, list);
  }
  const childSlots = new Map<string, readonly string[]>();
  for (const [key, list] of childRefs) {
    childSlots.set(key, [...list].sort((a, b) => naturalCompare(a.via, b.via)).map((r) => r.slot));
  }

  const declaredOrder = (key: string): number | undefined => {
    const declared = (slots.get(key)?.members ?? [])
      .map((m) => m.order)
      .filter((v): v is number => v !== undefined);
    return declared.length === 0 ? undefined : Math.min(...declared);
  };
  const everySlot = [...slots.values()];
  const indexed = everySlot.length > 0 && everySlot.every((s) => declaredOrder(s.key) !== undefined);

  if (indexed) {
    /**
     * Every slot declared its place, so lay them out in one run and skip
     * centring entirely. Centring a parent over its children is right for a
     * tree, where the parent has no position of its own; in an indexed
     * structure cell 4 belongs at column 4, not between columns 2 and 3.
     */
    const sorted = [...everySlot].sort(
      (x, y) => (declaredOrder(x.key) as number) - (declaredOrder(y.key) as number));
    let cursor = o.margin;
    for (const s of sorted) {
      s.x = cursor + s.halfWidth;
      cursor += s.halfWidth * 2 + o.siblingGap;
    }
  } else {
    // Leaves take their x from traversal order; parents centre over children.
    let cursor = o.margin;
    for (const key of orderLeafSlots(graph, slots, childSlots)) {
      const s = slots.get(key) as Slot;
      s.x = cursor + s.halfWidth;
      cursor += s.halfWidth * 2 + o.siblingGap;
    }

    const byDepthDesc = [...slots.values()].sort((a, b) => b.depth - a.depth);
    for (const s of byDepthDesc) {
      const kids = childSlots.get(s.key) ?? [];
      if (kids.length === 0) continue;
      const xs = kids.map((k) => (slots.get(k) as Slot).x);
      s.x = xs.reduce((a, b) => a + b, 0) / xs.length;
    }

    // Centring can pull neighbours together; push them apart per depth.
    const depths = new Map<number, Slot[]>();
    for (const s of slots.values()) {
      const list = depths.get(s.depth) ?? [];
      list.push(s);
      depths.set(s.depth, list);
    }
    for (const list of depths.values()) {
      list.sort((a, b) => a.x - b.x);
      for (let i = 1; i < list.length; i += 1) {
        const prev = list[i - 1] as Slot;
        const cur = list[i] as Slot;
        const minX = prev.x + prev.halfWidth + o.siblingGap + cur.halfWidth;
        if (cur.x < minX) cur.x = minX;
      }
      const first = list[0] as Slot | undefined;
      if (first !== undefined) {
        const shift = o.margin + first.halfWidth - first.x;
        if (shift > 0) for (const s of list) s.x += shift;
      }
    }
  }

  const step = o.nodeWidth + o.fanGap;
  const placed = new Map<NodeId, PositionedNode>();
  for (const s of slots.values()) {
    const y = o.margin + s.depth * (o.nodeHeight + o.levelGap);
    s.members.forEach((n, i) => {
      placed.set(n.id, {
        node: n,
        x: s.x + (i - (s.members.length - 1) / 2) * step,
        y: y + o.nodeHeight / 2,
        width: o.nodeWidth,
        height: o.nodeHeight,
      });
    });
  }

  return finish(graph, placed, o);
}

function stacked(graph: StructureGraph, o: LayoutOptions): PositionedScene {
  const depthOf = deriveDepths(graph);
  const level = (n: StructureNode): number => n.depth ?? depthOf.get(n.id) ?? 0;
  const ordered = [...graph.nodes].sort((a, b) => (level(a) !== level(b) ? level(a) - level(b) : a.id - b.id));
  const maxDepth = ordered.length === 0 ? 0 : Math.max(...ordered.map(level));
  const step = o.nodeHeight + o.levelGap / 3;
  const placed = new Map<NodeId, PositionedNode>();
  for (const n of ordered) {
    placed.set(n.id, {
      node: n,
      x: o.margin + o.nodeWidth / 2,
      // Depth 0 sits at the bottom, so a stack grows upward the way it reads.
      y: o.margin + (maxDepth - level(n)) * step + o.nodeHeight / 2,
      width: o.nodeWidth,
      height: o.nodeHeight,
    });
  }
  return finish(graph, placed, o);
}

function gridded(graph: StructureGraph, o: LayoutOptions): PositionedScene {
  const cols = Math.max(1, Math.ceil(Math.sqrt(graph.nodes.length)));
  const placed = new Map<NodeId, PositionedNode>();
  [...graph.nodes]
    .sort((a, b) => a.id - b.id)
    .forEach((n, i) => {
      placed.set(n.id, {
        node: n,
        x: o.margin + (i % cols) * (o.nodeWidth + o.siblingGap) + o.nodeWidth / 2,
        y: o.margin + Math.floor(i / cols) * (o.nodeHeight + o.levelGap / 2) + o.nodeHeight / 2,
        width: o.nodeWidth,
        height: o.nodeHeight,
      });
    });
  return finish(graph, placed, o);
}

/**
 * Placeholder for 'force'. Deterministic ring placement - readable for small
 * graphs, but no relaxation happens. Replace before shipping graph algorithms.
 */
function ringed(graph: StructureGraph, o: LayoutOptions): PositionedScene {
  const n = graph.nodes.length;
  const radius = Math.max(o.nodeWidth, (n * (o.nodeWidth + o.siblingGap)) / (2 * Math.PI));
  const placed = new Map<NodeId, PositionedNode>();
  [...graph.nodes]
    .sort((a, b) => a.id - b.id)
    .forEach((node, i) => {
      const angle = (2 * Math.PI * i) / Math.max(1, n);
      placed.set(node.id, {
        node,
        x: o.margin + radius + Math.cos(angle) * radius,
        y: o.margin + radius + Math.sin(angle) * radius,
        width: o.nodeWidth,
        height: o.nodeHeight,
      });
    });
  return finish(graph, placed, o);
}

function finish(
  graph: StructureGraph,
  placed: Map<NodeId, PositionedNode>,
  o: LayoutOptions,
): PositionedScene {
  const nodes = [...placed.values()];
  const edges: PositionedEdge[] = [];
  for (const e of graph.edges) {
    const a = placed.get(e.from);
    const b = placed.get(e.to);
    if (a === undefined || b === undefined) continue;
    const downward = b.y >= a.y;
    edges.push({
      from: e.from,
      to: e.to,
      slot: e.slot,
      reused: e.reused,
      x1: a.x,
      y1: a.y + (downward ? a.height / 2 : -a.height / 2),
      x2: b.x,
      y2: b.y + (downward ? -b.height / 2 : b.height / 2),
    });
  }
  const width = nodes.reduce((m, n) => Math.max(m, n.x + n.width / 2), 0) + o.margin;
  const height = nodes.reduce((m, n) => Math.max(m, n.y + n.height / 2), 0) + o.margin;
  return { nodes, edges, width, height };
}

export function layout(graph: StructureGraph, options: Partial<LayoutOptions> = {}): PositionedScene {
  const o: LayoutOptions = { ...DEFAULT_LAYOUT, ...options };
  switch (graph.layout) {
    case 'tree':
    case 'dag':
      return layered(graph, o);
    case 'linear':
      return stacked(graph, o);
    case 'grid':
      return gridded(graph, o);
    case 'force':
      return ringed(graph, o);
    default: {
      const never: never = graph.layout;
      throw new Error(`unhandled layout hint: ${String(never)}`);
    }
  }
}
