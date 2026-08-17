/**
 * Conformance, Z values against their own definition, and the derived borders
 * against the KMP plugin - two algorithms that should agree about the same
 * string's self-similarity.
 *
 *     node packages/plugins/z-algorithm/src/plugin.check.ts
 */

import { createRng, help, parseCommand, type OperationError } from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { kmp } from '@algoverse/plugin-kmp';
import { zAlgorithm as plugin } from './plugin.ts';

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

/** The KMP plugin's borders for the same word, so the two can be compared. */
function kmpBorders(word: string): number[] | null {
  const inst = kmp.createInstance({ rng: createRng(1) });
  const parsed = parseCommand(`build ${word}`, kmp.commands);
  if (!parsed.ok) return null;
  const r = inst.execute(parsed.command);
  if (!r.ok) return null;
  return (r.value as { borders: number[] }).borders;
}

const at = (r: { value: unknown }, key: string): unknown =>
  (r.value as Record<string, unknown> | null)?.[key];

/** How much of the string starts again at i, counted one letter at a time. */
function naiveZ(s: string): number[] {
  return [...s].map((_, i) => {
    if (i === 0) return s.length;
    let k = 0;
    while (i + k < s.length && s[k] === s[i + k]) k += 1;
    return k;
  });
}

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, ['build aabxaayaab', 'values', 'find aab', 'borders'])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. A worked example ───────────────────────────────────────────── */

console.log('\naabxaayaab');

const inst = fresh();
const built = run(inst, 'build aabxaayaab').value as
  { length: number; z: number[]; copied: number; longestRepeat: number };

check('the values are the ones the definition gives',
  JSON.stringify(built.z) === JSON.stringify(naiveZ('aabxaayaab')),
  built.z.join(' '));

check('the longest repeat of the beginning is found', built.longestRepeat === 3,
  'aab starts again at position 7');

check('some answers were copied rather than compared', built.copied > 0,
  `${built.copied} of ${built.length} came free`);

check('the position that creates the interval is the one that pays for it', (() => {
  /*
   * aaaa gives values 4 3 2 1, and two of the four come free. Position 1 is
   * not one of them: there is no interval yet when it is reached, so it has to
   * compare - and comparing is precisely what creates the interval that the
   * two after it then borrow from.
   */
  const q = fresh();
  const r = run(q, 'build aaaa').value as { z: number[]; copied: number };
  return JSON.stringify(r.z) === JSON.stringify([4, 3, 2, 1]) && r.copied === 2;
})(), 'positions 2 and 3 copy; position 1 earns the interval');

check('a string with no repetition copies nothing', (() => {
  const q = fresh();
  const r = run(q, 'build abcd').value as { z: number[]; copied: number };
  return JSON.stringify(r.z) === JSON.stringify([4, 0, 0, 0]) && r.copied === 0;
})());

/* ── 3. Searching by concatenation ─────────────────────────────────── */

console.log('\nsearching');

check('every occurrence is found, overlaps included', (() => {
  const q = fresh();
  run(q, 'build ababa');
  const r = run(q, 'find aba');
  return at(r, 'count') === 2 && JSON.stringify(at(r, 'positions')) === JSON.stringify([0, 2]);
})());

check('a pattern that is not there is reported', (() => {
  const q = fresh();
  run(q, 'build ababa');
  return at(run(q, 'find abc'), 'count') === 0;
})());

check('the separator stops a match running across the join', (() => {
  /*
   * Without something between the pattern and the text, a run of one letter
   * would match over the boundary and invent an occurrence at the very start.
   */
  const q = fresh();
  run(q, 'build aaa');
  const r = run(q, 'find aa');
  return at(r, 'count') === 2 && JSON.stringify(at(r, 'positions')) === JSON.stringify([0, 1]);
})(), 'aa occurs twice in aaa, and not three times');

check('one pass covers pattern, separator and text', (() => {
  const q = fresh();
  run(q, 'build abcabc');
  const r = run(q, 'find abc').value as { scanned: number };
  return r.scanned === 3 + 1 + 6;
})());

/* ── 4. The same information as KMP ────────────────────────────────── */

console.log('\nagainst KMP');

check('the derived borders are the ones KMP computes', (() => {
  const q = fresh();
  run(q, 'build ababaca');
  const mine = at(run(q, 'borders'), 'borders') as number[];
  const theirs = kmpBorders('ababaca');
  return theirs !== null && JSON.stringify(mine) === JSON.stringify(theirs);
})(), 'ababaca, both ways round');

/* ── 5. Property test ──────────────────────────────────────────────── */

console.log('\nproperty test vs the definition, and vs KMP');

const rng = createRng(20_260_828);
let trials = 0;
let searches = 0;
let firstFailure = '';

for (let t = 0; t < 80 && firstFailure === ''; t += 1) {
  const alphabet = rng.next() < 0.6 ? 'ab' : 'abc';
  const n = rng.nextInt(1, 20);
  let text = '';
  for (let i = 0; i < n; i += 1) text += alphabet[rng.nextInt(0, alphabet.length)] as string;

  const q = fresh();
  const b = run(q, `build ${text}`);
  if (b.error !== null) { firstFailure = `build ${text}: ${b.error.message}`; break; }
  trials += 1;

  const want = naiveZ(text);
  const got = at(b, 'z') as number[];
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    firstFailure = `"${text}" gave [${got}], the definition gives [${want}]`;
    break;
  }

  /*
   * The cross-check that matters: two different algorithms, written from
   * opposite ends, describing the same string. A shared misunderstanding is
   * the only way both could be wrong the same way.
   */
  const mine = at(run(q, 'borders'), 'borders') as number[];
  const theirs = kmpBorders(text);
  if (theirs === null || JSON.stringify(mine) !== JSON.stringify(theirs)) {
    firstFailure = `"${text}" borders [${mine}] from Z, [${String(theirs)}] from KMP`;
    break;
  }

  for (let s = 0; s < 3; s += 1) {
    const m = rng.nextInt(1, 6);
    let pattern = '';
    for (let i = 0; i < m; i += 1) pattern += alphabet[rng.nextInt(0, alphabet.length)] as string;
    let expected: number[] = [];
    for (let i = 0; i + m <= n; i += 1) {
      if (text.slice(i, i + m) === pattern) expected.push(i);
    }
    const r = run(q, `find ${pattern}`);
    searches += 1;
    if (JSON.stringify(at(r, 'positions')) !== JSON.stringify(expected)) {
      firstFailure = `"${pattern}" in "${text}" found [${at(r, 'positions')}], scanning gives [${expected}]`;
      break;
    }
  }
}

check('values match the definition, borders match KMP, searches match a scan',
  firstFailure === '',
  firstFailure === '' ? `${trials} words, ${searches} searches` : firstFailure);

/* ── 6. Refusing ───────────────────────────────────────────────────── */

console.log('\nerrors');

check('nothing can be asked before a build', (() => {
  const parsed = parseCommand('values', plugin.commands);
  if (!parsed.ok) return false;
  const r = fresh().execute(parsed.command);
  return !r.ok && r.error.code === 'PRECONDITION_FAILED';
})());
check('an over-long word is refused, with the limit',
  (run(fresh(), `build ${'a'.repeat(5000)}`).error?.hint ?? '').includes('longest is'));

/* ── 7. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build aabxaayaab', 'values', 'find aab', 'borders']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
