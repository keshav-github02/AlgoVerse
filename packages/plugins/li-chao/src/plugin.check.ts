/**
 * Conformance, and every query checked against evaluating all the lines by
 * hand - which is the only honest reference for a structure whose whole claim
 * is that it does not have to.
 *
 *     node packages/plugins/li-chao/src/plugin.check.ts
 */

import { createRng, help, parseCommand, type OperationError } from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { liChao as plugin } from './plugin.ts';

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

/** The lowest any line reaches at x, worked out the slow and obvious way. */
const brute = (lines: readonly [number, number][], x: number): number =>
  Math.min(...lines.map(([m, c]) => m * x + c));

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, ['build 0 15', 'add v0 2 10', 'add v1 -1 20', 'query v2 7'])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. Building and refusing ──────────────────────────────────────── */

console.log('\nbuilding');

const inst = fresh();
const built = run(inst, 'build 0 15').value as { span: number; lines: number };
check('a range is opened with nothing in it', built.span === 16 && built.lines === 0,
  'a Li Chao tree allocates nothing until a line arrives');

check('an empty tree has no answer, and says so', (() => {
  const r = run(inst, 'query v0 3');
  return r.error?.code === 'PRECONDITION_FAILED' && (r.error.hint ?? '').includes('add one');
})());
check('a backwards range is refused',
  run(fresh(), 'build 10 2').error?.code === 'INVALID_RANGE');
check('an absurdly wide range is refused, with the limit',
  (run(fresh(), 'build 0 99999999').error?.hint ?? '').includes('widest range'));
check('an x outside the range is refused, and says why', (() => {
  const q = fresh();
  run(q, 'build 0 15');
  run(q, 'add v0 1 0');
  const r = run(q, 'query v1 99');
  return r.error?.code === 'INDEX_OUT_OF_RANGE' && (r.error.hint ?? '').includes('fixed by build');
})());
check('an unknown version is refused',
  run(inst, 'add v9 1 1').error?.code === 'UNKNOWN_VERSION');

/* ── 3. The lower envelope ─────────────────────────────────────────── */

console.log('\nthe lower envelope');

check('one line is the answer everywhere', (() => {
  const q = fresh();
  run(q, 'build 0 10');
  run(q, 'add v0 3 4');
  for (let x = 0; x <= 10; x += 1) {
    if (at(run(q, `query v1 ${x}`), 'min') !== 3 * x + 4) return false;
  }
  return true;
})());

check('two crossing lines swap over at the crossing', (() => {
  // y = 2x and y = -x + 9 cross at x = 3.
  const q = fresh();
  run(q, 'build 0 10');
  run(q, 'add v0 2 0');
  run(q, 'add v1 -1 9');
  const low = run(q, 'query v2 1');
  const high = run(q, 'query v2 8');
  return at(low, 'min') === 2 && at(low, 'line') === '2x+0'
    && at(high, 'min') === 1 && at(high, 'line') === '-1x+9';
})(), '2x wins on the left, -x + 9 on the right');

check('a line that is beaten everywhere never becomes the answer', (() => {
  const q = fresh();
  run(q, 'build 0 20');
  run(q, 'add v0 1 0');
  run(q, 'add v1 1 5');
  for (let x = 0; x <= 20; x += 1) {
    if (at(run(q, `query v2 ${x}`), 'min') !== x) return false;
  }
  return true;
})(), 'parallel and higher, so it is stored but never wins');

check('a horizontal line and a steep one both get their share', (() => {
  const q = fresh();
  run(q, 'build -10 10');
  run(q, 'add v0 0 0');
  run(q, 'add v1 5 0');
  return at(run(q, 'query v2 -10'), 'min') === -50
    && at(run(q, 'query v2 10'), 'min') === 0;
})(), 'the range may start below zero');

check('order of insertion does not change the answer', (() => {
  const forward = fresh();
  run(forward, 'build 0 30');
  for (const [m, c] of [[3, 1], [-2, 40], [1, 9], [-5, 70], [0, 12]]) run(forward, `add v${0} ${m} ${c}`);
  // Each add branches from v0, so build a chained one to compare properly.
  const chained = fresh();
  run(chained, 'build 0 30');
  let v = 0;
  for (const [m, c] of [[3, 1], [-2, 40], [1, 9], [-5, 70], [0, 12]]) {
    run(chained, `add v${v} ${m} ${c}`);
    v += 1;
  }
  const reversed = fresh();
  run(reversed, 'build 0 30');
  v = 0;
  for (const [m, c] of [[0, 12], [-5, 70], [1, 9], [-2, 40], [3, 1]]) {
    run(reversed, `add v${v} ${m} ${c}`);
    v += 1;
  }
  for (let x = 0; x <= 30; x += 1) {
    if (at(run(chained, `query v5 ${x}`), 'min') !== at(run(reversed, `query v5 ${x}`), 'min')) return false;
  }
  return true;
})(), 'five lines, inserted forwards and backwards');

/* ── 4. Persistence ────────────────────────────────────────────────── */

console.log('\npersistence');

check('an older version does not see a later line', (() => {
  const q = fresh();
  run(q, 'build 0 20');
  run(q, 'add v0 5 0');
  run(q, 'add v1 0 -100');
  return at(run(q, 'query v1 10'), 'min') === 50
    && at(run(q, 'query v2 10'), 'min') === -100;
})());

check('adding a line copies a path, not a tree', (() => {
  const q = fresh();
  run(q, 'build 0 1023');
  for (let i = 0; i < 12; i += 1) run(q, `add v${i} ${i - 6} ${i * 3}`);
  const r = run(q, 'add v12 100 1').value as { allocated: number };
  return r.allocated > 0 && r.allocated <= 11;
})(), (() => {
  const q = fresh();
  run(q, 'build 0 1023');
  for (let i = 0; i < 12; i += 1) run(q, `add v${i} ${i - 6} ${i * 3}`);
  const r = run(q, 'add v12 100 1').value as { allocated: number };
  return `${r.allocated} nodes for a span of 1024`;
})());

/**
 * A tree with every level occupied.
 *
 * The line for a is y = -2a*x + a^2, a tangent to y = -x^2, and it is the
 * lowest of them at x = a and nowhere else. A handful of arbitrary lines
 * leaves most of the tree empty, which makes a query look cheaper than it is;
 * this fills it.
 */
const parabola = (n: number): PluginInstance => {
  const q = fresh();
  run(q, `build 0 ${n - 1}`);
  for (let a = 0; a < n; a += 1) run(q, `add v${a} ${-2 * a} ${a * a}`);
  return q;
};

check('a full tree shares nearly all of itself between versions', (() => {
  const q = parabola(256);
  const r = run(q, 'compare v255 v256').value as { shared: number; sharedPercent: number };
  return r.shared > 0 && r.sharedPercent > 80;
})(), (() => {
  const r = run(parabola(256), 'compare v255 v256').value as { shared: number; sharedPercent: number };
  return `${r.shared} nodes shared, ${r.sharedPercent}%`;
})());

check('a query walks one path, and its length is the depth', (() => {
  // Not merely "few": exactly log2 of the span, because every level of the
  // path holds a line that is the answer somewhere below it.
  return [16, 64, 256].every((n) => {
    const r = run(parabola(n), `query v${n} ${n / 2}`).value as { visits: number };
    return r.visits === Math.log2(n);
  });
})(), [16, 64, 256]
  .map((n) => `${n}:${(run(parabola(n), `query v${n} ${n / 2}`).value as { visits: number }).visits}`)
  .join(' '));

/* ── 5. Against evaluating every line ──────────────────────────────── */

console.log('\nproperty test vs evaluating every line');

const rng = createRng(20_260_825);
let trials = 0;
let queries = 0;
let firstFailure = '';

for (let t = 0; t < 40 && firstFailure === ''; t += 1) {
  const lo = rng.nextInt(-20, 10);
  const hi = lo + rng.nextInt(1, 40);
  const q = fresh();
  run(q, `build ${lo} ${hi}`);

  const model: [number, number][] = [];
  const count = rng.nextInt(1, 10);
  for (let i = 0; i < count; i += 1) {
    const m = rng.nextInt(-8, 9);
    const c = rng.nextInt(-30, 31);
    const r = run(q, `add v${i} ${m} ${c}`);
    if (r.error !== null) { firstFailure = `add failed: ${r.error.message}`; break; }
    model.push([m, c]);
  }
  if (firstFailure !== '') break;
  trials += 1;

  /*
   * Every version, every x. The claim is not that the structure is usually
   * right - it is that the best line at any x is always somewhere on the one
   * path a query walks, and a single x where that fails would break it.
   */
  for (let v = 1; v <= model.length && firstFailure === ''; v += 1) {
    const lines = model.slice(0, v);
    for (let x = lo; x <= hi; x += 1) {
      const got = at(run(q, `query v${v} ${x}`), 'min');
      queries += 1;
      const want = brute(lines, x);
      if (got !== want) {
        firstFailure = `v${v} at x=${x} gave ${String(got)}, evaluating all ${lines.length} lines gives ${want}`;
        break;
      }
    }
  }
}

check('every x of every version matches evaluating all the lines',
  firstFailure === '',
  firstFailure === '' ? `${trials} trees, ${queries} queries` : firstFailure);

check('the line reported is one that actually achieves the minimum', (() => {
  // A right number attached to the wrong line would pass every check above.
  const q = fresh();
  run(q, 'build 0 40');
  const lines: [number, number][] = [[4, 2], [-3, 60], [1, 15], [-1, 30]];
  lines.forEach(([m, c], i) => run(q, `add v${i} ${m} ${c}`));
  for (let x = 0; x <= 40; x += 1) {
    const r = run(q, `query v4 ${x}`);
    const named = String(at(r, 'line'));
    const value = at(r, 'min');
    const match = lines.find(([m, c]) => `${m}x${c < 0 ? '' : '+'}${c}` === named);
    if (match === undefined) return false;
    if (match[0] * x + match[1] !== value) return false;
  }
  return true;
})());

/* ── 6. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build 0 10', 'add v0 2 0', 'add v1 -1 9', 'query v2 1', 'query v2 8', 'compare v1 v2']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
