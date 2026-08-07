/**
 * Playback checks. Run directly:
 *
 *     node packages/core/src/playback.check.ts
 */

import { BASE_RATE, Playback } from './playback.ts';
import { sceneToStructure } from './scene.ts';
import { Timeline, fingerprint, type NodeId, type SimEvent } from './timeline.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

/** Three small operations: two allocations, a pointer, then a deletion. */
function makeTimeline(): Timeline {
  const tl = new Timeline();
  const node = (id: number, value: number, depth: number): SimEvent => ({
    kind: 'NodeAllocated', node: id as NodeId, value,
    label: `n${id}`, role: 'cell', depth, slot: `pos:${depth}`, origin: 0,
  });
  tl.append([node(0, 10, 0), { kind: 'RootsSet', roots: [0 as NodeId] }], 'push 10');
  tl.append([
    node(1, 20, 1),
    { kind: 'PointerSet', from: 1 as NodeId, slot: 'below', to: 0 as NodeId },
    { kind: 'RootsSet', roots: [1 as NodeId] },
  ], 'push 20');
  tl.append([
    { kind: 'NodeVisited', node: 1 as NodeId },
    { kind: 'NodeDeleted', node: 1 as NodeId },
    { kind: 'RootsSet', roots: [0 as NodeId] },
  ], 'pop');
  return tl;
}

const tl = makeTimeline();

/* ── Position ──────────────────────────────────────────────────────── */

console.log('\nposition');

const p = new Playback(tl);
check('starts at zero', p.step === 0 && !p.playing);
check('length matches the log', p.length === tl.length, `${p.length} events`);
check('next advances one step', p.next() && p.step === 1);
check('prev goes back', p.prev() && p.step === 0);
check('prev at the start is a no-op', !p.prev() && p.step === 0);
check('seek clamps above', (() => { p.seek(9999); return p.step === p.length; })());
check('next at the end is a no-op', !p.next() && p.step === p.length);
check('seek clamps below', (() => { p.seek(-50); return p.step === 0; })());
check('seek truncates fractions', (() => { p.seek(3.9); return p.step === 3; })());

/* ── Coarse stepping ───────────────────────────────────────────────── */

console.log('\ncoarse stepping');

check('marks record one boundary per operation', p.marks.length === 3,
  p.marks.map((m) => `${m.label}@${m.index}`).join(' '));
p.first();
check('nextMark lands on the end of the first operation',
  p.nextMark() && p.step === (p.marks[0] as { index: number }).index);
check('nextMark again reaches the second', p.nextMark() && p.step === (p.marks[1] as { index: number }).index);
check('prevMark goes back one operation', p.prevMark() && p.step === (p.marks[0] as { index: number }).index);
check('nextMark from the last mark runs to the end',
  (() => { p.seek((p.marks[2] as { index: number }).index); p.nextMark(); return p.step === p.length; })());
check('currentMark names the operation in progress',
  (() => { p.seek(1); return p.currentMark()?.label === 'push 10'; })(),
  (() => { p.seek(1); return p.currentMark()?.label ?? '—'; })());

/* ── The clock ─────────────────────────────────────────────────────── */

console.log('\nclock');

const q = new Playback(tl);
check('a paused playback ignores ticks', !q.tick(1000) && q.step === 0);
q.play();
check('play sets the flag', q.playing);
check('a tick shorter than one step does not move',
  !q.tick(1000 / BASE_RATE / 4) && q.step === 0);
check('fractional time accumulates rather than being lost', (() => {
  for (let i = 0; i < 3; i += 1) q.tick(1000 / BASE_RATE / 4);
  return q.step === 1;
})(), `step ${q.step}`);
check('one second advances by the base rate', (() => {
  const r = new Playback(makeTimeline());
  r.play();
  r.tick(1000);
  return r.step === Math.min(BASE_RATE, r.length);
})());
check('double speed advances twice as fast', (() => {
  const r = new Playback(makeTimeline());
  r.setSpeed(2);
  r.play();
  r.tick(250);
  return r.step === Math.round((250 / 1000) * BASE_RATE * 2);
})());
check('speed is clamped to a usable range', (() => {
  const r = new Playback(tl);
  r.setSpeed(1000);
  const high = r.speed;
  r.setSpeed(-5);
  return high === 16 && r.speed === 0.1;
})());
check('playback pauses at the end instead of looping', (() => {
  const r = new Playback(makeTimeline());
  r.play();
  r.tick(10_000);
  return r.step === r.length && !r.playing;
})());
check('play from the end restarts', (() => {
  const r = new Playback(makeTimeline());
  r.last();
  r.play();
  return r.step === 0 && r.playing;
})());

/* ── Subscriptions ─────────────────────────────────────────────────── */

console.log('\nsubscriptions');

const s = new Playback(tl);
let calls = 0;
const stop = s.subscribe(() => { calls += 1; });
s.next();
s.next();
const afterMoves = calls;
s.prev();
s.prev();
s.prev();
const afterNoOp = calls;
stop();
s.next();
check('every move notifies', afterMoves === 2, `${afterMoves} calls`);
check('a no-op move does not notify', afterNoOp === 4, `${afterNoOp} calls`);
check('unsubscribing stops notifications', calls === afterNoOp);

/* ── The picture comes from the log ────────────────────────────────── */

console.log('\nreplay');

const r = new Playback(tl);
check('scene at a step matches folding to that step', (() => {
  for (let i = 0; i <= tl.length; i += 1) {
    r.seek(i);
    if (fingerprint(r.scene()) !== fingerprint(tl.stateAt(i))) return false;
  }
  return true;
})(), `${tl.length + 1} steps`);

check('a mid-operation state is drawable', (() => {
  r.seek(4);
  const g = sceneToStructure(r.scene(), 'linear');
  return g.nodes.length > 0 && g.nodes.every((n) => n.slot.length > 0);
})());

check('a deleted node leaves the derived structure', (() => {
  r.last();
  const g = sceneToStructure(r.scene(), 'linear');
  return g.nodes.length === 1 && g.roots.length === 1 && g.edges.length === 0;
})());

check('scrubbing backwards restores the earlier picture', (() => {
  r.last();
  const atEnd = fingerprint(r.scene());
  r.seek(5);
  const mid = fingerprint(r.scene());
  r.last();
  r.seek(5);
  return fingerprint(r.scene()) === mid && atEnd !== mid;
})());

check('roots pointing at deleted nodes are dropped', (() => {
  const t = new Timeline();
  t.append([
    { kind: 'NodeAllocated', node: 0 as NodeId, value: 1, label: 'a',
      role: 'cell', depth: 0, slot: 'p0', origin: 0 },
    { kind: 'RootsSet', roots: [0 as NodeId] },
    { kind: 'NodeDeleted', node: 0 as NodeId },
  ]);
  return sceneToStructure(t.stateAt(t.length), 'linear').roots.length === 0;
})());

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
