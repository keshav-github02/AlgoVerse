/**
 * Checks the app's engine wiring without a browser.
 *
 *     node apps/web/src/engine.check.ts
 *
 * `engine.ts` deliberately touches no DOM API, which is what makes this
 * possible - and is the same property that keeps the event log out of React.
 */

import {
  classify, decodeSimulation, describeEvent, encodeSimulation, fingerprint, type NodeId,
} from '@algoverse/core';
import { PLUGINS, Session } from './engine.ts';
import { computeDiff } from './diff.ts';
import { chartGeometry, measurePlugin } from './complexity.ts';

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

/* ── Explanations ──────────────────────────────────────────────────── */

console.log('\nexplanations');

check('every step explains itself', (() => {
  for (let step = 0; step <= s.playback.length; step += 1) {
    s.playback.seek(step);
    if (s.explanation().trim().length === 0) return false;
  }
  return true;
})(), `${s.playback.length + 1} steps`);

check('explanations are deterministic', (() => {
  s.playback.seek(20);
  const first = s.explanation();
  s.playback.first();
  s.playback.seek(20);
  return s.explanation() === first;
})());

check('an explanation cites the command that caused it', (() => {
  // Find the first node copied by the second update and check it names index 6.
  for (let step = 1; step <= s.playback.length; step += 1) {
    s.playback.seek(step);
    const e = s.currentEvent();
    if (e?.kind === 'NodeAllocated' && e.origin === 2 && e.role === 'internal') {
      return s.explanation().includes('index 6');
    }
  }
  return false;
})());

check('sharing is explained where it happens', (() => {
  for (let step = 1; step <= s.playback.length; step += 1) {
    s.playback.seek(step);
    if (s.currentEvent()?.kind === 'NodeReused') {
      return s.explanation().toLowerCase().includes('instead of copying');
    }
  }
  return false;
})());

// Regression: a node wholly outside the query range is not "partly overlapping",
// and a leaf has no children to descend into.
check('a disjoint range is not described as overlapping', (() => {
  const q = new Session(segTree);
  q.run('build [3 1 4 1 5 9 2 6]');
  q.run('query v0 2 5');
  const said: string[] = [];
  for (let step = 1; step <= q.playback.length; step += 1) {
    q.playback.seek(step);
    if (q.currentEvent()?.kind === 'NodeVisited') said.push(q.explanation());
  }
  const outside = said.filter((t) => t.includes('lies outside'));
  return outside.length === 3 && !outside.some((t) => t.includes('descend'));
})());

check('a query explains why the descent stopped', (() => {
  const q = new Session(segTree);
  q.run('build [3 1 4 1 5 9 2 6]');
  q.run('query v0 2 5');
  for (let step = q.playback.marks[0]?.index ?? 0; step <= q.playback.length; step += 1) {
    q.playback.seek(step);
    if (q.currentEvent()?.kind === 'NodeVisited' && q.explanation().includes('stops here')) return true;
  }
  return false;
})());

check('the other plugin explains in its own terms', (() => {
  const st = new Session(stackPlugin);
  st.run('push 3');
  st.run('push 7');
  st.playback.last();
  const said: string[] = [];
  for (let step = 1; step <= st.playback.length; step += 1) {
    st.playback.seek(step);
    said.push(st.explanation());
  }
  return said.some((t) => t.includes('goes on top'))
    && said.some((t) => t.includes('a stack is a chain'))
    && !said.some((t) => t.toLowerCase().includes('version'));
})());

check('a plugin without an explainer still describes events', (() => {
  // Omit the key rather than setting it undefined: exactOptionalPropertyTypes
  // treats those as different, and the contract means "absent".
  const { explain, ...bare } = stackPlugin;
  const b = new Session(bare);
  b.run('push 5');
  b.playback.seek(1);
  return b.explanation() === describeEvent(b.currentEvent());
})());

/* ── Save and load ─────────────────────────────────────────────────── */

console.log('\nsave and load');

const saved = new Session(segTree);
for (const line of ['build [3 1 4 1 5 9 2 6]', 'update v0 3 10', 'update v1 6 7', 'query v1 2 5']) {
  saved.run(line);
}
const file = saved.toFile();

check('the file records the script, not the structure', file.commands.length === 4,
  `${file.commands.length} commands, ${encodeSimulation(file).length} characters encoded`);
check('the file names its plugin and seed',
  file.pluginId === 'persistent-segment-tree' && file.seed === 1);

const reopened = Session.load(file, PLUGINS);
check('loading succeeds without warning', !('code' in reopened) && reopened.warning === null,
  'code' in reopened ? reopened.message : (reopened.warning ?? 'clean'));

if (!('code' in reopened)) {
  const back = reopened.session;
  check('the whole timeline comes back, not just the final state',
    back.playback.length === saved.playback.length,
    `${back.playback.length} events`);
  check('marks survive, so a loaded run still steps by operation',
    back.playback.marks.length === saved.playback.marks.length);
  check('the structure is identical',
    JSON.stringify(back.view().state.nodes.size) === JSON.stringify(saved.view().state.nodes.size)
    && back.view().state.versions.length === saved.view().state.versions.length);
  check('statistics are rebuilt',
    JSON.stringify(back.stats) === JSON.stringify(saved.stats));
  check('a loaded simulation scrubs to identical intermediate states', (() => {
    for (let step = 0; step <= saved.playback.length; step += 1) {
      saved.playback.seek(step);
      back.playback.seek(step);
      if (fingerprint(saved.view().state) !== fingerprint(back.view().state)) return false;
    }
    return true;
  })(), `${saved.playback.length + 1} steps`);
  check('explanations survive the round trip', (() => {
    saved.playback.seek(37);
    back.playback.seek(37);
    return saved.explanation() === back.explanation() && saved.explanation().length > 20;
  })());
  saved.playback.last();
}

check('a failed command is not saved', (() => {
  const withError = new Session(segTree);
  withError.run('build [1 2 3 4]');
  withError.run('query v9 0 1');
  withError.run('nonsense');
  return withError.toFile().commands.length === 1;
})());

check('an unknown plugin is refused with a useful message', (() => {
  const alien = { ...file, pluginId: 'red-black-tree' };
  const r = Session.load(alien, PLUGINS);
  return 'code' in r && r.message.includes('red-black-tree') && (r.hint ?? '').includes('stack');
})());

check('a digest mismatch warns but still opens', (() => {
  const tampered = { ...file, digest: 'deadbeef' };
  const r = Session.load(tampered, PLUGINS);
  return !('code' in r) && r.warning !== null && r.warning.includes('changed since');
})());

check('a save with no digest loads cleanly', (() => {
  const r = Session.load({ ...file, digest: null }, PLUGINS);
  return !('code' in r) && r.warning === null;
})());

check('the round trip survives encoding', (() => {
  const decoded = decodeSimulation(encodeSimulation(file));
  if (!decoded.ok) return false;
  const r = Session.load(decoded.file, PLUGINS);
  return !('code' in r) && r.session.playback.length === saved.playback.length;
})());

check('the other plugin round-trips too', (() => {
  const st = new Session(stackPlugin);
  for (const line of ['push 3', 'push 7', 'pop', 'push 9']) st.run(line);
  const r = Session.load(st.toFile(), PLUGINS);
  return !('code' in r) && r.warning === null
    && r.session.view().scene.nodes.length === st.view().scene.nodes.length;
})());

/* ── Measured complexity ───────────────────────────────────────────── */

console.log('\nmeasured complexity');

for (const plugin of PLUGINS) {
  const report = measurePlugin(plugin);
  if (report === null) { check(`${plugin.meta.id} declares a benchmark`, false); continue; }
  const fit = report.declaredFit;
  if (fit === null) {
    // Two variables cannot be fitted against one axis, so there is nothing to
    // agree or disagree with. Saying so beats failing, and beats passing.
    console.log(`  skip  ${plugin.meta.id}: ${report.command} declares ` +
      `${report.declared ?? '?'}, which is not a single-variable bound; ` +
      `measures O(${report.bestFit.growth.label})`);
    continue;
  }
  check(
    `${plugin.meta.id}: ${report.command} declares ${report.declared ?? '?'}, measures O(${report.bestFit.growth.label})`,
    report.agrees,
    `R² ${fit.rSquared.toFixed(4)}, constant ${fit.constant.toFixed(2)}`,
  );
}

check('measurement is deterministic', (() => {
  const a = measurePlugin(PLUGINS[0] as typeof PLUGINS[number]);
  const b = measurePlugin(PLUGINS[0] as typeof PLUGINS[number]);
  return JSON.stringify(a?.samples) === JSON.stringify(b?.samples);
})());

check('cost grows with size where it should', (() => {
  const tree = measurePlugin(segTree);
  if (tree === null) return false;
  return tree.samples.every((s, i) => i === 0 || s.cost > (tree.samples[i - 1] as { cost: number }).cost);
})());

check('a constant-time command does not grow at all', (() => {
  const st = measurePlugin(stackPlugin);
  if (st === null) return false;
  return new Set(st.samples.map((s) => s.cost)).size === 1;
})());

check('the BIT prefix walk is exactly log2(n)', (() => {
  const bit = PLUGINS.find((p) => p.meta.id === 'persistent-bit');
  const r = bit === undefined ? null : measurePlugin(bit);
  if (r === null) return false;
  return r.samples.every((s) => s.cost === Math.log2(s.n));
})(), 'the cleanest curve in the project');

// Regression: an axis whose top tick sits below the peak draws points above
// the plot area, which no colour or data check would notice.
check('every chart fits inside its plot area', (() => {
  const box = { width: 720, height: 340, top: 46, right: 26, bottom: 46, left: 56 };
  for (const plugin of PLUGINS) {
    const r = measurePlugin(plugin);
    if (r === null) continue;
    const g = chartGeometry(r, box);
    const points = [...g.measured, ...g.predicted];
    const top = g.ticks[g.ticks.length - 1] ?? 0;
    const peak = Math.max(...r.samples.map((x) => x.cost), ...(r.declaredFit?.predicted ?? [0]));
    if (top < peak) return false;
    if (points.some((pt) => pt.y < box.top - 0.5 || pt.y > box.height - box.bottom + 0.5)) return false;
    if (points.some((pt) => pt.x < box.left - 0.5 || pt.x > box.width - box.right + 0.5)) return false;
  }
  return true;
})(), `${PLUGINS.length} plugins`);

check('the x axis is evenly spaced, which is what makes it logarithmic', (() => {
  const r = measurePlugin(segTree);
  if (r === null) return false;
  const g = chartGeometry(r, { width: 720, height: 340, top: 46, right: 26, bottom: 46, left: 56 });
  const gaps = g.measured.slice(1).map((pt, i) => pt.x - (g.measured[i] as { x: number }).x);
  return gaps.every((d) => Math.abs(d - (gaps[0] as number)) < 1e-6);
})());

check('a wrong declaration would be caught', (() => {
  // Fitting the segment tree's logarithmic query against a linear curve must
  // score badly, or the check above proves nothing.
  const tree = measurePlugin(segTree);
  if (tree === null) return false;
  const linear = classify(tree.samples).find((f) => f.growth.label === 'n');
  return (linear?.rSquared ?? 1) < 0.9;
})());

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
