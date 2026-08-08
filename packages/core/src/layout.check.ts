/**
 * Layout checks. Run directly:
 *
 *     node packages/core/src/layout.check.ts
 *
 * The graph builders are fixtures - core has no plugin dependency, so the
 * shapes a plugin would emit are constructed here by hand.
 */

import { DEFAULT_LAYOUT, layout } from './layout.ts';
import type { StructureEdge, StructureGraph, StructureNode } from './structure.ts';
import type { NodeId } from './timeline.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

/* ── Fixtures ──────────────────────────────────────────────────────── */

interface T {
  readonly id: NodeId;
  readonly lo: number;
  readonly hi: number;
  readonly depth: number;
  readonly origin: number;
  readonly left: T | null;
  readonly right: T | null;
}

/** The shape a persistent segment tree emits: slots keyed by depth and range. */
function persistentTree(n: number, versionCount: number): StructureGraph {
  const nodes: StructureNode[] = [];
  const edges: StructureEdge[] = [];
  const roots: NodeId[] = [];
  let next = 0;

  const mk = (lo: number, hi: number, depth: number, origin: number, left: T | null, right: T | null): T => {
    const id = next as NodeId;
    next += 1;
    nodes.push({
      id, label: hi - lo === 1 ? `i${lo}` : `[${lo},${hi})`, value: 0,
      role: hi - lo === 1 ? 'leaf' : 'internal',
      depth, slot: `${depth}:${lo}:${hi}`, origin,
    });
    if (left !== null) edges.push({ from: id, to: left.id, slot: 'left', reused: left.origin < origin });
    if (right !== null) edges.push({ from: id, to: right.id, slot: 'right', reused: right.origin < origin });
    return { id, lo, hi, depth, origin, left, right };
  };

  const build = (lo: number, hi: number, depth: number): T => {
    if (hi - lo === 1) return mk(lo, hi, depth, 0, null, null);
    const mid = (lo + hi) >> 1;
    const l = build(lo, mid, depth + 1);
    const r = build(mid, hi, depth + 1);
    return mk(lo, hi, depth, 0, l, r);
  };

  let root = build(0, n, 0);
  roots.push(root.id);

  for (let v = 1; v < versionCount; v += 1) {
    const idx = (v * 7) % n;
    const copy = (t: T): T => {
      if (t.hi - t.lo === 1) return mk(t.lo, t.hi, t.depth, v, null, null);
      const mid = (t.lo + t.hi) >> 1;
      const goLeft = idx < mid;
      const l = goLeft ? copy(t.left as T) : (t.left as T);
      const r = goLeft ? (t.right as T) : copy(t.right as T);
      return mk(t.lo, t.hi, t.depth, v, l, r);
    };
    root = copy(root);
    roots.push(root.id);
  }
  return { layout: 'dag', nodes, edges, roots };
}

/** The shape a stack emits. */
function stackGraph(size: number): StructureGraph {
  const nodes: StructureNode[] = [];
  const edges: StructureEdge[] = [];
  for (let i = 0; i < size; i += 1) {
    nodes.push({
      id: i as NodeId, label: `s${i}`, value: i, role: 'cell',
      depth: i, slot: `pos:${i}`, origin: 0,
    });
    if (i > 0) edges.push({ from: i as NodeId, to: (i - 1) as NodeId, slot: 'below', reused: false });
  }
  return { layout: 'linear', nodes, edges, roots: size === 0 ? [] : [(size - 1) as NodeId] };
}

/** A parent with eleven children, to check that c10 sorts after c2. */
function wideNode(): StructureGraph {
  const nodes: StructureNode[] = [{
    id: 0 as NodeId, label: 'root', value: 0, role: 'internal', depth: 0, slot: 'r', origin: 0,
  }];
  const edges: StructureEdge[] = [];
  for (let i = 0; i < 11; i += 1) {
    nodes.push({
      id: (i + 1) as NodeId, label: `c${i}`, value: i, role: 'leaf', depth: 1, slot: `c${i}`, origin: 0,
    });
    edges.push({ from: 0 as NodeId, to: (i + 1) as NodeId, slot: `c${i}`, reused: false });
  }
  return { layout: 'tree', nodes, edges, roots: [0 as NodeId] };
}

/* ── Generic assertions ────────────────────────────────────────────── */

function overlapsAtSameDepth(scene: ReturnType<typeof layout>): string | null {
  const rows = new Map<number, typeof scene.nodes[number][]>();
  for (const n of scene.nodes) {
    const list = rows.get(n.y) ?? [];
    list.push(n);
    rows.set(n.y, list);
  }
  for (const list of rows.values()) {
    const sorted = [...list].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i += 1) {
      const a = sorted[i - 1] as typeof sorted[number];
      const b = sorted[i] as typeof sorted[number];
      if (b.x - a.x < (a.width + b.width) / 2) {
        return `${a.node.label}@${a.x} and ${b.node.label}@${b.x} overlap`;
      }
    }
  }
  return null;
}

/* ── 1. The failure mode the prototype hit ─────────────────────────── */

console.log('\noverlap');

const three = layout(persistentTree(8, 3));
check('3 versions over 8 elements: no overlap', overlapsAtSameDepth(three) === null,
  overlapsAtSameDepth(three) ?? `${three.nodes.length} nodes, ${Math.round(three.width)}px wide`);

for (const [n, v] of [[8, 8], [16, 8], [16, 16], [32, 16]] as const) {
  const scene = layout(persistentTree(n, v));
  const bad = overlapsAtSameDepth(scene);
  check(`${v} versions over ${n} elements: no overlap`, bad === null,
    bad ?? `${scene.nodes.length} nodes, ${Math.round(scene.width)}px wide`);
}

/* ── 2. Slot fanning ───────────────────────────────────────────────── */

console.log('\nslot fanning');

const bySlot = new Map<string, typeof three.nodes[number][]>();
for (const n of three.nodes) {
  const list = bySlot.get(n.node.slot) ?? [];
  list.push(n);
  bySlot.set(n.node.slot, list);
}
const shared = [...bySlot.values()].filter((l) => l.length > 1);
check('some slots hold several versions', shared.length > 0, `${shared.length} shared slots`);
check('versions in a slot share a row', shared.every((l) => new Set(l.map((n) => n.y)).size === 1));
check('versions in a slot are evenly spaced', shared.every((l) => {
  const xs = [...l].sort((a, b) => a.x - b.x).map((n) => n.x);
  const step = DEFAULT_LAYOUT.nodeWidth + DEFAULT_LAYOUT.fanGap;
  return xs.every((x, i) => i === 0 || Math.abs(x - (xs[i - 1] as number) - step) < 1e-6);
}));
check('versions in a slot are ordered by origin', shared.every((l) => {
  const byX = [...l].sort((a, b) => a.x - b.x);
  return byX.every((n, i) => i === 0 || n.node.origin >= (byX[i - 1] as typeof byX[number]).node.origin);
}));

/* ── 3. Structural correctness ─────────────────────────────────────── */

console.log('\nstructure');

const single = layout(persistentTree(8, 1));
const pos = new Map(single.nodes.map((n) => [n.node.id, n]));
const kids = new Map<NodeId, NodeId[]>();
for (const e of persistentTree(8, 1).edges) {
  kids.set(e.from, [...(kids.get(e.from) ?? []), e.to]);
}
check('parents sit centred over their children', [...kids.entries()].every(([parent, children]) => {
  const p = pos.get(parent);
  const xs = children.map((c) => pos.get(c)?.x ?? Number.NaN);
  if (p === undefined || xs.some(Number.isNaN)) return false;
  return Math.abs(p.x - xs.reduce((a, b) => a + b, 0) / xs.length) < 1e-6;
}));
check('deeper nodes sit lower', single.nodes.every((n) =>
  n.y === DEFAULT_LAYOUT.margin + (n.node.depth ?? 0) * (DEFAULT_LAYOUT.nodeHeight + DEFAULT_LAYOUT.levelGap)
    + DEFAULT_LAYOUT.nodeHeight / 2));
check('every node fits inside the reported bounds', three.nodes.every((n) =>
  n.x - n.width / 2 >= 0 && n.x + n.width / 2 <= three.width
  && n.y - n.height / 2 >= 0 && n.y + n.height / 2 <= three.height),
  `${Math.round(three.width)} x ${Math.round(three.height)}`);
check('edges anchor to node boundaries', three.edges.every((e) => {
  const a = pos.get(e.from);
  return a === undefined || Math.abs(e.y1 - (a.y + a.height / 2)) < 1e-6;
}));
check('layout is deterministic',
  JSON.stringify(layout(persistentTree(8, 3))) === JSON.stringify(three));

/* ── 4. Child ordering uses a natural sort ─────────────────────────── */

console.log('\nordering');

const wide = layout(wideNode());
const leaves = wide.nodes.filter((n) => n.node.role === 'leaf').sort((a, b) => a.x - b.x);
check('c2 is placed before c10, not after',
  leaves.map((n) => n.node.label).join(' ') === 'c0 c1 c2 c3 c4 c5 c6 c7 c8 c9 c10',
  leaves.map((n) => n.node.label).join(' '));

/* ── 5. Linear layout ──────────────────────────────────────────────── */

console.log('\nlinear');

const stack = layout(stackGraph(4));
check('a stack is one column', new Set(stack.nodes.map((n) => n.x)).size === 1);
check('the top of the stack is drawn highest', (() => {
  const rootId = stackGraph(4).roots[0];
  const top = stack.nodes.find((n) => n.node.id === rootId);
  return top !== undefined && stack.nodes.every((n) => n.y >= top.y);
})());
check('an empty structure still produces valid bounds', (() => {
  const empty = layout(stackGraph(0));
  return empty.nodes.length === 0 && empty.width > 0 && empty.height > 0;
})());

/* ── 6. How wide does this actually get? ───────────────────────────── */

console.log('\nwidth as versions accumulate:\n');
console.log('        n   versions   nodes   width      widest slot');
for (const [n, v] of [[8, 3], [8, 8], [16, 8], [16, 16], [32, 16], [64, 32]] as const) {
  const g = persistentTree(n, v);
  const scene = layout(g);
  const counts = new Map<string, number>();
  for (const node of g.nodes) counts.set(node.slot, (counts.get(node.slot) ?? 0) + 1);
  const widest = Math.max(...counts.values());
  console.log(`      ${String(n).padStart(3)}   ${String(v).padStart(8)}   ${String(scene.nodes.length).padStart(5)}   ${`${Math.round(scene.width)}px`.padStart(7)}      ${widest} versions`);
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
