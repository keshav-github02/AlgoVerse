/**
 * Checks the three properties time travel depends on. Run directly:
 *
 *     node packages/core/src/timeline.check.ts
 *
 * The segment tree below is a fixture, not core logic - it exists only to
 * produce a realistic event log. It moves to the plugin package once the
 * plugin contract lands.
 */

import {
  EMPTY_SCENE, KEYFRAME_INTERVAL, Timeline, fingerprint, reduce,
  type NodeId, type SceneState, type SimEvent,
} from './timeline.ts';

/* ── Fixture: persistent segment tree, emitting events ─────────────── */

interface Fix { readonly id: NodeId; readonly lo: number; readonly hi: number;
                readonly depth: number; readonly val: number;
                readonly left: Fix | null; readonly right: Fix | null }

function segmentTreeLog(arr: readonly number[]): readonly SimEvent[] {
  const events: SimEvent[] = [];
  let next = 0;

  const span = (lo: number, hi: number): string => (hi - lo === 1 ? `i${lo}` : `[${lo},${hi})`);
  const alloc = (value: number, lo: number, hi: number, depth: number, origin: number): NodeId => {
    const id = next++ as NodeId;
    events.push({
      kind: 'NodeAllocated', node: id, value, label: span(lo, hi),
      role: hi - lo === 1 ? 'leaf' : 'internal', depth, slot: `${depth}:${lo}:${hi}`, origin,
    });
    return id;
  };
  const point = (from: NodeId, slot: 'left' | 'right', to: NodeId): void => {
    events.push({ kind: 'PointerSet', from, slot, to });
  };

  const build = (lo: number, hi: number, depth: number): Fix => {
    if (hi - lo === 1) {
      const val = arr[lo] as number;
      return { id: alloc(val, lo, hi, depth, 0), lo, hi, depth, val, left: null, right: null };
    }
    const mid = (lo + hi) >> 1;
    const left = build(lo, mid, depth + 1);
    const right = build(mid, hi, depth + 1);
    const val = left.val + right.val;
    const id = alloc(val, lo, hi, depth, 0);
    point(id, 'left', left.id);
    point(id, 'right', right.id);
    return { id, lo, hi, depth, val, left, right };
  };

  const update = (n: Fix, idx: number, v: number, origin: number): Fix => {
    if (n.hi - n.lo === 1) {
      return { id: alloc(v, n.lo, n.hi, n.depth, origin), lo: n.lo, hi: n.hi, depth: n.depth,
               val: v, left: null, right: null };
    }
    const goLeft = idx < ((n.lo + n.hi) >> 1);
    const left = goLeft ? update(n.left as Fix, idx, v, origin) : (n.left as Fix);
    const right = goLeft ? (n.right as Fix) : update(n.right as Fix, idx, v, origin);
    const val = left.val + right.val;
    const id = alloc(val, n.lo, n.hi, n.depth, origin);
    point(id, 'left', left.id);
    point(id, 'right', right.id);
    events.push({ kind: 'NodeReused', node: goLeft ? right.id : left.id, by: id });
    return { id, lo: n.lo, hi: n.hi, depth: n.depth, val, left, right };
  };

  const v0 = build(0, arr.length, 0);
  events.push({ kind: 'VersionCommitted', version: 0, roots: [v0.id] });
  const v1 = update(v0, 3, 10, 1);
  events.push({ kind: 'VersionCommitted', version: 1, roots: [v1.id] });
  const v2 = update(v1, 6, 7, 2);
  events.push({ kind: 'VersionCommitted', version: 2, roots: [v2.id] });
  return events;
}

/* ── Checks ────────────────────────────────────────────────────────── */

const ARR = [3, 1, 4, 1, 5, 9, 2, 6];
const log = segmentTreeLog(ARR);
const tl = new Timeline();
tl.append(log);

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const naive = (n: number): SceneState => log.slice(0, n).reduce(reduce, EMPTY_SCENE);

console.log(`\nevents=${tl.length}  keyframe interval=${KEYFRAME_INTERVAL}\n`);

// 1. Keyframed lookup must agree with a plain fold from zero, at every step.
let mismatch = -1;
for (let n = 0; n <= tl.length; n++) {
  if (fingerprint(tl.stateAt(n)) !== fingerprint(naive(n))) { mismatch = n; break; }
}
check('stateAt(n) == fold(0..n) for every n', mismatch === -1,
  mismatch === -1 ? `${tl.length + 1} steps` : `first divergence at step ${mismatch}`);

// 2. Time travel: scrubbing backward from the end must reproduce the forward states.
const forward = Array.from({ length: tl.length + 1 }, (_, n) => fingerprint(tl.stateAt(n)));
const backward: string[] = [];
for (let n = tl.length; n >= 0; n--) backward.push(fingerprint(tl.stateAt(n)));
backward.reverse();
check('backward scrub == forward fold', forward.every((f, i) => f === backward[i]));

// 3. Determinism: the same operations must emit a byte-identical log.
check('log is reproducible', JSON.stringify(segmentTreeLog(ARR)) === JSON.stringify(log));

// 4. Persistence: v0 must still read as the original array after both updates.
const final = tl.stateAt(tl.length);
const readAll = (root: NodeId): number[] => {
  const out: number[] = [];
  const walk = (id: NodeId): void => {
    const n = final.nodes.get(id);
    if (n === undefined) return;
    if (n.pointers.size === 0) { out.push(n.value); return; }
    for (const slot of ['left', 'right']) {
      const child = n.pointers.get(slot)?.to;
      if (child !== undefined) walk(child);
    }
  };
  walk(root);
  return out;
};
const [r0, r1, r2] = final.versions.map((v) => v[0]);
check('v0 unchanged by later updates', String(readAll(r0 as NodeId)) === String(ARR),
  `[${readAll(r0 as NodeId)}]`);
check('v1 sees update 3 -> 10', String(readAll(r1 as NodeId)) === String([3, 1, 4, 10, 5, 9, 2, 6]));
check('v2 sees both updates', String(readAll(r2 as NodeId)) === String([3, 1, 4, 10, 5, 9, 7, 6]));

// 5. Sharing actually happened: 23 nodes for 3 versions, not 45.
const stored = final.nodes.size;
const naiveCost = 3 * (2 * ARR.length - 1);
check('memory is shared, not copied', stored === 23,
  `${stored} nodes vs ${naiveCost} naive (${Math.round((1 - stored / naiveCost) * 100)}% saved)`);

/* -- 6. Updating a node's fields without unmaking it -------------- */

console.log('');
console.log('updating fields in place');

const updated = ((): SceneState => {
  const line: SimEvent[] = [
    { kind: 'NodeAllocated', node: 0 as NodeId, value: 1, label: 'a', role: 'branch', slot: 's', origin: 0 },
    { kind: 'NodeAllocated', node: 1 as NodeId, value: 2, label: 'b', role: 'leaf', slot: 's', origin: 0 },
    { kind: 'PointerSet', from: 0 as NodeId, slot: 'left', to: 1 as NodeId },
    { kind: 'NodeUpdated', node: 0 as NodeId, label: 'ab', value: 7 },
  ];
  return line.reduce(reduce, EMPTY_SCENE);
})();

check('an update changes the fields it names', (() => {
  const n = updated.nodes.get(0 as NodeId);
  return n?.label === 'ab' && n.value === 7;
})());

check('and leaves the ones it does not', (() => {
  // The whole reason this is not a second NodeAllocated.
  const n = updated.nodes.get(0 as NodeId);
  return n?.role === 'branch' && n.slot === 's' && n.origin === 0;
})());

check('and keeps every pointer', (() => {
  /*
   * Allocating the node again would have cleared this, which is what made the
   * event necessary: a suffix tree splitting an edge changes what the surviving
   * half spells while its children stay exactly where they were.
   */
  const n = updated.nodes.get(0 as NodeId);
  return n?.pointers.get('left')?.to === (1 as NodeId);
})(), 'left still points at node 1');

check('updating a node that is not there is ignored, not fatal', (() => {
  // Replaying part of a log has to be possible, so an update to something the
  // prefix has not allocated is a no-op - the same as deleting it.
  const after = reduce(updated, { kind: 'NodeUpdated', node: 9 as NodeId, label: 'x' });
  return after.nodes.size === updated.nodes.size && !after.nodes.has(9 as NodeId);
})());

check('an update folds like any other event, so scrubbing sees it', (() => {
  const line: SimEvent[] = [
    { kind: 'NodeAllocated', node: 0 as NodeId, value: 1, label: 'a', role: 'r', slot: 's', origin: 0 },
    { kind: 'NodeUpdated', node: 0 as NodeId, label: 'b' },
    { kind: 'NodeUpdated', node: 0 as NodeId, label: 'c' },
  ];
  const t = new Timeline();
  t.append(line);
  return t.stateAt(1).nodes.get(0 as NodeId)?.label === 'a'
    && t.stateAt(2).nodes.get(0 as NodeId)?.label === 'b'
    && t.stateAt(3).nodes.get(0 as NodeId)?.label === 'c';
})(), 'rewinding an update puts the old label back');

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
