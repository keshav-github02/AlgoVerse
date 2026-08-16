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
  readonly kind: 'child' | 'link';
  readonly weight?: number;
  readonly directed?: boolean;
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

/**
 * The text a node shows, and how wide that makes it.
 *
 * Width used to be one number for every node in the scene, which held while a
 * node meant one value. A B-tree node holds several keys and needs room for
 * them, so width follows content - for every plugin, not just that one.
 */
export function nodeText(node: StructureNode): string {
  return node.values === undefined ? String(node.value) : node.values.join(' ');
}

function widthOf(node: StructureNode, o: LayoutOptions): number {
  // Monospace at the renderer's value size, plus padding either side.
  return Math.max(o.nodeWidth, nodeText(node).length * 9.6 + 18);
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
    // Sideways pointers are not levels; following one would put a leaf's
    // neighbour a row below it.
    if (e.kind === 'link') continue;
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
    const span = members.reduce((w, m) => w + widthOf(m, o), 0) + (members.length - 1) * o.fanGap;
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
    if (e.kind === 'link') continue;
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

  const placed = new Map<NodeId, PositionedNode>();
  for (const s of slots.values()) {
    const y = o.margin + s.depth * (o.nodeHeight + o.levelGap);
    // Members are laid out left to right using their own widths, so a wide
    // node in a slot pushes its neighbours rather than overlapping them.
    let cursor = s.x - s.halfWidth;
    for (const n of s.members) {
      const w = widthOf(n, o);
      placed.set(n.id, {
        node: n,
        x: cursor + w / 2,
        y: y + o.nodeHeight / 2,
        width: w,
        height: o.nodeHeight,
      });
      cursor += w + o.fanGap;
    }
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
      x: o.margin + widthOf(n, o) / 2,
      // Depth 0 sits at the bottom, so a stack grows upward the way it reads.
      y: o.margin + (maxDepth - level(n)) * step + o.nodeHeight / 2,
      width: widthOf(n, o),
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
        x: o.margin + (i % cols) * (o.nodeWidth + o.siblingGap) + widthOf(n, o) / 2,
        y: o.margin + Math.floor(i / cols) * (o.nodeHeight + o.levelGap / 2) + o.nodeHeight / 2,
        width: widthOf(n, o),
        height: o.nodeHeight,
      });
    });
  return finish(graph, placed, o);
}

/** Iterations of the force simulation. Fixed, so the result is reproducible. */
const FORCE_PASSES = 400;

/**
 * Force-directed layout for structures with no hierarchy.
 *
 * Fruchterman-Reingold: every pair of nodes pushes apart, every edge pulls
 * together, and the step size cools to zero so the arrangement settles rather
 * than oscillating.
 *
 * **Deterministic by construction.** Nodes start evenly spaced on a circle in
 * id order rather than at random, and the iteration count is fixed. A layout
 * that moved between runs would make every check here untestable and every
 * shared link show a different picture than its author saw.
 */
function forceDirected(graph: StructureGraph, o: LayoutOptions): PositionedScene {
  const nodes = [...graph.nodes].sort((a, b) => a.id - b.id);
  const n = nodes.length;
  const placed = new Map<NodeId, PositionedNode>();
  if (n === 0) return finish(graph, placed, o);

  const spacing = o.nodeWidth + o.siblingGap;
  const side = Math.max(spacing, spacing * Math.sqrt(n));
  // The ideal edge length: spread n nodes evenly over the available area.
  const k = side / Math.sqrt(n);

  const index = new Map<NodeId, number>();
  nodes.forEach((node, i) => index.set(node.id, i));
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const radius = side / 2;
  nodes.forEach((_, i) => {
    const angle = (2 * Math.PI * i) / n;
    px[i] = radius + Math.cos(angle) * radius;
    py[i] = radius + Math.sin(angle) * radius;
  });

  const links = graph.edges
    .map((e) => [index.get(e.from), index.get(e.to)] as const)
    .filter((pair): pair is readonly [number, number] =>
      pair[0] !== undefined && pair[1] !== undefined && pair[0] !== pair[1]);

  const dx = new Float64Array(n);
  const dy = new Float64Array(n);

  for (let pass = 0; pass < FORCE_PASSES; pass += 1) {
    dx.fill(0);
    dy.fill(0);

    for (let a = 0; a < n; a += 1) {
      for (let b = a + 1; b < n; b += 1) {
        let ox = (px[a] as number) - (px[b] as number);
        let oy = (py[a] as number) - (py[b] as number);
        let dist = Math.hypot(ox, oy);
        if (dist < 1e-6) {
          // Coincident nodes have no direction to separate along; nudge them
          // apart by index so the tie is broken the same way every run.
          ox = ((a % 7) - 3) / 10 + 1e-3;
          oy = ((b % 5) - 2) / 10 + 1e-3;
          dist = Math.hypot(ox, oy);
        }
        const push = (k * k) / dist;
        dx[a] = (dx[a] as number) + (ox / dist) * push;
        dy[a] = (dy[a] as number) + (oy / dist) * push;
        dx[b] = (dx[b] as number) - (ox / dist) * push;
        dy[b] = (dy[b] as number) - (oy / dist) * push;
      }
    }

    for (const [a, b] of links) {
      const ox = (px[a] as number) - (px[b] as number);
      const oy = (py[a] as number) - (py[b] as number);
      const dist = Math.max(1e-6, Math.hypot(ox, oy));
      const pull = (dist * dist) / k;
      dx[a] = (dx[a] as number) - (ox / dist) * pull;
      dy[a] = (dy[a] as number) - (oy / dist) * pull;
      dx[b] = (dx[b] as number) + (ox / dist) * pull;
      dy[b] = (dy[b] as number) + (oy / dist) * pull;
    }

    const temperature = side * 0.1 * (1 - pass / FORCE_PASSES);
    for (let i = 0; i < n; i += 1) {
      const move = Math.hypot(dx[i] as number, dy[i] as number);
      if (move < 1e-9) continue;
      const step = Math.min(move, temperature) / move;
      px[i] = (px[i] as number) + (dx[i] as number) * step;
      py[i] = (py[i] as number) + (dy[i] as number) * step;
    }
  }

  // Settling leaves nodes close but not necessarily clear of each other, so
  // push overlapping pairs apart before anything is drawn.
  const widths = nodes.map((node) => widthOf(node, o));
  for (let pass = 0; pass < 60; pass += 1) {
    let moved = false;
    for (let a = 0; a < n; a += 1) {
      for (let b = a + 1; b < n; b += 1) {
        const needX = ((widths[a] as number) + (widths[b] as number)) / 2 + o.siblingGap;
        const needY = o.nodeHeight + o.fanGap;
        const gapX = (px[b] as number) - (px[a] as number);
        const gapY = (py[b] as number) - (py[a] as number);
        if (Math.abs(gapX) >= needX || Math.abs(gapY) >= needY) continue;
        // Separate along whichever axis needs the smaller correction.
        const shiftX = needX - Math.abs(gapX);
        const shiftY = needY - Math.abs(gapY);
        moved = true;
        if (shiftX / needX <= shiftY / needY) {
          const push = (gapX >= 0 ? 1 : -1) * shiftX / 2;
          px[a] = (px[a] as number) - push;
          px[b] = (px[b] as number) + push;
        } else {
          const push = (gapY >= 0 ? 1 : -1) * shiftY / 2;
          py[a] = (py[a] as number) - push;
          py[b] = (py[b] as number) + push;
        }
      }
    }
    if (!moved) break;
  }

  const minX = Math.min(...nodes.map((_, i) => (px[i] as number) - (widths[i] as number) / 2));
  const minY = Math.min(...nodes.map((_, i) => (py[i] as number) - o.nodeHeight / 2));
  nodes.forEach((node, i) => {
    placed.set(node.id, {
      node,
      x: (px[i] as number) - minX + o.margin,
      y: (py[i] as number) - minY + o.margin,
      width: widths[i] as number,
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
    const kind = e.kind ?? 'child';
    const extra = {
      ...(e.weight === undefined ? {} : { weight: e.weight }),
      ...(e.directed === undefined ? {} : { directed: e.directed }),
    };

    if (kind === 'link') {
      /**
       * A link runs straight from one box edge to the other. Hierarchy can
       * curve because it always goes downward; a link joins two boxes at any
       * angle, and a curve there points the wrong way at both ends.
       */
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) continue;
      const edgeOf = (n: PositionedNode, ox: number, oy: number): readonly [number, number] => {
        const tx = Math.abs(ox) < 1e-6 ? Infinity : n.width / 2 / Math.abs(ox);
        const ty = Math.abs(oy) < 1e-6 ? Infinity : n.height / 2 / Math.abs(oy);
        const t = Math.min(tx, ty);
        return [n.x + ox * t, n.y + oy * t];
      };
      const [sx, sy] = edgeOf(a, dx, dy);
      const [ex, ey] = edgeOf(b, -dx, -dy);
      edges.push({
        from: e.from, to: e.to, slot: e.slot, reused: e.reused, kind, ...extra,
        x1: sx, y1: sy, x2: ex, y2: ey,
      });
      continue;
    }
    const downward = b.y >= a.y;
    edges.push({
      from: e.from,
      to: e.to,
      slot: e.slot,
      reused: e.reused,
      kind,
      ...extra,
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
      return forceDirected(graph, o);
    default: {
      const never: never = graph.layout;
      throw new Error(`unhandled layout hint: ${String(never)}`);
    }
  }
}
