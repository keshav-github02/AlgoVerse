/**
 * Reachability and version-diff checks. Run directly:
 *
 *     node packages/core/src/reach.check.ts
 */

import { diffRoots, reachableFrom } from './reach.ts';
import type { StructureEdge, StructureGraph, StructureNode } from './structure.ts';
import type { NodeId } from './timeline.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const id = (n: number): NodeId => n as NodeId;
const node = (n: number, origin = 0): StructureNode => ({
  id: id(n), label: `n${n}`, value: n, role: 'x', depth: 0, slot: `s${n}`, origin,
});
const edge = (from: number, to: number): StructureEdge => ({
  from: id(from), to: id(to), slot: 'c', reused: false,
});

/**
 * Two versions sharing a subtree, exactly as a persistent structure produces:
 *
 *   v0: 0 -> 1 -> 3
 *            \-> 4
 *   v1: 5 -> 6 -> 3      (6 is new, 3 and 4 are reused)
 *            \-> 4
 */
const shared: StructureGraph = {
  layout: 'dag',
  nodes: [node(0), node(1), node(3), node(4), node(5, 1), node(6, 1)],
  edges: [edge(0, 1), edge(1, 3), edge(1, 4), edge(5, 6), edge(6, 3), edge(6, 4)],
  roots: [id(0), id(5)],
};

/* ── Reachability ──────────────────────────────────────────────────── */

console.log('\nreachability');

check('follows edges from a root',
  [...reachableFrom(shared, [id(0)])].sort((a, b) => a - b).join(',') === '0,1,3,4');
check('several roots union', reachableFrom(shared, [id(0), id(5)]).size === 6);
check('an unknown root reaches only itself', reachableFrom(shared, [id(99)]).size === 1);
check('no roots reaches nothing', reachableFrom(shared, []).size === 0);
check('a cycle terminates', (() => {
  const cyclic: StructureGraph = {
    layout: 'dag', nodes: [node(0), node(1)], edges: [edge(0, 1), edge(1, 0)], roots: [id(0)],
  };
  return reachableFrom(cyclic, [id(0)]).size === 2;
})());

/* ── Version diff ──────────────────────────────────────────────────── */

console.log('\ndiff');

const d = diffRoots(shared, [id(0)], [id(5)]);
check('shared nodes are found', d.shared.map(Number).sort((a, b) => a - b).join(',') === '3,4',
  `[${d.shared.join(',')}]`);
check('nodes only in A are found', d.onlyA.map(Number).sort((a, b) => a - b).join(',') === '0,1');
check('nodes only in B are found', d.onlyB.map(Number).sort((a, b) => a - b).join(',') === '5,6');
check('every node is classified', d.membership.size === shared.nodes.length);
check('the three groups partition the reachable set',
  d.shared.length + d.onlyA.length + d.onlyB.length === 6);
check('shared ratio is measured against B', Math.round(d.sharedRatio * 100) === 50,
  `${Math.round(d.sharedRatio * 100)}% of v1 reused`);

check('comparing a version with itself is total reuse', (() => {
  const same = diffRoots(shared, [id(0)], [id(0)]);
  return same.onlyA.length === 0 && same.onlyB.length === 0 && same.sharedRatio === 1;
})());

check('nodes in neither version are marked', (() => {
  const orphaned: StructureGraph = {
    ...shared,
    nodes: [...shared.nodes, node(9)],
  };
  return diffRoots(orphaned, [id(0)], [id(5)]).membership.get(id(9)) === 'neither';
})());

check('an empty B gives a zero ratio', (() => {
  const empty = diffRoots(shared, [id(0)], [id(99)]);
  return empty.sharedRatio === 0 && empty.onlyA.length === 4;
})());

check('diffing is order-sensitive in the right way', (() => {
  const forward = diffRoots(shared, [id(0)], [id(5)]);
  const back = diffRoots(shared, [id(5)], [id(0)]);
  return forward.onlyA.join() === back.onlyB.join()
    && forward.onlyB.join() === back.onlyA.join()
    && forward.shared.join() === back.shared.join();
})());

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
