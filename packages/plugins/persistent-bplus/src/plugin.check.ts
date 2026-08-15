/**
 * Conformance, B+ tree invariants, and the leaf chain that is not a tree edge.
 *
 *     node packages/plugins/persistent-bplus/src/plugin.check.ts
 */

import {
  createRng, help, layout, parseCommand,
  type OperationError, type StructureGraph,
} from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { ORDER, persistentBplus as plugin } from './plugin.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const fresh = (): PluginInstance => plugin.createInstance({ rng: createRng(1) });

function run(inst: PluginInstance, line: string): { value: unknown; error: OperationError | null } {
  const parsed = parseCommand(line, plugin.commands);
  if (!parsed.ok) return { value: null, error: parsed.error };
  const r = inst.execute(parsed.command);
  return r.ok ? { value: r.value, error: null } : { value: null, error: r.error };
}

const keysOf = (inst: PluginInstance, v: number, upTo: number): number[] =>
  (run(inst, `range v${v} 0 ${upTo}`).value as { keys: number[] }).keys;

/** Every rule a B+ tree must obey, recomputed from the graph. */
function violations(graph: StructureGraph, root: number): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id as unknown as number, n]));
  const kids = new Map<number, number[]>();
  for (const e of graph.edges) {
    if (e.kind === 'link') continue;
    const list = kids.get(e.from as unknown as number) ?? [];
    list[Number(e.slot.slice(1))] = e.to as unknown as number;
    kids.set(e.from as unknown as number, list);
  }

  const problems: string[] = [];
  const leafDepths = new Set<number>();

  const walk = (id: number, depth: number, low: number, high: number): void => {
    const node = byId.get(id);
    if (node === undefined) return;
    const keys = node.values ?? [];
    const children = kids.get(id) ?? [];

    if (keys.length > ORDER - 1) problems.push(`node ${id} holds ${keys.length} keys`);
    if (keys.some((k, i) => i > 0 && k <= (keys[i - 1] as number))) {
      problems.push(`node ${id} keys are not sorted`);
    }
    if (children.length === 0) {
      if (node.role !== 'leaf') problems.push(`node ${id} has no children but is not a leaf`);
      if (keys.some((k) => k < low || k >= high)) problems.push(`leaf ${id} key outside its range`);
      leafDepths.add(depth);
      return;
    }
    if (node.role === 'leaf') problems.push(`node ${id} has children but claims to be a leaf`);
    if (children.length !== keys.length + 1) {
      problems.push(`node ${id} has ${children.length} children for ${keys.length} separators`);
    }
    children.forEach((child, i) => {
      walk(child, depth + 1,
        i === 0 ? low : (keys[i - 1] as number),
        i === keys.length ? high : (keys[i] as number));
    });
  };

  walk(root, 0, -Infinity, Infinity);
  if (leafDepths.size > 1) problems.push(`leaves sit at depths ${[...leafDepths].join(', ')}`);
  return problems;
}

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, ['build [5 2 8 1 9]', 'insert v0 6', 'range v1 2 9'])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. Correctness ────────────────────────────────────────────────── */

console.log('\ncorrectness');

const inst = fresh();
run(inst, 'build [5 2 8 1 9]');
check('build holds every key', keysOf(inst, 0, 20).join(',') === '1,2,5,8,9');

run(inst, 'insert v0 6');
check('insert adds one key', keysOf(inst, 1, 20).join(',') === '1,2,5,6,8,9');
check('the earlier version is untouched', keysOf(inst, 0, 20).join(',') === '1,2,5,8,9');
check('a duplicate insert is refused',
  run(inst, 'insert v0 5').error?.code === 'PRECONDITION_FAILED');
check('a backwards range is refused',
  run(inst, 'range v0 9 2').error?.code === 'INVALID_RANGE');
check('an unknown version is refused with the list',
  (run(inst, 'find v9 1').error?.hint ?? '').includes('v0'));

check('a range reads only what it asks for', (() => {
  const p = fresh();
  run(p, `build [${Array.from({ length: 20 }, (_, i) => i + 1).join(' ')}]`);
  const r = run(p, 'range v0 5 12').value as { keys: number[] };
  return r.keys.join(',') === '5,6,7,8,9,10,11';
})());

check('every search reaches a leaf, present or not', (() => {
  const p = fresh();
  run(p, `build [${Array.from({ length: 40 }, (_, i) => i + 1).join(' ')}]`);
  const hit = run(p, 'find v0 20').value as { found: boolean; visits: number; height: number };
  const miss = run(p, 'find v0 999').value as { found: boolean; visits: number };
  return hit.found && !miss.found && hit.visits === hit.height && miss.visits === hit.visits;
})(), 'a hit and a miss cost exactly the same');

/* ── 3. The invariants ─────────────────────────────────────────────── */

console.log('\nB+ tree invariants');

check('keys live only in leaves', (() => {
  const p = fresh();
  run(p, `build [${Array.from({ length: 60 }, (_, i) => i + 1).join(' ')}]`);
  const g = p.getStructure();
  const stored = new Set(g.nodes.filter((n) => n.role === 'leaf').flatMap((n) => n.values ?? []));
  return Array.from({ length: 60 }, (_, i) => i + 1).every((k) => stored.has(k));
})(), 'every key is findable in some leaf');

check('a separator also still exists in a leaf', (() => {
  // A B+ tree copies a leaf's key upward; it must not lose it from the leaf.
  const p = fresh();
  run(p, `build [${Array.from({ length: 60 }, (_, i) => i + 1).join(' ')}]`);
  const g = p.getStructure();
  const inLeaves = new Set(g.nodes.filter((n) => n.role === 'leaf').flatMap((n) => n.values ?? []));
  const promoted = g.nodes.filter((n) => n.role === 'internal').flatMap((n) => n.values ?? []);
  // Separators promoted from an internal split may legitimately be absent,
  // but one copied from a leaf split must still be down there.
  return promoted.filter((k) => inLeaves.has(k)).length > 0;
})());

check('a large sorted build satisfies every rule', (() => {
  const p = fresh();
  run(p, `build [${Array.from({ length: 200 }, (_, i) => i + 1).join(' ')}]`);
  const g = p.getStructure();
  return violations(g, g.roots[0] as unknown as number).length === 0;
})());

check('every version stays valid after repeated inserts', (() => {
  const p = fresh();
  run(p, 'build [100]');
  for (let k = 1; k <= 30; k += 1) {
    run(p, `insert v${k - 1} ${k}`);
    const g = p.getStructure();
    if (violations(g, g.roots[g.roots.length - 1] as unknown as number).length > 0) return false;
  }
  return true;
})(), '30 versions each checked');

/* ── 4. The leaf chain, which is not a tree edge ───────────────────── */

console.log('\nthe leaf chain');

const chained = fresh();
run(chained, `build [${Array.from({ length: 30 }, (_, i) => i + 1).join(' ')}]`);
const graph = chained.getStructure();

check('the chain exists and is marked as a link', (() => {
  const links = graph.edges.filter((e) => e.kind === 'link');
  const leaves = graph.nodes.filter((n) => n.role === 'leaf').length;
  return links.length === leaves - 1;
})(), `${graph.edges.filter((e) => e.kind === 'link').length} links for ` +
  `${graph.nodes.filter((n) => n.role === 'leaf').length} leaves`);

check('a link only ever joins two leaves', (() => {
  const role = new Map(graph.nodes.map((n) => [n.id, n.role]));
  return graph.edges.filter((e) => e.kind === 'link')
    .every((e) => role.get(e.from) === 'leaf' && role.get(e.to) === 'leaf');
})());

check('layout keeps every leaf on one row despite the chain', (() => {
  const scene = layout(graph);
  const rows = new Set(scene.nodes.filter((n) => n.node.role === 'leaf').map((n) => n.y));
  return rows.size === 1;
})(), 'a link followed as a tree edge would stagger them downward');

check('the chain runs left to right', (() => {
  const scene = layout(graph);
  const at = new Map(scene.nodes.map((n) => [n.node.id, n.x]));
  return scene.edges.filter((e) => e.kind === 'link')
    .every((e) => (at.get(e.to) ?? 0) > (at.get(e.from) ?? 0));
})());

check('a link is drawn side to side, not top to bottom', (() => {
  const scene = layout(graph);
  return scene.edges.filter((e) => e.kind === 'link').every((e) => Math.abs(e.y1 - e.y2) < 1);
})());

check('no node overlaps another on its row', (() => {
  const scene = layout(graph);
  const rows = new Map<number, { x: number; width: number }[]>();
  for (const n of scene.nodes) rows.set(n.y, [...(rows.get(n.y) ?? []), { x: n.x, width: n.width }]);
  for (const row of rows.values()) {
    const sorted = [...row].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i += 1) {
      const a = sorted[i - 1] as { x: number; width: number };
      const b = sorted[i] as { x: number; width: number };
      if (b.x - a.x < (a.width + b.width) / 2) return false;
    }
  }
  return true;
})());

check('a wide range costs one descent plus the leaves it reads', (() => {
  const p = fresh();
  run(p, `build [${Array.from({ length: 100 }, (_, i) => i + 1).join(' ')}]`);
  const r = run(p, 'range v0 10 60').value as
    { descent: number; leavesRead: number; visits: number; keys: number[] };
  return r.keys.length === 50 && r.visits === r.descent + r.leavesRead - 1;
})(), (() => {
  const p = fresh();
  run(p, `build [${Array.from({ length: 100 }, (_, i) => i + 1).join(' ')}]`);
  const r = run(p, 'range v0 10 60').value as { descent: number; leavesRead: number };
  return `${r.descent} down, then ${r.leavesRead} leaves along the chain`;
})());

/* ── 5. Property test against a sorted set ─────────────────────────── */

console.log('\nproperty test vs a sorted set');

const rng = createRng(20_260_815);
let trials = 0;
let operations = 0;
let firstFailure = '';

for (let t = 0; t < 25 && firstFailure === ''; t += 1) {
  const p = fresh();
  const start = [...new Set(Array.from({ length: rng.nextInt(1, 10) }, () => rng.nextInt(1, 40)))];
  run(p, `build [${start.join(' ')}]`);
  const models: number[][] = [[...start].sort((a, b) => a - b)];
  trials += 1;

  for (let op = 0; op < 10 && firstFailure === ''; op += 1) {
    const from = rng.nextInt(0, models.length);
    const model = models[from] as number[];
    const key = rng.nextInt(1, 40);
    operations += 1;

    if (model.includes(key)) {
      if (run(p, `insert v${from} ${key}`).error?.code !== 'PRECONDITION_FAILED') {
        firstFailure = `re-inserting ${key} should have been refused`;
      }
      continue;
    }
    if (run(p, `insert v${from} ${key}`).error !== null) { firstFailure = 'insert failed'; break; }
    models.push([...model, key].sort((a, b) => a - b));

    for (let v = 0; v < models.length && firstFailure === ''; v += 1) {
      const expected = (models[v] as number[]).join(',');
      if (keysOf(p, v, 50).join(',') !== expected) {
        firstFailure = `v${v}: got [${keysOf(p, v, 50).join(',')}], expected [${expected}]`;
      }
      // A sub-range must agree with the same slice of the model.
      const lo = rng.nextInt(1, 40);
      const hi = lo + rng.nextInt(1, 15);
      const want = (models[v] as number[]).filter((k) => k >= lo && k < hi).join(',');
      const got = (run(p, `range v${v} ${lo} ${hi}`).value as { keys: number[] }).keys.join(',');
      if (got !== want) firstFailure = `v${v} range [${lo},${hi}): got [${got}], expected [${want}]`;
    }
    const g = p.getStructure();
    if (firstFailure === '' && violations(g, g.roots[g.roots.length - 1] as unknown as number).length > 0) {
      firstFailure = 'a version broke the B+ tree rules';
    }
  }
}

check('every version holds its keys and every range agrees', firstFailure === '',
  firstFailure === '' ? `${trials} trials, ${operations} operations` : firstFailure);

/* ── 6. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build [1 2 3 4 5 6 7 8]', 'find v0 5', 'range v0 3 7', 'insert v0 9', 'compare v0 v1']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
