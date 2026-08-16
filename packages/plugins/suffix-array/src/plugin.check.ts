/**
 * Conformance, and everything checked against sorting the suffixes with plain
 * string comparison - the O(n² log n) method this one exists to avoid.
 *
 *     node packages/plugins/suffix-array/src/plugin.check.ts
 */

import { createRng, help, layout, parseCommand, type OperationError } from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { suffixArray as plugin } from './plugin.ts';

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

/** Sort every suffix by comparing the strings. Slow, obvious, and independent. */
function naiveOrder(text: string): number[] {
  return Array.from({ length: text.length }, (_, i) => i)
    .sort((a, b) => {
      const x = text.slice(a);
      const y = text.slice(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
}

/** How much two strings share at the front, counted one letter at a time. */
function naiveShared(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, ['build banana', 'find ana', 'lrs', 'suffixes'])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. The textbook example ───────────────────────────────────────── */

console.log('\nbanana');

const inst = fresh();
const built = run(inst, 'build banana').value as
  { length: number; rounds: number; distinctSubstrings: number };

check('the suffixes come out in the order they should', (() => {
  // banana: 5 a, 3 ana, 1 anana, 0 banana, 4 na, 2 nana
  const order = at(run(inst, 'suffixes'), 'order');
  return JSON.stringify(order) === JSON.stringify([5, 3, 1, 0, 4, 2]);
})(), '5 3 1 0 4 2');

check('the shared prefixes come out right', (() => {
  // a|ana share 1, ana|anana share 3, anana|banana share 0, banana|na 0, na|nana 2
  const shared = at(run(inst, 'suffixes'), 'shared');
  return JSON.stringify(shared) === JSON.stringify([0, 1, 3, 0, 0, 2]);
})(), '0 1 3 0 0 2');

check('doubling settles in about log n rounds',
  built.rounds <= Math.ceil(Math.log2(built.length)) + 1,
  `${built.rounds} rounds for ${built.length} letters`);

check('the distinct substrings are counted', built.distinctSubstrings === 15,
  'banana has 15 different substrings');

check('every occurrence is one block of the order', (() => {
  const r = run(inst, 'find ana');
  return at(r, 'count') === 2 && at(r, 'ranks') === '1..2'
    && JSON.stringify(at(r, 'positions')) === JSON.stringify([1, 3]);
})(), 'ana occurs at 1 and 3, and they sort next to each other');

check('a pattern that is not there is reported, not invented', (() => {
  const r = run(inst, 'find xyz');
  return at(r, 'found') === false && at(r, 'count') === 0 && at(r, 'ranks') === null;
})());

check('the whole word is found once', at(run(inst, 'find banana'), 'count') === 1);
check('a single letter finds all of its occurrences',
  at(run(inst, 'find a'), 'count') === 3);

check('the longest repeat is found', (() => {
  const r = run(inst, 'lrs');
  return at(r, 'length') === 3 && at(r, 'text') === 'ana'
    && JSON.stringify(at(r, 'at')) === JSON.stringify([1, 3]);
})(), 'ana, at 1 and 3 - overlapping, which is still a repeat');

/* ── 3. Refusing ───────────────────────────────────────────────────── */

console.log('\nerrors');

check('nothing can be asked before a build', (() => {
  const parsed = parseCommand('lrs', plugin.commands);
  if (!parsed.ok) return false;
  const r = fresh().execute(parsed.command);
  return !r.ok && r.error.code === 'PRECONDITION_FAILED' && (r.error.hint ?? '').includes('build banana');
})());
check('a word with digits in it is refused by the parser', (() => {
  const parsed = parseCommand('build ab3c', plugin.commands);
  return !parsed.ok && parsed.error.code === 'BAD_ARGUMENT';
})(), 'words are letters only');
check('an over-long word is refused, with the limit',
  (run(fresh(), `build ${'a'.repeat(5000)}`).error?.hint ?? '').includes('longest is'));

/* ── 4. A word with no repeats at all ──────────────────────────────── */

console.log('\nedges');

check('a one-letter word works', (() => {
  const q = fresh();
  const r = run(q, 'build z').value as { length: number; rounds: number };
  return r.length === 1 && at(run(q, 'lrs'), 'length') === 0
    && at(run(q, 'find z'), 'count') === 1;
})(), 'no rounds needed, and nothing repeats');

check('a word of one letter repeated is all overlap', (() => {
  const q = fresh();
  run(q, 'build aaaa');
  return JSON.stringify(at(run(q, 'suffixes'), 'order')) === JSON.stringify([3, 2, 1, 0])
    && at(run(q, 'lrs'), 'length') === 3
    && at(run(q, 'find aa'), 'count') === 3;
})(), 'aaaa has aaa twice, overlapping');

check('a word with nothing repeated says so', (() => {
  const q = fresh();
  run(q, 'build abcd');
  const r = run(q, 'lrs');
  return at(r, 'length') === 0 && at(r, 'text') === null;
})());

check('the shared prefixes reach the drawing as edge weights', (() => {
  const q = fresh();
  run(q, 'build banana');
  const g = q.getStructure();
  const weights = g.edges.map((e) => e.weight);
  return g.edges.every((e) => e.kind === 'link')
    && JSON.stringify(weights) === JSON.stringify([1, 3, 0, 0, 2]);
})(), 'the LCP is on the edges, not in a list beside them');

check('weights survive into the positioned scene',
  layout(fresh0()).edges.every((e) => typeof e.weight === 'number'));

function fresh0(): ReturnType<PluginInstance['getStructure']> {
  const q = fresh();
  run(q, 'build banana');
  return q.getStructure();
}

/* ── 5. Against sorting the suffixes the slow way ──────────────────── */

console.log('\nproperty test vs plain string sorting');

const rng = createRng(20_260_826);
let trials = 0;
let searches = 0;
let firstFailure = '';

for (let t = 0; t < 60 && firstFailure === ''; t += 1) {
  // A small alphabet makes repeats and ties common, which is where an
  // incremental ranking scheme goes wrong if it goes wrong at all.
  const alphabet = 'ab'.slice(0, rng.nextInt(1, 3)) + (rng.next() < 0.5 ? 'c' : '');
  const n = rng.nextInt(1, 22);
  let text = '';
  for (let i = 0; i < n; i += 1) {
    text += alphabet[rng.nextInt(0, alphabet.length)] as string;
  }

  const q = fresh();
  const r = run(q, `build ${text}`);
  if (r.error !== null) { firstFailure = `build ${text}: ${r.error.message}`; break; }
  trials += 1;

  const wantOrder = naiveOrder(text);
  const gotOrder = at(run(q, 'suffixes'), 'order') as number[];
  if (JSON.stringify(gotOrder) !== JSON.stringify(wantOrder)) {
    firstFailure = `"${text}" sorted as [${gotOrder}], plain comparison gives [${wantOrder}]`;
    break;
  }

  const gotShared = at(run(q, 'suffixes'), 'shared') as number[];
  for (let i = 1; i < n; i += 1) {
    const want = naiveShared(text.slice(wantOrder[i - 1] as number), text.slice(wantOrder[i] as number));
    if (gotShared[i] !== want) {
      firstFailure = `"${text}" shares ${String(gotShared[i])} at rank ${i}, counting gives ${want}`;
      break;
    }
  }
  if (firstFailure !== '') break;
  if (gotShared[0] !== 0) { firstFailure = `"${text}" gave a shared prefix for the first suffix`; break; }

  // Every substring of the word, and a few that are not in it.
  const patterns: string[] = [];
  for (let i = 0; i < n && patterns.length < 12; i += 1) {
    patterns.push(text.slice(i, i + rng.nextInt(1, 5)));
  }
  patterns.push('z', `z${text.slice(0, 2)}`);

  for (const pattern of patterns) {
    if (pattern.length === 0) continue;
    let want = 0;
    for (let i = 0; i + pattern.length <= n; i += 1) {
      if (text.slice(i, i + pattern.length) === pattern) want += 1;
    }
    const found = run(q, `find ${pattern}`);
    searches += 1;
    if (at(found, 'count') !== want) {
      firstFailure = `"${text}" find ${pattern} gave ${String(at(found, 'count'))}, scanning gives ${want}`;
      break;
    }
    const positions = at(found, 'positions') as number[];
    if (positions.some((p) => text.slice(p, p + pattern.length) !== pattern)) {
      firstFailure = `"${text}" find ${pattern} reported a position that does not match`;
      break;
    }
  }
  if (firstFailure !== '') break;

  /*
   * The longest repeat, against every pair of positions. Quadratic and
   * obviously right, which is the point of checking against it.
   */
  let longest = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      longest = Math.max(longest, naiveShared(text.slice(i), text.slice(j)));
    }
  }
  const gotLrs = run(q, 'lrs');
  if (at(gotLrs, 'length') !== longest) {
    firstFailure = `"${text}" longest repeat ${String(at(gotLrs, 'length'))}, every pair gives ${longest}`;
    break;
  }
  const lrsText = at(gotLrs, 'text') as string | null;
  if (lrsText !== null) {
    const occurrences = (at(gotLrs, 'at') as number[])
      .filter((p) => text.slice(p, p + lrsText.length) === lrsText);
    if (lrsText.length !== longest || occurrences.length !== 2) {
      firstFailure = `"${text}" named "${lrsText}" but did not point at two real occurrences`;
      break;
    }
  }
}

check('order, shared prefixes, searches and repeats all agree with the slow way',
  firstFailure === '',
  firstFailure === '' ? `${trials} words, ${searches} searches` : firstFailure);

check('a search costs a binary search, not a scan', (() => {
  const q = fresh();
  let text = '';
  for (let i = 0; i < 256; i += 1) text += 'abcd'[(i * i + i) % 4] as string;
  run(q, `build ${text}`);
  const r = run(q, 'find abc').value as { probes: number };
  return r.probes <= 2 * Math.ceil(Math.log2(256)) + 2;
})(), (() => {
  const q = fresh();
  let text = '';
  for (let i = 0; i < 256; i += 1) text += 'abcd'[(i * i + i) % 4] as string;
  run(q, `build ${text}`);
  const r = run(q, 'find abc').value as { probes: number; count: number };
  return `${r.probes} suffixes probed to find ${r.count} occurrences among 256`;
})());

/* ── 6. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build banana', 'suffixes', 'find ana', 'lrs', 'find xyz']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
