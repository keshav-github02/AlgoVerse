/**
 * Canonical shape checks. Run directly:
 *
 *     node packages/core/src/shape.check.ts
 */

import { shapeOf } from './shape.ts';
import type { StructureEdge, StructureGraph, StructureNode } from './structure.ts';
import type { NodeId } from './timeline.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const id = (n: number): NodeId => n as NodeId;
const node = (n: number, value: number, label = `n${n}`): StructureNode => ({
  id: id(n), label, value, role: 'x', slot: `s${n}`, origin: 0,
});
const edge = (from: number, to: number, slot: string): StructureEdge => ({
  from: id(from), to: id(to), slot, reused: false,
});
const tree = (
  nodes: readonly StructureNode[], edges: readonly StructureEdge[], roots: readonly number[],
): StructureGraph => ({ layout: 'dag', nodes, edges, roots: roots.map(id) });

console.log('\nidentity is ignored');

//   2            2
//  1 3   ids   1 3    the same picture, allocated in a different order
const a = tree([node(0, 2), node(1, 1), node(2, 3)], [edge(0, 1, 'left'), edge(0, 2, 'right')], [0]);
const b = tree([node(7, 3), node(5, 2), node(9, 1)], [edge(5, 9, 'left'), edge(5, 7, 'right')], [5]);
check('the same tree under different ids has one shape', shapeOf(a) === shapeOf(b));
check('labels are ignored', shapeOf(a) === shapeOf(tree(
  [node(0, 2, 'x'), node(1, 1, 'y'), node(2, 3, 'z')], [edge(0, 1, 'left'), edge(0, 2, 'right')], [0],
)));
check('edge order in the input does not matter', shapeOf(a) === shapeOf(tree(
  [node(2, 3), node(0, 2), node(1, 1)], [edge(0, 2, 'right'), edge(0, 1, 'left')], [0],
)));

console.log('\ndifferences are not');

check('a mirrored tree is a different shape', shapeOf(a) !== shapeOf(tree(
  [node(0, 2), node(1, 1), node(2, 3)], [edge(0, 1, 'right'), edge(0, 2, 'left')], [0],
)));
check('a different value is a different shape', shapeOf(a) !== shapeOf(tree(
  [node(0, 2), node(1, 1), node(2, 4)], [edge(0, 1, 'left'), edge(0, 2, 'right')], [0],
)));
check('a different role is a different shape', shapeOf(a) !== shapeOf(tree(
  [{ ...node(0, 2), role: 'red' }, node(1, 1), node(2, 3)], [edge(0, 1, 'left'), edge(0, 2, 'right')], [0],
)));
check('an extra unreachable node is still counted', shapeOf(a) !== shapeOf(tree(
  [node(0, 2), node(1, 1), node(2, 3), node(3, 9)], [edge(0, 1, 'left'), edge(0, 2, 'right')], [0],
)));
check('slots sort naturally, so c2 comes before c10', (() => {
  const s = shapeOf(tree([node(0, 0), node(1, 1), node(2, 2)], [edge(0, 1, 'c10'), edge(0, 2, 'c2')], [0]));
  return s.indexOf('c2=') < s.indexOf('c10=');
})());

console.log('\nsharing');

// Two versions sharing a leaf, against two versions that each copied it.
const shared = tree(
  [node(0, 5), node(1, 1), node(2, 6)],
  [edge(0, 1, 'left'), edge(2, 1, 'left')],
  [0, 2],
);
const copied = tree(
  [node(0, 5), node(1, 1), node(2, 6), node(3, 1)],
  [edge(0, 1, 'left'), edge(2, 3, 'left')],
  [0, 2],
);
check('a shared node is not the same as a copy of it', shapeOf(shared) !== shapeOf(copied));
check('version order matters', shapeOf(shared) !== shapeOf(tree(
  [node(0, 5), node(1, 1), node(2, 6)], [edge(0, 1, 'left'), edge(2, 1, 'left')], [2, 0],
)));

console.log('\nscale');

const n = 20_000;
const chain = tree(
  Array.from({ length: n }, (_, i) => node(i, i)),
  Array.from({ length: n - 1 }, (_, i) => edge(i, i + 1, 'right')),
  [0],
);
check('a 20 000-node chain does not overflow the stack', (() => {
  try { return shapeOf(chain).length > 0; } catch { return false; }
})());
check('a cycle terminates', shapeOf(tree(
  [node(0, 0), node(1, 1)], [edge(0, 1, 'next'), edge(1, 0, 'next')], [0],
)).length > 0);
check('an empty structure has a shape', shapeOf(tree([], [], [])).length > 0);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
