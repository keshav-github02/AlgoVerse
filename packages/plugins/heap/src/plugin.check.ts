/**
 * Conformance plus property tests for the binary heap.
 *
 *     node packages/plugins/heap/src/plugin.check.ts
 */

import { createRng, help, parseCommand, type OperationError } from '@algoverse/core';
import { runBenchmark, runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { heap as plugin } from './plugin.ts';

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

/** Values in position order, read back from the structure the plugin reports. */
function positions(inst: PluginInstance): number[] {
  return [...inst.getStructure().nodes].sort((a, b) => a.id - b.id).map((n) => n.value);
}

function ordered(values: readonly number[]): boolean {
  for (let i = 1; i < values.length; i += 1) {
    if ((values[Math.floor((i - 1) / 2)] as number) > (values[i] as number)) return false;
  }
  return true;
}

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
const script = ['build [9 4 7 1 8 2 6]', 'push 0', 'pop', 'set 3 -5', 'set 0 20', 'peek', 'push 3', 'pop'];
for (const r of runConformance(plugin, script)) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. Behaviour ──────────────────────────────────────────────────── */

console.log('\nbehaviour');

const inst = fresh();
run(inst, 'build [5 3 8 1 9 2]');
check('build heapifies', ordered(positions(inst)), positions(inst).join(' '));
check('the root is the minimum', (run(inst, 'peek').value as { min: number }).min === 1);
check('pop returns the minimum', (run(inst, 'pop').value as { popped: number }).popped === 1);
check('pop keeps the heap ordered', ordered(positions(inst)), positions(inst).join(' '));
check('pop shrinks the heap by one position', inst.getStructure().nodes.length === 5);
run(inst, 'set 4 0');
check('set to a smaller value sifts it up to the root',
  (run(inst, 'peek').value as { min: number }).min === 0 && ordered(positions(inst)));
run(inst, 'set 0 100');
check('set to a larger value sifts it down', ordered(positions(inst)) && positions(inst)[0] !== 100);

const empty = fresh();
check('pop on empty is an error, not a crash', run(empty, 'pop').error?.code === 'PRECONDITION_FAILED');
check('peek on empty is an error, not a crash', run(empty, 'peek').error?.code === 'PRECONDITION_FAILED');
check('set outside the heap is an error', run(empty, 'set 0 1').error?.code === 'INDEX_OUT_OF_RANGE');
check('build of nothing is rejected by the parser', run(empty, 'build []').error?.code === 'BAD_ARGUMENT');

const rebuilt = fresh();
run(rebuilt, 'build [4 3 2 1]');
run(rebuilt, 'build [7 6]');
check('build replaces rather than appends', positions(rebuilt).join(' ') === '6 7');

/* ── 3. Cost ───────────────────────────────────────────────────────── */

console.log('\ncost');

const bench = runBenchmark(plugin);
const visits = bench?.measurements.map((m) => m.visits) ?? [];
check('push climbs one level per doubling',
  visits.length === 6 && visits.every((v, i) => i === 0 || v - (visits[i - 1] as number) <= 1.01),
  visits.map((v) => v.toFixed(1)).join(' '));

const linear = fresh();
const n = 255;
const sorted = Array.from({ length: n }, (_, i) => n - i);
const parsed = parseCommand(`build [${sorted.join(' ')}]`, plugin.commands);
const built = parsed.ok ? linear.execute(parsed.command) : null;
const compared = built?.events.filter((e) => e.kind === 'NodeVisited').length ?? 0;
check('heapify compares fewer than 2n times, even on reversed input',
  compared < 2 * n, `${compared} comparisons for ${n} values`);

/* ── 4. Property test against a sorted array ───────────────────────── */

console.log('\nproperty test vs a sorted array');

const rng = createRng(20_261_002);
let ops = 0;
let firstFailure = '';

for (let trial = 0; trial < 120 && firstFailure === ''; trial += 1) {
  const h = fresh();
  let model: number[] = [];
  for (let i = 0; i < 30 && firstFailure === ''; i += 1) {
    const roll = rng.next();
    ops += 1;
    if (roll < 0.05) {
      const values = Array.from({ length: rng.nextInt(1, 12) }, () => rng.nextInt(-20, 20));
      run(h, `build [${values.join(' ')}]`);
      model = [...values];
    } else if (roll < 0.5) {
      const v = rng.nextInt(-20, 20);
      run(h, `push ${v}`);
      model.push(v);
    } else if (roll < 0.8) {
      const r = run(h, 'pop');
      model.sort((a, b) => a - b);
      const expected = model.shift();
      if (expected === undefined) {
        if (r.error?.code !== 'PRECONDITION_FAILED') firstFailure = 'pop on empty did not error';
      } else if ((r.value as { popped: number } | null)?.popped !== expected) {
        firstFailure = `pop gave ${JSON.stringify(r.value)}, expected ${expected}`;
      }
    } else if (model.length > 0) {
      // `set` addresses a position, so the model has to know which value is there.
      const at = rng.nextInt(0, model.length);
      const v = rng.nextInt(-20, 20);
      const current = positions(h);
      const old = current[at] as number;
      run(h, `set ${at} ${v}`);
      model.splice(model.indexOf(old), 1, v);
    }
    const live = positions(h);
    if (firstFailure === '' && !ordered(live)) firstFailure = `heap order broken: ${live.join(' ')}`;
    if (firstFailure === '' && [...live].sort((a, b) => a - b).join() !== [...model].sort((a, b) => a - b).join()) {
      firstFailure = `heap holds ${live.join(' ')}, model holds ${model.join(' ')}`;
    }
  }
}

check('heap matches a sorted array', firstFailure === '',
  firstFailure === '' ? `120 trials, ${ops} operations` : firstFailure);

/* ── 5. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build [6 2 9 4]', 'push 1', 'peek', 'pop', 'set 2 -1', 'pop']) {
  const r = run(session, line);
  const out = r.error === null
    ? JSON.stringify(r.value)
    : `${r.error.code}: ${r.error.message}  (${r.error.hint ?? ''})`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
