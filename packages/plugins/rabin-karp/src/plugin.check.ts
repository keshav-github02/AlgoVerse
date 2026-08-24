/**
 * Conformance, the rolled hash against a hash computed from scratch, and the
 * positions against a plain scan and against both exact matchers already here.
 *
 *     node packages/plugins/rabin-karp/src/plugin.check.ts
 */

import { createRng, help, parseCommand, type OperationError } from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { kmp } from '@algoverse/plugin-kmp';
import { zAlgorithm } from '@algoverse/plugin-z-algorithm';
import { rabinKarp as plugin } from './plugin.ts';

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

/* ── References ────────────────────────────────────────────────────── */

/** Every occurrence, found by looking at every position. */
function scan(text: string, pattern: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + pattern.length <= text.length; i += 1) {
    if (text.slice(i, i + pattern.length) === pattern) out.push(i);
  }
  return out;
}

/**
 * The hash, written out in full rather than rolled. This is the definition the
 * rolling update claims to be equal to, so it has to be computed a different
 * way to be worth comparing against.
 */
function directHash(s: string, modulus: number): number {
  let h = 0;
  for (const letter of s) h = (h * 27 + (letter.charCodeAt(0) - 96)) % modulus;
  return h;
}

/** What KMP makes of the same question. */
function kmpPositions(text: string, pattern: string): number[] | null {
  const inst = kmp.createInstance({ rng: createRng(1) });
  for (const line of [`build ${pattern}`, `search ${text}`]) {
    const parsed = parseCommand(line, kmp.commands);
    if (!parsed.ok) return null;
    const r = inst.execute(parsed.command);
    if (!r.ok) return null;
    if (line.startsWith('search')) return (r.value as { positions: number[] }).positions;
  }
  return null;
}

/** And what the Z algorithm makes of it, which is a third opinion. */
function zPositions(text: string, pattern: string): number[] | null {
  const inst = zAlgorithm.createInstance({ rng: createRng(1) });
  for (const line of [`build ${text}`, `find ${pattern}`]) {
    const parsed = parseCommand(line, zAlgorithm.commands);
    if (!parsed.ok) return null;
    const r = inst.execute(parsed.command);
    if (!r.ok) return null;
    if (line.startsWith('find')) return (r.value as { positions: number[] }).positions;
  }
  return null;
}

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, ['build abcab', 'search abcabcab', 'hashes abcabcab', 'modulus 97'])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. The hash itself ────────────────────────────────────────────── */

console.log('\nthe hash');

const inst = fresh();
const built = run(inst, 'build abc');

check('the running hashes are Horner, one letter at a time', (() => {
  // a=1, b=2, c=3, base 27: 1, then 1*27+2 = 29, then 29*27+3 = 786.
  return JSON.stringify(at(built, 'runningHashes')) === JSON.stringify([1, 29, 786])
    && at(built, 'hash') === 786;
})(), '1, 29, 786');

check('no letter is worth zero', (() => {
  /*
   * If "a" hashed to 0 then "a" and "aa" would agree, and so would every pair
   * differing only in leading letters. Mapping a to 1 rather than 0 is the
   * whole reason the base is 27 and not 26.
   */
  const q = fresh();
  const one = at(run(q, 'build a'), 'hash');
  const two = at(run(q, 'build aa'), 'hash');
  return one !== two && one === 1 && two === 28;
})(), 'a is 1 and aa is 28, not both 0');

check('order matters', (() => {
  const q = fresh();
  const ab = at(run(q, 'build ab'), 'hash');
  const ba = at(run(q, 'build ba'), 'hash');
  return ab !== ba;
})(), 'ab and ba are different numbers');

/* ── 3. Rolling against computing from scratch ─────────────────────── */

console.log('\nrolling');

check('every rolled window hash equals the hash computed directly', (() => {
  const q = fresh();
  run(q, 'build abc');
  const rows = at(run(q, 'hashes abcabxabc'), 'rows') as
    { start: number; window: string; hash: number }[];
  // Nine letters, windows of width three: seven of them.
  return rows.length === 7
    && rows.every((row) => row.hash === directHash(row.window, 1_000_000_007));
})(), 'the roll is an optimisation, not a different function');

check('the roll survives a wrap', (() => {
  /*
   * With a small modulus the intermediate subtraction goes negative, and a
   * remainder of a negative number is negative in this language. If that is
   * not corrected the hash silently stops matching, which is the one bug in
   * this algorithm that produces plausible wrong answers rather than a crash.
   */
  const q = fresh();
  run(q, 'build abc');
  run(q, 'modulus 101');
  const rows = at(run(q, 'hashes zyxwvutsrq'), 'rows') as { window: string; hash: number }[];
  return rows.length === 8 && rows.every((row) => row.hash === directHash(row.window, 101))
    && rows.every((row) => row.hash >= 0);
})(), 'modulus 101, letters near the top of the alphabet');

check('a window wider than the text gives no windows at all', (() => {
  const q = fresh();
  run(q, 'build abcdef');
  const r = run(q, 'hashes abc');
  return (at(r, 'rows') as unknown[]).length === 0 && at(run(q, 'search abc'), 'count') === 0;
})());

/* ── 4. Searching ──────────────────────────────────────────────────── */

console.log('\nsearching');

check('every occurrence is found, overlaps included', (() => {
  const q = fresh();
  run(q, 'build aba');
  const r = run(q, 'search ababa');
  return at(r, 'count') === 2 && JSON.stringify(at(r, 'positions')) === JSON.stringify([0, 2]);
})());

check('a large modulus means no window is ever verified', (() => {
  const q = fresh();
  run(q, 'build aaab');
  const r = run(q, `search ${'a'.repeat(64)}`);
  // Sixty-one windows, none of them equal to the pattern's hash, so the
  // pattern itself is never read during the search at all.
  return at(r, 'windows') === 61 && at(r, 'hits') === 0 && at(r, 'comparisons') === 0;
})(), 'the hash does all the work; the pattern is not looked at once');

check('a hit that is not a match is counted as spurious, not reported', (() => {
  const q = fresh();
  run(q, 'build abc');
  run(q, 'modulus 1');
  const r = run(q, 'search abcxbcabc');
  return at(r, 'count') === 2
    && (at(r, 'spurious') as number) > 0
    && at(r, 'hits') === at(r, 'windows');
})(), 'modulus 1 makes every window a hit and every hit but two a lie');

/* ── 5. The answer does not depend on the modulus; the cost does ───── */

console.log('\nwhat the modulus changes');

check('a hopeless modulus gives the same answer as a good one', (() => {
  /*
   * The claim that makes this algorithm usable at all. Verification is not a
   * safety net for unlikely cases - it is what makes the hash an optimisation
   * rather than an approximation, and turning the hash off entirely must not
   * change a single reported position.
   */
  const text = 'abcabxabcabcaby';
  const good = fresh();
  run(good, 'build abcab');
  const withGood = run(good, `search ${text}`);

  const bad = fresh();
  run(bad, 'build abcab');
  run(bad, 'modulus 1');
  const withBad = run(bad, `search ${text}`);

  return JSON.stringify(at(withGood, 'positions')) === JSON.stringify(at(withBad, 'positions'))
    && JSON.stringify(at(withGood, 'positions')) === JSON.stringify(scan(text, 'abcab'));
})(), 'modulus 1 and modulus 1e9+7 report the same positions');

check('and it is the comparison count that pays for it', (() => {
  /*
   * On a text where the pattern is rare, which is the only kind that can show
   * what the hash saves - a text riddled with occurrences has to verify them
   * under any modulus at all.
   */
  const text = 'xxxxxabcabxxxxx';
  const good = fresh();
  run(good, 'build abcab');
  const withGood = run(good, `search ${text}`);

  const bad = fresh();
  run(bad, 'build abcab');
  run(bad, 'modulus 1');
  const withBad = run(bad, `search ${text}`);

  const found = (at(withGood, 'positions') as number[]).length;
  const cheap = at(withGood, 'comparisons') as number;
  const dear = at(withBad, 'comparisons') as number;

  // With a good modulus the only letters compared are the ones in a real
  // occurrence; with a useless one every window is opened and read.
  return found === 1
    && cheap === found * 'abcab'.length
    && at(withGood, 'hits') === found
    && at(withBad, 'hits') === at(withBad, 'windows')
    && dear > cheap * 2;
})(), 'the difference between linear and quadratic is entirely the modulus');

check('collisions are counted and reported honestly', (() => {
  const q = fresh();
  run(q, 'build abc');
  run(q, 'modulus 7');
  const r = run(q, 'hashes abcdefghijklm');
  const windows = at(r, 'distinctWindows') as number;
  const hashes = at(r, 'distinctHashes') as number;
  return windows === 11 && hashes <= 7 && at(r, 'collisions') === windows - hashes;
})(), 'eleven distinct windows cannot have more than seven distinct hashes');

check('changing the modulus rehashes what is already built', (() => {
  /*
   * The setting and the state must not drift apart. Without a rehash, the
   * pattern's hash would still be the old one and a search would compare it
   * against windows taken under the new modulus - finding nothing, silently.
   */
  const q = fresh();
  run(q, 'build abc');
  const r = run(q, 'modulus 101');
  return at(r, 'hash') === directHash('abc', 101)
    && at(run(q, 'search xxabcxx'), 'count') === 1;
})(), 'abc under 101, and a search that still works');

check('the modulus survives a build, because it is a setting', (() => {
  const q = fresh();
  run(q, 'modulus 101');
  return at(run(q, 'build abc'), 'modulus') === 101;
})());

/* ── 6. Against both exact matchers ────────────────────────────────── */

console.log('\nagainst KMP and the Z algorithm');

check('all three matchers agree on the same text', (() => {
  const text = 'abababcababababc';
  const pattern = 'ababc';
  const q = fresh();
  run(q, `build ${pattern}`);
  const mine = at(run(q, `search ${text}`), 'positions') as number[];
  const theirs = kmpPositions(text, pattern);
  const others = zPositions(text, pattern);
  const want = JSON.stringify(scan(text, pattern));
  return JSON.stringify(mine) === want
    && JSON.stringify(theirs) === want
    && JSON.stringify(others) === want;
})(), 'hashing, borders, Z values and a plain scan, all four the same');

/* ── 7. Refusing ───────────────────────────────────────────────────── */

console.log('\nerrors');

check('nothing can be searched before a build', (() => {
  const parsed = parseCommand('search abc', plugin.commands);
  if (!parsed.ok) return false;
  const r = fresh().execute(parsed.command);
  return !r.ok && r.error.code === 'PRECONDITION_FAILED';
})());
check('a modulus below one is refused, with both extremes explained',
  (run(fresh(), 'modulus 0').error?.hint ?? '').includes('every hash collide'));
check('a modulus that would lose precision is refused, with the ceiling', (() => {
  const r = run(fresh(), 'modulus 9007199254740991');
  return r.error?.code === 'BAD_ARGUMENT' && (r.error.hint ?? '').includes('lose precision');
})());
check('an over-long text is refused, with the limit',
  (() => {
    const q = fresh();
    run(q, 'build abc');
    return (run(q, `search ${'a'.repeat(5000)}`).error?.hint ?? '').includes('longest is');
  })());

/* ── 8. Property test ──────────────────────────────────────────────── */

console.log('\nproperty test vs a scan, a direct hash, and two exact matchers');

const rng = createRng(20_260_831);
let trials = 0;
let searches = 0;
let withSpurious = 0;
let firstFailure = '';

for (let t = 0; t < 80 && firstFailure === ''; t += 1) {
  const alphabet = rng.next() < 0.6 ? 'ab' : 'abcd';
  const n = rng.nextInt(1, 24);
  let text = '';
  for (let i = 0; i < n; i += 1) text += alphabet[rng.nextInt(0, alphabet.length)] as string;

  // A small modulus part of the time, so collisions genuinely happen and the
  // verification path is exercised rather than merely present.
  const modulus = rng.next() < 0.4 ? rng.nextInt(1, 12) : 1_000_000_007;

  for (let s = 0; s < 3 && firstFailure === ''; s += 1) {
    const m = rng.nextInt(1, 6);
    let pattern = '';
    for (let i = 0; i < m; i += 1) pattern += alphabet[rng.nextInt(0, alphabet.length)] as string;

    const q = fresh();
    const setMod = run(q, `modulus ${modulus}`);
    if (setMod.error !== null) { firstFailure = `modulus ${modulus}: ${setMod.error.message}`; break; }
    const b = run(q, `build ${pattern}`);
    if (b.error !== null) { firstFailure = `build ${pattern}: ${b.error.message}`; break; }
    trials += 1;

    // The rolling update against the definition, at every window.
    const rows = at(run(q, `hashes ${text}`), 'rows') as { window: string; hash: number }[];
    const wrong = rows.find((row) => row.hash !== directHash(row.window, modulus));
    if (wrong !== undefined) {
      firstFailure = `window "${wrong.window}" rolled to ${wrong.hash}, directly it is `
        + `${directHash(wrong.window, modulus)} (modulus ${modulus})`;
      break;
    }

    const r = run(q, `search ${text}`);
    searches += 1;
    const got = at(r, 'positions') as number[];
    const want = scan(text, pattern);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      firstFailure = `"${pattern}" in "${text}" under modulus ${modulus} found [${got}], `
        + `scanning gives [${want}]`;
      break;
    }
    if ((at(r, 'spurious') as number) > 0) withSpurious += 1;

    /*
     * Every hit is either a reported occurrence or a spurious one; there is no
     * third thing it could be, and a mismatch here would mean the counters are
     * describing a different run from the one that produced the positions.
     */
    if ((at(r, 'hits') as number) !== got.length + (at(r, 'spurious') as number)) {
      firstFailure = `${at(r, 'hits')} hits but ${got.length} matches and `
        + `${at(r, 'spurious')} spurious on "${pattern}" in "${text}"`;
      break;
    }

    const theirs = kmpPositions(text, pattern);
    const others = zPositions(text, pattern);
    if (JSON.stringify(theirs) !== JSON.stringify(want)
      || JSON.stringify(others) !== JSON.stringify(want)) {
      firstFailure = `"${pattern}" in "${text}": scan [${want}], KMP [${String(theirs)}], `
        + `Z [${String(others)}]`;
      break;
    }
  }
}

check('positions match a scan and both matchers, and hashes match the definition',
  firstFailure === '',
  firstFailure === ''
    ? `${trials} patterns, ${searches} searches, ${withSpurious} with a spurious hit`
    : firstFailure);

check('spurious hits really happened, so verification was really exercised',
  withSpurious > 0,
  `${withSpurious} of ${searches} searches had a hash lie to them`);

/* ── 9. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build abcab', 'search abcabcab', 'hashes abcabcab', 'modulus 97']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
