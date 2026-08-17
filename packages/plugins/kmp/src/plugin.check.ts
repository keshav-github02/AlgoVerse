/**
 * Conformance, borders against their own definition, and searches against a
 * plain scan.
 *
 *     node packages/plugins/kmp/src/plugin.check.ts
 */

import { createRng, help, parseCommand, type OperationError } from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { kmp as plugin } from './plugin.ts';

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

/**
 * The border of every prefix, straight from the definition: the longest proper
 * piece that both begins and ends it. Cubic, and impossible to get wrong.
 */
function naiveBorders(pattern: string): number[] {
  return [...pattern].map((_, i) => {
    const prefix = pattern.slice(0, i + 1);
    for (let len = prefix.length - 1; len > 0; len -= 1) {
      if (prefix.slice(0, len) === prefix.slice(prefix.length - len)) return len;
    }
    return 0;
  });
}

/** Every occurrence, by trying every position. */
function naiveSearch(text: string, pattern: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + pattern.length <= text.length; i += 1) {
    if (text.slice(i, i + pattern.length) === pattern) out.push(i);
  }
  return out;
}

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, ['build ababaca', 'search abababacaba', 'borders'])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. The textbook pattern ───────────────────────────────────────── */

console.log('\nababaca');

const inst = fresh();
const built = run(inst, 'build ababaca').value as { borders: number[]; longestBorder: number };
check('the borders are the ones the definition gives',
  JSON.stringify(built.borders) === JSON.stringify([0, 0, 1, 2, 3, 0, 1]),
  '0 0 1 2 3 0 1');
check('the longest border is reported', built.longestBorder === 3);

check('overlapping occurrences are all found', (() => {
  const q = fresh();
  run(q, 'build aba');
  const r = run(q, 'search ababa');
  return at(r, 'count') === 2 && JSON.stringify(at(r, 'positions')) === JSON.stringify([0, 2]);
})(), 'aba occurs at 0 and 2 in ababa, sharing a letter');

check('a pattern longer than the text finds nothing', (() => {
  const q = fresh();
  run(q, 'build abcdef');
  return at(run(q, 'search abc'), 'count') === 0;
})());

check('the text is never read twice', (() => {
  // The point of the borders: comparisons stay within twice the text length
  // even on the input a naive search does worst on.
  const q = fresh();
  run(q, 'build aaab');
  const n = 512;
  const r = run(q, `search ${'a'.repeat(n)}`).value as { comparisons: number; fallbacks: number };
  return r.comparisons <= 2 * n && r.fallbacks > 0;
})(), (() => {
  const q = fresh();
  run(q, 'build aaab');
  const r = run(q, `search ${'a'.repeat(512)}`).value as { comparisons: number; readsPerLetter: number };
  return `${r.comparisons} comparisons for 512 letters, ${r.readsPerLetter} per letter`;
})());

check('the chain of borders is every border, longest first', (() => {
  const q = fresh();
  run(q, 'build aabaaab');
  // aabaaab ends in aab and begins with aab, so its border is 3. aab itself
  // has none - it ends in b and begins with a - so the chain stops there.
  const r = run(q, 'borders');
  return JSON.stringify(at(r, 'chain')) === JSON.stringify([3]);
})(), 'aabaaab is bordered by aab, and aab by nothing');

check('a pattern with no repetition has no borders at all', (() => {
  const q = fresh();
  run(q, 'build abcdef');
  const r = run(q, 'borders');
  return JSON.stringify(at(r, 'borders')) === JSON.stringify([0, 0, 0, 0, 0, 0])
    && at(r, 'periodic') === false;
})());

/* ── 3. Refusing ───────────────────────────────────────────────────── */

console.log('\nerrors');

check('searching before building is refused, with the way out', (() => {
  const parsed = parseCommand('borders', plugin.commands);
  if (!parsed.ok) return false;
  const r = fresh().execute(parsed.command);
  return !r.ok && r.error.code === 'PRECONDITION_FAILED' && (r.error.hint ?? '').includes('build ababaca');
})());
check('a pattern with punctuation is refused by the parser',
  !parseCommand('build ab-c', plugin.commands).ok);
check('an over-long pattern is refused, with the limit',
  (run(fresh(), `build ${'a'.repeat(5000)}`).error?.hint ?? '').includes('longest is'));

/* ── 4. The failure links reach the drawing ────────────────────────── */

console.log('\nfailure links');

check('a failure link points at the end of the border', (() => {
  const q = fresh();
  run(q, 'build ababaca');
  const g = q.getStructure();
  const fails = g.edges.filter((e) => e.slot === 'fail');
  // borders are 0 0 1 2 3 0 1, so positions 2,3,4,6 have links.
  return fails.length === 4
    && fails.every((e) => e.directed === true && typeof e.weight === 'number')
    && fails.every((e) => e.to === (e.weight as number) - 1);
})(), 'four links, each to where its border ends');

check('the letters are drawn in reading order', (() => {
  const q = fresh();
  run(q, 'build abcd');
  const g = q.getStructure();
  const byOrder = [...g.nodes].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return byOrder.map((n) => n.label).join('') === 'abcd';
})());

/* ── 5. Against the definition and a plain scan ────────────────────── */

console.log('\nproperty test vs the definition');

const rng = createRng(20_260_827);
let trials = 0;
let searches = 0;
let firstFailure = '';

for (let t = 0; t < 80 && firstFailure === ''; t += 1) {
  // A tiny alphabet makes borders long and common, which is where an
  // incremental border computation would go wrong if it were going to.
  const alphabet = rng.next() < 0.6 ? 'ab' : 'abc';
  const m = rng.nextInt(1, 14);
  let pattern = '';
  for (let i = 0; i < m; i += 1) pattern += alphabet[rng.nextInt(0, alphabet.length)] as string;

  const q = fresh();
  const b = run(q, `build ${pattern}`);
  if (b.error !== null) { firstFailure = `build ${pattern}: ${b.error.message}`; break; }
  trials += 1;

  const want = naiveBorders(pattern);
  const got = at(b, 'borders') as number[];
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    firstFailure = `"${pattern}" borders [${got}], the definition gives [${want}]`;
    break;
  }

  for (let s = 0; s < 4; s += 1) {
    const n = rng.nextInt(1, 40);
    let text = '';
    for (let i = 0; i < n; i += 1) text += alphabet[rng.nextInt(0, alphabet.length)] as string;
    const r = run(q, `search ${text}`);
    searches += 1;
    const expected = naiveSearch(text, pattern);
    if (JSON.stringify(at(r, 'positions')) !== JSON.stringify(expected)) {
      firstFailure = `"${pattern}" in "${text}" found [${at(r, 'positions')}], scanning gives [${expected}]`;
      break;
    }
    // The guarantee, not just the answer.
    const comparisons = at(r, 'comparisons') as number;
    if (comparisons > 2 * n) {
      firstFailure = `"${pattern}" in "${text}" took ${comparisons} comparisons for ${n} letters`;
      break;
    }
  }
}

check('borders match the definition and searches match a plain scan',
  firstFailure === '',
  firstFailure === '' ? `${trials} patterns, ${searches} searches` : firstFailure);

/* ── 6. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build ababaca', 'borders', 'search abababacaba', 'build aaab', 'search aaaaaaaa']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
