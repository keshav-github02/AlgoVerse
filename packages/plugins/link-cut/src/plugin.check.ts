/**
 * Conformance, every answer against a forest held in a plain parent array, the
 * connectivity answers against the Euler tour tree, and the drawn splay forest
 * against the tree it is supposed to represent.
 *
 *     node packages/plugins/link-cut/src/plugin.check.ts
 */

import {
  createRng, help, parseCommand,
  type NodeId, type OperationError, type StructureGraph,
} from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { eulerTour } from '@algoverse/plugin-euler-tour';
import { linkCut as plugin } from './plugin.ts';

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

const at = (r: { value: unknown }, key: string): unknown =>
  (r.value as Record<string, unknown> | null)?.[key];

/* ── A forest anyone can read ──────────────────────────────────────── */

/**
 * The same forest in a parent array, with every question answered by walking.
 *
 * Linear and impossible to misread. A link-cut tree is an intricate amount of
 * machinery for answers that are this easy to state, which is exactly why the
 * reference has to be this dull.
 */
class Naive {
  readonly parent = new Map<number, number | null>();

  constructor(vertices: readonly number[]) {
    for (const v of vertices) this.parent.set(v, null);
  }

  root(v: number): number {
    let cur = v;
    for (;;) {
      const up = this.parent.get(cur) ?? null;
      if (up === null) return cur;
      cur = up;
    }
  }

  /** Root first, v last. */
  pathTo(v: number): number[] {
    const out: number[] = [];
    let cur: number | null = v;
    while (cur !== null) {
      out.push(cur);
      cur = this.parent.get(cur) ?? null;
    }
    return out.reverse();
  }

  connected(a: number, b: number): boolean {
    return this.root(a) === this.root(b);
  }

  lca(a: number, b: number): number | null {
    if (!this.connected(a, b)) return null;
    const up = new Set(this.pathTo(a));
    let cur: number | null = b;
    while (cur !== null) {
      if (up.has(cur)) return cur;
      cur = this.parent.get(cur) ?? null;
    }
    return null;
  }

  link(a: number, b: number): void {
    this.parent.set(a, b);
  }

  /** Returns the vertex that was detached, or null when there is no such edge. */
  cut(a: number, b: number): number | null {
    if ((this.parent.get(a) ?? null) === b) { this.parent.set(a, null); return a; }
    if ((this.parent.get(b) ?? null) === a) { this.parent.set(b, null); return b; }
    return null;
  }

  evert(v: number): void {
    // The chain from v up to its root, turned round one step at a time.
    const chain = this.pathTo(v);
    for (let i = chain.length - 1; i > 0; i -= 1) {
      this.parent.set(chain[i - 1] as number, chain[i] as number);
    }
    this.parent.set(v, null);
  }
}

/* ── Reading the represented forest back off the picture ───────────── */

/**
 * What the drawn splay forest says the tree is.
 *
 * A splay tree's in-order walk is its path from shallowest to deepest, so each
 * vertex's parent is the one before it in that walk, and the first one's parent
 * is wherever the splay root's path-parent points. If this does not agree with
 * the parent array, then whatever is on screen is not a picture of the forest -
 * and no amount of the answers being right would make it one.
 */
function forestFromPicture(g: StructureGraph): Map<number, number | null> | string {
  const label = new Map<NodeId, number>();
  for (const n of g.nodes) label.set(n.id, n.value);

  const left = new Map<NodeId, NodeId>();
  const right = new Map<NodeId, NodeId>();
  const pathParent = new Map<NodeId, NodeId>();
  const hasSplayParent = new Set<NodeId>();

  for (const e of g.edges) {
    if (e.slot === 'left' || e.slot === 'right') {
      if (hasSplayParent.has(e.to)) return `node ${e.to} has two splay parents`;
      hasSplayParent.add(e.to);
      (e.slot === 'left' ? left : right).set(e.from, e.to);
    } else if (e.slot === 'path') {
      pathParent.set(e.from, e.to);
    } else {
      return `unexpected slot "${e.slot}"`;
    }
  }

  const out = new Map<number, number | null>();
  let placed = 0;
  for (const n of g.nodes) {
    if (hasSplayParent.has(n.id)) continue;
    // A path-parent describes a splay tree, so only its root may carry one.
    const order: NodeId[] = [];
    const walk = (id: NodeId): void => {
      const l = left.get(id);
      if (l !== undefined) walk(l);
      order.push(id);
      const r = right.get(id);
      if (r !== undefined) walk(r);
    };
    walk(n.id);
    placed += order.length;
    const above = pathParent.get(n.id);
    order.forEach((id, i) => {
      const parent = i === 0 ? above : (order[i - 1] as NodeId);
      out.set(label.get(id) as number, parent === undefined ? null : label.get(parent) as number);
    });
  }

  for (const [from] of pathParent) {
    if (hasSplayParent.has(from)) return `node ${from} carries a path-parent but is not a splay root`;
  }
  if (placed !== g.nodes.length) return `${placed} of ${g.nodes.length} nodes are in a splay tree`;
  return out;
}

/** Sorted, because the order the picture is read in is not part of the forest. */
function canonical(forest: Map<number, number | null>): string {
  return [...forest]
    .sort((a, b) => a[0] - b[0])
    .map(([v, p]) => `${v}<-${p ?? '.'}`)
    .join(' ');
}

function sameForest(got: Map<number, number | null>, want: Map<number, number | null>): string {
  if (got.size !== want.size) return `picture has ${got.size} vertices, the forest has ${want.size}`;
  for (const [v, p] of want) {
    const mine = got.get(v) ?? null;
    if (mine !== (p ?? null)) return `picture says ${v}'s parent is ${mine}, it should be ${p}`;
  }
  return '';
}

/* ── The Euler tour tree, asked the same connectivity questions ───── */

class Euler {
  readonly inst: PluginInstance;

  constructor(build: string) {
    this.inst = eulerTour.createInstance({ rng: createRng(7) });
    this.send(build);
  }

  send(line: string): boolean {
    const parsed = parseCommand(line, eulerTour.commands);
    if (!parsed.ok) return false;
    return this.inst.execute(parsed.command).ok;
  }

  connected(a: number, b: number): boolean | null {
    const parsed = parseCommand(`connected ${a} ${b}`, eulerTour.commands);
    if (!parsed.ok) return null;
    const r = this.inst.execute(parsed.command);
    if (!r.ok) return null;
    return (r.value as { connected: boolean }).connected;
  }
}

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, [
  'build [2 1 3 1 4 2 5 2 6 3]', 'path 5', 'lca 5 6', 'cut 4 2', 'link 4 6', 'evert 5', 'root 1',
])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. A worked example ───────────────────────────────────────────── */

console.log('\na tree of six');

/*
 *        1
 *       / \
 *      2   3
 *     / \   \
 *    4   5   6
 */
const shape = 'build [2 1 3 1 4 2 5 2 6 3]';
const inst = fresh();
run(inst, shape);

check('a path is read from the root down', (() => {
  const r = run(inst, 'path 5');
  // 1, 2, 5: three vertices, adding to 8, largest 5.
  return at(r, 'length') === 3 && at(r, 'total') === 8
    && at(r, 'largest') === 5 && at(r, 'root') === 1;
})(), '1 -> 2 -> 5 is three vertices totalling 8');

check('the root of a deep vertex is the root of the tree',
  at(run(inst, 'root 6'), 'root') === 1);

check('the common ancestor is where the second climb meets the first', (() => {
  return at(run(inst, 'lca 4 5'), 'lca') === 2
    && at(run(inst, 'lca 4 6'), 'lca') === 1
    && at(run(inst, 'lca 5 5'), 'lca') === 5;
})(), '4 and 5 meet at 2; 4 and 6 at the root; a vertex meets itself');

check('an ancestor is its own meeting point with a descendant', (() => {
  // The case where the second access makes no path-parent jump at all.
  return at(run(inst, 'lca 2 5'), 'lca') === 2 && at(run(inst, 'lca 5 2'), 'lca') === 2;
})());

check('cutting splits one tree into two', (() => {
  const q = fresh();
  run(q, shape);
  const r = run(q, 'cut 2 1');
  return at(r, 'detached') === 2 && at(r, 'trees') === 2
    && at(run(q, 'connected 4 1'), 'connected') === false
    && at(run(q, 'root 4'), 'root') === 2
    && at(run(q, 'root 6'), 'root') === 1;
})(), '4 and 5 go with 2; 3 and 6 stay with 1');

check('the order of the two vertices does not matter to cut', (() => {
  const q = fresh();
  run(q, shape);
  // `cut 1 2` has to find that 2 is the child, since only a child can be
  // detached - a parent has no single edge to lose.
  return at(run(q, 'cut 1 2'), 'detached') === 2;
})());

check('linking joins them back', (() => {
  const q = fresh();
  run(q, shape);
  run(q, 'cut 2 1');
  run(q, 'link 2 6');
  return at(run(q, 'connected 4 1'), 'connected') === true
    && at(run(q, 'path 4'), 'length') === 5
    && at(run(q, 'root 4'), 'root') === 1;
})(), '1 -> 3 -> 6 -> 2 -> 4 is five vertices now');

check('evert turns the tree upside down', (() => {
  const q = fresh();
  run(q, shape);
  run(q, 'evert 5');
  /*
   * Only the path 5 -> 2 -> 1 turns round. Everything hanging off that path
   * keeps its parent, so 4 is still under 2 and is still three deep. What
   * moves is the far corner: 6 hangs under 3 under 1, and 1 has gone from the
   * top of the tree to the bottom of the new path, so 6 is now five deep.
   */
  return at(run(q, 'root 1'), 'root') === 5
    && at(run(q, 'path 1'), 'length') === 3
    && at(run(q, 'path 4'), 'length') === 3
    && at(run(q, 'path 6'), 'length') === 5;
})(), '5 -> 2 -> 1 turns round; 6 goes from three deep to five');

check('evert on a root changes nothing but says so', (() => {
  const q = fresh();
  run(q, shape);
  const r = run(q, 'evert 1');
  return at(r, 'alreadyRoot') === true && at(run(q, 'root 5'), 'root') === 1;
})());

/* ── 3. The picture is a picture of the forest ─────────────────────── */

console.log('\nthe drawn splay forest against the tree it stands for');

check('the represented forest can be read back off the picture', (() => {
  const q = fresh();
  run(q, shape);
  const naive = new Naive([1, 2, 3, 4, 5, 6]);
  for (const [c, p] of [[2, 1], [3, 1], [4, 2], [5, 2], [6, 3]] as const) naive.link(c, p);

  const got = forestFromPicture(q.getStructure());
  return typeof got !== 'string' && sameForest(got, naive.parent) === '';
})(), 'in-order within each splay tree, then path-parents between them');

check('and still after every kind of operation', (() => {
  const q = fresh();
  run(q, shape);
  const naive = new Naive([1, 2, 3, 4, 5, 6]);
  for (const [c, p] of [[2, 1], [3, 1], [4, 2], [5, 2], [6, 3]] as const) naive.link(c, p);

  for (const line of ['path 4', 'lca 4 6', 'cut 5 2', 'evert 6', 'link 5 4', 'root 5']) {
    run(q, line);
    if (line.startsWith('cut ')) {
      const [, a, b] = line.split(' ');
      naive.cut(Number(a), Number(b));
    } else if (line.startsWith('link ')) {
      const [, a, b] = line.split(' ');
      naive.link(Number(a), Number(b));
    } else if (line.startsWith('evert ')) {
      naive.evert(Number(line.split(' ')[1]));
    }
    const got = forestFromPicture(q.getStructure());
    if (typeof got === 'string') return false;
    if (sameForest(got, naive.parent) !== '') return false;
  }
  return true;
})(), 'queries rearrange the splay trees without changing what they mean');

check('a query changes the picture without changing the forest', (() => {
  /*
   * The distinction the whole structure rests on: accessing a vertex is a
   * rearrangement of storage, and the tree it stores is untouched.
   */
  const q = fresh();
  run(q, shape);
  const forest = (): string =>
    canonical(forestFromPicture(q.getStructure()) as Map<number, number | null>);
  const drawn = (): string => JSON.stringify(q.getStructure().edges);

  const forestBefore = forest();
  run(q, 'path 6');
  const drawnAfterSix = drawn();
  run(q, 'path 4');

  // Asking about 6 and then about 4 makes two different paths preferred, so
  // the splay forest must have been rearranged - and the forest it stands for
  // must not have been.
  return forest() === forestBefore && drawn() !== drawnAfterSix && forestBefore !== '';
})(), 'the same tree, stored differently');

/* ── 4. Refusing ───────────────────────────────────────────────────── */

console.log('\nerrors');

check('nothing can be asked before a build', (() => {
  const parsed = parseCommand('root 1', plugin.commands);
  if (!parsed.ok) return false;
  const r = fresh().execute(parsed.command);
  return !r.ok && r.error.code === 'PRECONDITION_FAILED';
})());
check('an odd list is refused, with the reading explained',
  (run(fresh(), 'build [1 2 3]').error?.hint ?? '').includes('hangs 2 and 3 under 1'));
check('a vertex cannot be its own parent',
  (run(fresh(), 'build [1 1]').error?.hint ?? '').includes('no edge from a vertex to itself'));
check('two parents for one vertex is refused, naming both', (() => {
  const r = run(fresh(), 'build [2 1 2 3]');
  return r.error?.code === 'BAD_ARGUMENT' && (r.error.message).includes('two parents, 1 and 3');
})());
check('a cycle is refused', (() => {
  const r = run(fresh(), 'build [2 1 3 2 1 3]');
  return r.error?.code === 'BAD_ARGUMENT' && (r.error.hint ?? '').includes('no cycles');
})());
check('linking something that is not a root is refused, and says what to do', (() => {
  const q = fresh();
  run(q, shape);
  const r = run(q, 'link 4 6');
  return r.error?.code === 'PRECONDITION_FAILED' && (r.error.hint ?? '').includes('evert 4 first');
})());
check('linking two vertices of one tree is refused as a cycle', (() => {
  const q = fresh();
  run(q, shape);
  return (run(q, 'link 1 6').error?.hint ?? '').includes('close a cycle');
})());
check('cutting two vertices that are not joined is refused', (() => {
  const q = fresh();
  run(q, shape);
  // 4 and 5 are siblings: one tree, one path between them, no edge.
  return (run(q, 'cut 4 5').error?.hint ?? '').includes('not any two vertices of a path');
})());
check('cutting across two trees is refused', (() => {
  const q = fresh();
  run(q, shape);
  run(q, 'cut 3 1');
  return (run(q, 'cut 6 1').error?.hint ?? '').includes('no edge between them');
})());
check('an unknown vertex is refused, and the known ones are listed', (() => {
  const q = fresh();
  run(q, shape);
  const r = run(q, 'root 9');
  return r.error?.code === 'BAD_ARGUMENT' && (r.error.hint ?? '').includes('1 2 3 4 5 6');
})());

/* ── 5. Property test ──────────────────────────────────────────────── */

console.log('\nproperty test vs a parent array, and vs the Euler tour tree');

const rng = createRng(20_260_901);
let trials = 0;
let operations = 0;
let cuts = 0;
let links = 0;
let everts = 0;
let firstFailure = '';

for (let t = 0; t < 40 && firstFailure === ''; t += 1) {
  const n = rng.nextInt(4, 10);
  const vertices = Array.from({ length: n }, (_, i) => i + 1);

  // A random tree on 1..n: every vertex above the first gets a parent already
  // present, which cannot make a cycle and mentions every vertex.
  const pairs: number[] = [];
  const naive = new Naive(vertices);
  for (let v = 2; v <= n; v += 1) {
    const p = rng.nextInt(1, v);
    pairs.push(v, p);
    naive.link(v, p);
  }

  const q = fresh();
  const build = `build [${pairs.join(' ')}]`;
  const built = run(q, build);
  if (built.error !== null) { firstFailure = `${build}: ${built.error.message}`; break; }
  trials += 1;

  // The same forest as an Euler tour tree. It reads the pairs as undirected
  // edges, has no notion of a root, and answers connectivity by a completely
  // different route - so it is worth asking the same questions of.
  const euler = new Euler(build);

  for (let step = 0; step < 24 && firstFailure === ''; step += 1) {
    const roll = rng.next();
    const a = vertices[rng.nextInt(0, n)] as number;
    const b = vertices[rng.nextInt(0, n)] as number;

    if (roll < 0.2) {
      // Cut a real edge, chosen from the reference so the operation is legal.
      const edges = [...naive.parent].filter(([, p]) => p !== null);
      if (edges.length === 0) continue;
      const [child, parent] = edges[rng.nextInt(0, edges.length)] as [number, number];
      const r = run(q, `cut ${child} ${parent}`);
      if (r.error !== null) { firstFailure = `cut ${child} ${parent}: ${r.error.message}`; break; }
      naive.cut(child, parent);
      euler.send(`cut ${child} ${parent}`);
      cuts += 1;
      operations += 1;
    } else if (roll < 0.4) {
      // Link needs a root on the left, so evert first when it is not one -
      // which is precisely what evert is for.
      if (naive.connected(a, b)) continue;
      if (naive.root(a) !== a) {
        const r = run(q, `evert ${a}`);
        if (r.error !== null) { firstFailure = `evert ${a}: ${r.error.message}`; break; }
        naive.evert(a);
        everts += 1;
      }
      const r = run(q, `link ${a} ${b}`);
      if (r.error !== null) { firstFailure = `link ${a} ${b}: ${r.error.message}`; break; }
      naive.link(a, b);
      euler.send(`link ${a} ${b}`);
      links += 1;
      operations += 1;
    } else if (roll < 0.5) {
      const r = run(q, `evert ${a}`);
      if (r.error !== null) { firstFailure = `evert ${a}: ${r.error.message}`; break; }
      naive.evert(a);
      everts += 1;
      operations += 1;
    }

    /* Every question, every step. */

    const rootR = run(q, `root ${a}`);
    if (at(rootR, 'root') !== naive.root(a)) {
      firstFailure = `root ${a} gave ${at(rootR, 'root')}, walking up gives ${naive.root(a)}`;
      break;
    }

    const pathR = run(q, `path ${a}`);
    const want = naive.pathTo(a);
    if (at(pathR, 'length') !== want.length
      || at(pathR, 'total') !== want.reduce((s, v) => s + v, 0)
      || at(pathR, 'largest') !== Math.max(...want)) {
      firstFailure = `path ${a} gave ${JSON.stringify(pathR.value)}, the path is [${want}]`;
      break;
    }

    const connR = run(q, `connected ${a} ${b}`);
    const wantConnected = naive.connected(a, b);
    if (at(connR, 'connected') !== wantConnected) {
      firstFailure = `connected ${a} ${b} gave ${at(connR, 'connected')}, walking gives ${wantConnected}`;
      break;
    }
    // And the same question of a structure that stores the forest as a
    // sequence rather than as paths.
    const theirs = euler.connected(a, b);
    if (theirs !== wantConnected) {
      firstFailure = `Euler tour says ${a}-${b} connected is ${String(theirs)}, it is ${wantConnected}`;
      break;
    }

    const wantLca = naive.lca(a, b);
    const lcaR = run(q, `lca ${a} ${b}`);
    if (wantLca === null) {
      if (lcaR.error === null) {
        firstFailure = `lca ${a} ${b} answered ${at(lcaR, 'lca')} for vertices in different trees`;
        break;
      }
    } else if (at(lcaR, 'lca') !== wantLca) {
      firstFailure = `lca ${a} ${b} gave ${at(lcaR, 'lca')}, walking gives ${wantLca}`;
      break;
    }

    // And the picture still stands for the forest.
    const picture = forestFromPicture(q.getStructure());
    if (typeof picture === 'string') { firstFailure = `picture: ${picture}`; break; }
    const disagreement = sameForest(picture, naive.parent);
    if (disagreement !== '') { firstFailure = disagreement; break; }
  }
}

check('every answer matches a parent array, and the picture matches the forest',
  firstFailure === '',
  firstFailure === ''
    ? `${trials} forests, ${operations} changes (${cuts} cuts, ${links} links, ${everts} everts)`
    : firstFailure);

check('the forest really was cut apart and rebuilt',
  cuts > 20 && links > 10 && everts > 10,
  `${cuts} cuts, ${links} links, ${everts} everts`);

/* ── 6. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of [shape, 'path 5', 'lca 4 6', 'cut 2 1', 'connected 4 6', 'link 2 6', 'evert 5']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
