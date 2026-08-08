/**
 * Checks the app's engine wiring without a browser.
 *
 *     node apps/web/src/engine.check.ts
 *
 * `engine.ts` deliberately touches no DOM API, which is what makes this
 * possible — and is the same property that keeps the event log out of React.
 */

import type { NodeId } from '@algoverse/core';
import { PLUGINS, Session, describeEvent } from './engine.ts';
import { computeDiff } from './diff.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const segTree = PLUGINS.find((p) => p.meta.id === 'persistent-segment-tree');
const stackPlugin = PLUGINS.find((p) => p.meta.id === 'stack');
if (segTree === undefined || stackPlugin === undefined) throw new Error('plugins missing');

/* ── Running commands ──────────────────────────────────────────────── */

console.log('\nsession');

const s = new Session(segTree);
check('starts empty', s.view().scene.nodes.length === 0 && s.playback.length === 0);

s.run('build [3 1 4 1 5 9 2 6]');
check('build populates the scene', s.view().scene.nodes.length === 15,
  `${s.view().scene.nodes.length} nodes`);
check('playback jumps to the end after a command', s.playback.step === s.playback.length,
  `${s.playback.step}/${s.playback.length}`);

s.run('update v0 3 10');
s.run('update v1 6 7');
check('two updates add 8 nodes', s.view().scene.nodes.length === 23,
  `${s.view().scene.nodes.length} nodes`);
check('statistics accumulate', s.stats.versions === 3 && s.stats.updates === 2,
  `${s.stats.versions} versions, ${s.stats.updates} writes`);
check('marks record one boundary per command', s.playback.marks.length === 3,
  s.playback.marks.map((m) => m.label).join(' | '));

s.run('query v1 2 5');
check('a query records its answer',
  (s.history[s.history.length - 1] as { text: string }).text.includes('"sum":19'),
  (s.history[s.history.length - 1] as { text: string }).text);

/* ── Errors ────────────────────────────────────────────────────────── */

console.log('\nerrors');

s.run('query v9 0 1');
const bad = s.history[s.history.length - 1];
check('a bad command is recorded, not thrown', bad?.ok === false && bad.error?.code === 'UNKNOWN_VERSION');
check('the hint survives to the console', (bad?.error?.hint ?? '').includes('v0'), bad?.error?.hint ?? '');

s.run('updat v0 1 2');
const typo = s.history[s.history.length - 1];
check('a parse error carries a span to underline',
  typo?.error?.code === 'UNKNOWN_COMMAND' && typo.error.span !== undefined,
  typo?.error?.span === undefined ? '' : `[${typo.error.span[0]},${typo.error.span[1]}]`);
check('a failed command adds no events', s.playback.length === s.playback.marks[3]?.index,
  `${s.playback.length} events`);

/* ── Scrubbing ─────────────────────────────────────────────────────── */

console.log('\nscrubbing');

s.playback.first();
check('rewinding to zero empties the canvas', s.view().scene.nodes.length === 0);
s.playback.nextMark();
check('one operation forward shows the built tree', s.view().scene.nodes.length === 15,
  `${s.view().scene.nodes.length} nodes`);
s.playback.last();
check('returning to the end restores every node', s.view().scene.nodes.length === 23);

check('nodes never move while scrubbing a fixed log', (() => {
  const seen = new Map<NodeId, string>();
  for (let step = 0; step <= s.playback.length; step += 1) {
    s.playback.seek(step);
    for (const n of s.view().scene.nodes) {
      const at = `${n.x},${n.y}`;
      const before = seen.get(n.node.id);
      if (before !== undefined && before !== at) return false;
      seen.set(n.node.id, at);
    }
  }
  return true;
})(), `${s.playback.length + 1} steps`);

check('edges are dropped when either end is absent', (() => {
  for (let step = 0; step <= s.playback.length; step += 1) {
    s.playback.seek(step);
    const v = s.view();
    const present = new Set(v.scene.nodes.map((n) => n.node.id));
    if (v.scene.edges.some((e) => !present.has(e.from) || !present.has(e.to))) return false;
  }
  return true;
})());

s.playback.last();
check('the inspector can read a node from the replayed state', (() => {
  const state = s.view().state;
  const first = [...state.nodes.keys()][0];
  return first !== undefined && state.nodes.get(first)?.slot !== undefined;
})());

/* ── Version comparison ────────────────────────────────────────────── */

console.log('\ncompare');

s.playback.last();
const versions = s.view().state.versions;
check('the replayed scene exposes three versions', versions.length === 3, `${versions.length}`);

const d01 = computeDiff(s.view().state, s.layoutHint, 0, 1);
check('v0 vs v1 shares everything off the update path',
  d01?.diff.shared.length === 11 && d01.diff.onlyA.length === 4 && d01.diff.onlyB.length === 4,
  d01 === null ? '' : `${d01.diff.shared.length} shared, ${d01.diff.onlyA.length} only v0, ${d01.diff.onlyB.length} only v1`);
check('an update reuses most of the previous version',
  Math.round((d01?.diff.sharedRatio ?? 0) * 100) === 73,
  `${Math.round((d01?.diff.sharedRatio ?? 0) * 100)}% of v1 reused`);
check('exactly log2(8)+1 nodes are new per update', d01?.diff.onlyB.length === 4);
check('shared nodes read as primary, differing as secondary', (() => {
  if (d01 === null) return false;
  const shared = d01.diff.shared[0];
  const only = d01.diff.onlyB[0];
  return shared !== undefined && only !== undefined
    && d01.emphasis.get(shared) === 'primary' && d01.emphasis.get(only) === 'secondary';
})());
check('v0 vs v2 shares less than v0 vs v1', (() => {
  const d02 = computeDiff(s.view().state, s.layoutHint, 0, 2);
  return d02 !== null && d01 !== null && d02.diff.sharedRatio < d01.diff.sharedRatio;
})());
check('the console command agrees with the view', (() => {
  s.run('compare v0 v1');
  const text = (s.history[s.history.length - 1] as { text: string }).text;
  return text.includes('"shared":11') && text.includes('"sharedPercent":73');
})(), (s.history[s.history.length - 1] as { text: string }).text);

check('a structure with no versions offers no comparison', (() => {
  const noHistory = new Session(stackPlugin);
  noHistory.run('push 1');
  return noHistory.view().state.versions.length === 0;
})());

/* ── Event descriptions ────────────────────────────────────────────── */

console.log('\nstatus line');

check('every event kind produces a description', (() => {
  s.playback.first();
  for (let step = 1; step <= s.playback.length; step += 1) {
    s.playback.seek(step);
    if (describeEvent(s.currentEvent()).length === 0) return false;
  }
  return true;
})());
check('step zero reads as ready', (() => { s.playback.first(); return describeEvent(s.currentEvent()) === 'ready'; })());

/* ── The other plugin ──────────────────────────────────────────────── */

console.log('\nsecond plugin');

const t = new Session(stackPlugin);
for (const line of ['push 3', 'push 7', 'pop']) t.run(line);
check('the same session drives a different structure', t.view().scene.nodes.length === 1,
  `${t.view().scene.nodes.length} node`);
check('deleted nodes leave the canvas', (() => {
  t.playback.seek(t.playback.marks[1]?.index ?? 0);
  return t.view().scene.nodes.length === 2;
})());
check('its commands differ from the first plugin',
  t.plugin.commands.map((c) => c.name).join(',') === 'push,pop,peek',
  t.plugin.commands.map((c) => c.name).join(','));

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
