/**
 * Conformance and property tests for the unbalanced BST - including the
 * degeneration it exists to demonstrate.
 *
 *     node packages/plugins/persistent-bst/src/plugin.check.ts
 */

import { createRng, help, parseCommand, type OperationError } from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { persistentBst as plugin } from './plugin.ts';

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

const keysOf = (inst: PluginInstance, v: number, upTo: number): number[] => {
  const out: number[] = [];
  for (let k = 0; k <= upTo; k += 1) {
    if ((run(inst, `find v${v} ${k}`).value as { found: boolean }).found) out.push(k);
  }
  return out;
};

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, ['build [5 2 8 1 9]', 'insert v0 6', 'erase v1 2', 'find v2 8'])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. Correctness ────────────────────────────────────────────────── */

console.log('\ncorrectness');

const inst = fresh();
run(inst, 'build [5 2 8 1 9]');
check('build holds every key', keysOf(inst, 0, 10).join(',') === '1,2,5,8,9');

run(inst, 'insert v0 6');
check('insert adds one key', keysOf(inst, 1, 10).join(',') === '1,2,5,6,8,9');
check('the earlier version is untouched', keysOf(inst, 0, 10).join(',') === '1,2,5,8,9');

run(inst, 'erase v1 2');
check('erase removes a key with one child', keysOf(inst, 2, 10).join(',') === '1,5,6,8,9');
check('both earlier versions still read correctly',
  keysOf(inst, 0, 10).join(',') === '1,2,5,8,9' && keysOf(inst, 1, 10).join(',') === '1,2,5,6,8,9');

check('erasing a node with two children keeps search order', (() => {
  const p = fresh();
  run(p, 'build [5 3 8 2 4 7 9]');
  run(p, 'erase v0 3');
  return keysOf(p, 1, 10).join(',') === '2,4,5,7,8,9';
})());
check('erasing the root works', (() => {
  const p = fresh();
  run(p, 'build [5 3 8]');
  run(p, 'erase v0 5');
  return keysOf(p, 1, 10).join(',') === '3,8';
})());
check('erasing the last key leaves an empty version', (() => {
  const p = fresh();
  run(p, 'build [7]');
  run(p, 'erase v0 7');
  return keysOf(p, 1, 10).length === 0;
})());
check('a duplicate insert is refused',
  run(inst, 'insert v0 5').error?.code === 'PRECONDITION_FAILED');
check('erasing an absent key is refused',
  run(inst, 'erase v0 42').error?.code === 'PRECONDITION_FAILED');

/* ── 3. The point: it degenerates ──────────────────────────────────── */

console.log('\ndegeneration');

const sortedInput = Array.from({ length: 32 }, (_, i) => i + 1);
const sorted = fresh();
const sortedResult = run(sorted, `build [${sortedInput.join(' ')}]`).value as
  { height: number; size: number; degenerate: boolean };

check('sorted input builds a linked list, not a tree',
  sortedResult.height === 32 && sortedResult.degenerate,
  `height ${sortedResult.height} for ${sortedResult.size} keys`);

check('the worst-case lookup walks the whole structure', (() => {
  const r = run(sorted, 'find v0 32').value as { visits: number };
  return r.visits === 32;
})(), '32 nodes visited to find one key');

const shuffledInput = [16, 8, 24, 4, 12, 20, 28, 2, 6, 10, 14, 18, 22, 26, 30,
  1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 32];
const shuffled = fresh();
const shuffledResult = run(shuffled, `build [${shuffledInput.join(' ')}]`).value as { height: number };
check('the same keys in a better order build a shallow tree',
  shuffledResult.height <= 7,
  `height ${shuffledResult.height} vs ${sortedResult.height} for the identical key set`);

check('insertion order is the only difference', (() => {
  const a = keysOf(sorted, 0, 33).join(',');
  const b = keysOf(shuffled, 0, 33).join(',');
  return a === b;
})(), 'both hold 1..32');

check('build does not sort its input, which would hide all of this', (() => {
  // If build sorted first, every tree would be a chain and the contrast above
  // would be impossible to show.
  return shuffledResult.height < sortedResult.height;
})());

/* ── 4. Property test against a sorted set ─────────────────────────── */

console.log('\nproperty test vs a sorted set');

const rng = createRng(20_260_811);
let trials = 0;
let operations = 0;
let firstFailure = '';

for (let t = 0; t < 30 && firstFailure === ''; t += 1) {
  const p = fresh();
  const start = [...new Set(Array.from({ length: rng.nextInt(1, 8) }, () => rng.nextInt(0, 20)))];
  run(p, `build [${start.join(' ')}]`);
  const models: number[][] = [[...start].sort((a, b) => a - b)];
  trials += 1;

  for (let op = 0; op < 8 && firstFailure === ''; op += 1) {
    const from = rng.nextInt(0, models.length);
    const model = models[from] as number[];
    const key = rng.nextInt(0, 20);
    const inserting = rng.next() < 0.6;
    operations += 1;

    if (inserting === model.includes(key)) {
      const r = run(p, `${inserting ? 'insert' : 'erase'} v${from} ${key}`);
      if (r.error?.code !== 'PRECONDITION_FAILED') {
        firstFailure = `${inserting ? 'insert' : 'erase'} ${key} should have been refused`;
      }
      continue;
    }

    const r = run(p, `${inserting ? 'insert' : 'erase'} v${from} ${key}`);
    if (r.error !== null) { firstFailure = `unexpected ${r.error.code}`; break; }
    models.push(inserting
      ? [...model, key].sort((a, b) => a - b)
      : model.filter((k) => k !== key));

    for (let v = 0; v < models.length && firstFailure === ''; v += 1) {
      const expected = (models[v] as number[]).join(',');
      const got = keysOf(p, v, 20).join(',');
      if (got !== expected) firstFailure = `v${v}: got [${got}], expected [${expected}]`;
    }
  }
}

check('every version holds exactly its own keys', firstFailure === '',
  firstFailure === '' ? `${trials} trials, ${operations} operations` : firstFailure);

/* ── 5. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build [1 2 3 4 5 6 7 8]', 'find v0 8', 'build [4 2 6 1 3 5 7]', 'find v0 7']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
