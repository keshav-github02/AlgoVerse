/**
 * Conformance, every answer against enumerating the substrings by hand, and the
 * two hard numbers against the suffix array - which encodes the same
 * information by sorting rather than by merging.
 *
 *     node packages/plugins/suffix-automaton/src/plugin.check.ts
 */

import {
  createRng, help, parseCommand,
  type NodeId, type OperationError, type StructureGraph,
} from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { suffixArray } from '@algoverse/plugin-suffix-array';
import { suffixAutomaton as plugin } from './plugin.ts';

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

/** Every substring, in a set. Quadratic in space and impossible to misread. */
function allSubstrings(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length; i += 1) {
    for (let j = i + 1; j <= s.length; j += 1) out.add(s.slice(i, j));
  }
  return out;
}

/** Occurrences counted by looking at every position. */
function countIn(text: string, word: string): number {
  let n = 0;
  for (let i = 0; i + word.length <= text.length; i += 1) {
    if (text.slice(i, i + word.length) === word) n += 1;
  }
  return n;
}

/** The longest substring occurring twice or more, found by trying all of them. */
function longestRepeat(s: string): number {
  let best = 0;
  for (const sub of allSubstrings(s)) {
    if (sub.length > best && countIn(s, sub) >= 2) best = sub.length;
  }
  return best;
}

/**
 * What the suffix array makes of the same word.
 *
 * It sorts the suffixes and takes the distinct-substring count from the shared
 * prefixes between neighbours; this one merges states and takes it from a sum
 * of class widths. Nothing about the two derivations resembles the other, so
 * agreeing on the number is real evidence rather than a restatement.
 */
function bySuffixArray(text: string): { distinct: number; repeat: number } | null {
  const inst = suffixArray.createInstance({ rng: createRng(1) });
  let distinct: number | null = null;
  for (const line of [`build ${text}`, 'lrs']) {
    const parsed = parseCommand(line, suffixArray.commands);
    if (!parsed.ok) return null;
    const r = inst.execute(parsed.command);
    if (!r.ok) return null;
    if (line.startsWith('build')) {
      distinct = (r.value as { distinctSubstrings: number }).distinctSubstrings;
    } else {
      const repeat = (r.value as { length: number }).length;
      return distinct === null ? null : { distinct, repeat };
    }
  }
  return null;
}

/* ── Reading the automaton off the picture ─────────────────────────── */

interface Read {
  readonly len: Map<NodeId, number>;
  readonly link: Map<NodeId, NodeId>;
  readonly next: Map<NodeId, Map<string, NodeId>>;
  readonly start: NodeId;
}

function readAutomaton(g: StructureGraph): Read | string {
  const len = new Map<NodeId, number>();
  for (const n of g.nodes) len.set(n.id, n.value);
  const link = new Map<NodeId, NodeId>();
  const next = new Map<NodeId, Map<string, NodeId>>();

  for (const e of g.edges) {
    if (e.slot === 'link') link.set(e.from, e.to);
    else if (e.slot.startsWith('t')) {
      const m = next.get(e.from) ?? new Map<string, NodeId>();
      m.set(e.slot.slice(1), e.to);
      next.set(e.from, m);
    } else return `unexpected slot "${e.slot}"`;
  }

  const start = g.roots[0];
  if (start === undefined) return 'no start state';
  return { len, link, next, start };
}

/**
 * Every string the drawn automaton accepts, up to a length, by walking it.
 *
 * This is what makes the picture answerable rather than decorative: if the
 * drawing accepts exactly the substrings, it is the automaton; if it accepts
 * anything else, it is a picture of something else.
 */
function acceptedBy(read: Read, limit: number): Set<string> {
  const out = new Set<string>();
  const stack: { at: NodeId; word: string }[] = [{ at: read.start, word: '' }];
  while (stack.length > 0) {
    const top = stack.pop() as { at: NodeId; word: string };
    if (top.word !== '') out.add(top.word);
    if (top.word.length >= limit) continue;
    for (const [letter, to] of read.next.get(top.at) ?? []) {
      stack.push({ at: to, word: `${top.word}${letter}` });
    }
  }
  return out;
}

/**
 * The substring count, worked out from the drawing alone.
 *
 * Each state stands for the strings whose lengths run from its link's length
 * plus one up to its own, so the widths add up to the number of distinct
 * substrings. The plugin computes the same sum from its own fields; doing it
 * again from the published graph checks that the lengths and links on screen
 * are the ones the answer was derived from, rather than a separate story.
 */
function countedFromPicture(read: Read): number | string {
  let total = 0;
  for (const [id, len] of read.len) {
    const up = read.link.get(id);
    if (up === undefined) {
      if (len !== 0) return `state of length ${len} has no suffix link`;
      continue;
    }
    const shorter = read.len.get(up);
    if (shorter === undefined) return `a suffix link points at nothing`;
    if (shorter >= len) return `a suffix link goes from ${len} to ${shorter}, which is not shorter`;
    total += len - shorter;
  }
  return total;
}

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, [
  'build abcbc', 'contains bcb', 'occurrences bc', 'distinct', 'repeated',
])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. A worked example ───────────────────────────────────────────── */

console.log('\nabcbc');

const inst = fresh();
const built = run(inst, 'build abcbc');

check('every substring is accepted and nothing else is', (() => {
  const read = readAutomaton(inst.getStructure());
  if (typeof read === 'string') return false;
  const accepted = acceptedBy(read, 5);
  const want = allSubstrings('abcbc');
  if (accepted.size !== want.size) return false;
  for (const s of want) if (!accepted.has(s)) return false;
  return true;
})(), `${allSubstrings('abcbc').size} substrings, and the automaton accepts exactly those`);

check('the distinct count is a sum of class widths', (() => {
  // 5 letters could have 15 substrings; bc repeats, so there are fewer.
  const read = readAutomaton(inst.getStructure());
  if (typeof read === 'string') return false;
  return at(built, 'distinctSubstrings') === allSubstrings('abcbc').size
    && at(run(inst, 'distinct'), 'atMost') === 15
    // And the same sum, added up off the drawing.
    && countedFromPicture(read) === allSubstrings('abcbc').size;
})(), `${String(at(built, 'distinctSubstrings'))} of a possible 15`);

check('a split happened, and is reported', (() => {
  /*
   * bc occurs twice, at 1 and 3. When the second c arrives, the state holding
   * bc's class no longer speaks for everything it did, so it splits. A word
   * with no repeats needs no splits at all, which is the contrast.
   */
  const q = fresh();
  const plain = run(q, 'build abcd');
  return (at(built, 'splits') as number) >= 1 && at(plain, 'splits') === 0;
})(), 'abcbc splits, abcd does not');

check('the state count stays under twice the length', (() => {
  const q = fresh();
  // The bound is 2n - 1 for n >= 2, and it is tight on words like this.
  const r = run(q, 'build abbbbbbbb');
  return (at(r, 'states') as number) <= 2 * 9
    && (at(built, 'statesPerLetter') as number) < 2;
})(), `abcbc uses ${String(at(built, 'statesPerLetter'))} states per letter`);

check('membership is a walk with no backtracking', (() => {
  return at(run(inst, 'contains bcb'), 'contains') === true
    && at(run(inst, 'contains bcbc'), 'contains') === true
    && at(run(inst, 'contains bb'), 'contains') === false;
})());

check('a miss reports how far it got', (() => {
  // "cba" walks c, then b, then falls off: two letters of it are substrings.
  const r = run(inst, 'contains cba');
  return at(r, 'contains') === false && at(r, 'matched') === 2;
})(), 'cb is a substring, cba is not');

check('occurrences are counted off the state', (() => {
  return at(run(inst, 'occurrences bc'), 'count') === 2
    && at(run(inst, 'occurrences c'), 'count') === 2
    && at(run(inst, 'occurrences a'), 'count') === 1
    && at(run(inst, 'occurrences abcbc'), 'count') === 1;
})(), 'bc twice, c twice, a once');

check('something absent occurs zero times',
  at(run(inst, 'occurrences bb'), 'count') === 0);

check('the longest repeat is found without comparing anything', (() => {
  const r = run(inst, 'repeated');
  return at(r, 'length') === 2 && at(r, 'substring') === 'bc' && at(r, 'occurrences') === 2;
})(), 'bc, twice');

check('a word with no repeat says so', (() => {
  const q = fresh();
  run(q, 'build abcd');
  const r = run(q, 'repeated');
  return at(r, 'length') === 0 && at(r, 'substring') === null;
})());

check('one letter is the smallest case and still works', (() => {
  const q = fresh();
  const r = run(q, 'build a');
  return at(r, 'states') === 2 && at(r, 'distinctSubstrings') === 1
    && at(run(q, 'occurrences a'), 'count') === 1
    && at(run(q, 'repeated'), 'length') === 0;
})());

check('a word of one repeated letter needs no splits', (() => {
  const q = fresh();
  const r = run(q, 'build aaaa');
  // States are the empty string and the four lengths of a; substrings are a,
  // aa, aaa, aaaa.
  return at(r, 'states') === 5 && at(r, 'splits') === 0
    && at(r, 'distinctSubstrings') === 4
    && at(run(q, 'occurrences aa'), 'count') === 3;
})(), 'aa occurs three times in aaaa');

/* ── 3. Against the suffix array ───────────────────────────────────── */

console.log('\nagainst the suffix array');

check('both agree how many substrings there are, and how long the repeat is', (() => {
  for (const word of ['abcbc', 'banana', 'aabaaab', 'mississippi', 'abracadabra']) {
    const q = fresh();
    const mine = run(q, `build ${word}`);
    const rep = run(q, 'repeated');
    const theirs = bySuffixArray(word);
    if (theirs === null) return false;
    if (at(mine, 'distinctSubstrings') !== theirs.distinct) return false;
    if (at(rep, 'length') !== theirs.repeat) return false;
  }
  return true;
})(), 'five words, counted by merging states and by sorting suffixes');

/* ── 4. Refusing ───────────────────────────────────────────────────── */

console.log('\nerrors');

check('nothing can be asked before a build', (() => {
  const parsed = parseCommand('distinct', plugin.commands);
  if (!parsed.ok) return false;
  const r = fresh().execute(parsed.command);
  return !r.ok && r.error.code === 'PRECONDITION_FAILED';
})());
check('an over-long word is refused, with the limit',
  (run(fresh(), `build ${'a'.repeat(3000)}`).error?.hint ?? '').includes('longest is'));

/* ── 5. Property test ──────────────────────────────────────────────── */

console.log('\nproperty test vs enumerating substrings, and vs the suffix array');

const rng = createRng(20_260_903);
let trials = 0;
let queries = 0;
let splits = 0;
let firstFailure = '';

for (let t = 0; t < 60 && firstFailure === ''; t += 1) {
  const alphabet = rng.next() < 0.6 ? 'ab' : 'abc';
  const n = rng.nextInt(1, 15);
  let text = '';
  for (let i = 0; i < n; i += 1) text += alphabet[rng.nextInt(0, alphabet.length)] as string;

  const q = fresh();
  const b = run(q, `build ${text}`);
  if (b.error !== null) { firstFailure = `build ${text}: ${b.error.message}`; break; }
  trials += 1;
  splits += at(b, 'splits') as number;

  const want = allSubstrings(text);

  // The state count bound, which is the reason the structure is worth having.
  if ((at(b, 'states') as number) > Math.max(2, 2 * n - 1)) {
    firstFailure = `"${text}" used ${at(b, 'states')} states, the bound is ${2 * n - 1}`;
    break;
  }

  if (at(b, 'distinctSubstrings') !== want.size) {
    firstFailure = `"${text}" says ${at(b, 'distinctSubstrings')} substrings, there are ${want.size}`;
    break;
  }

  // The drawn automaton accepts exactly the substrings, and nothing else.
  const read = readAutomaton(q.getStructure());
  if (typeof read === 'string') { firstFailure = `picture: ${read}`; break; }
  const summed = countedFromPicture(read);
  if (summed !== want.size) {
    firstFailure = `"${text}" drawn lengths add to ${String(summed)}, there are ${want.size} substrings`;
    break;
  }
  const accepted = acceptedBy(read, n);
  if (accepted.size !== want.size) {
    firstFailure = `"${text}" is drawn accepting ${accepted.size} strings, it has ${want.size} substrings`;
    break;
  }
  for (const s of want) {
    if (!accepted.has(s)) { firstFailure = `"${text}" is drawn rejecting its substring "${s}"`; break; }
  }
  if (firstFailure !== '') break;

  const rep = run(q, 'repeated');
  const wantRepeat = longestRepeat(text);
  if (at(rep, 'length') !== wantRepeat) {
    firstFailure = `"${text}" longest repeat ${at(rep, 'length')}, trying all gives ${wantRepeat}`;
    break;
  }
  const reported = at(rep, 'substring') as string | null;
  if (reported !== null && (reported.length !== wantRepeat || countIn(text, reported) < 2)) {
    firstFailure = `"${text}" reported "${String(reported)}" as its longest repeat`;
    break;
  }

  const theirs = bySuffixArray(text);
  if (theirs === null || theirs.distinct !== want.size || theirs.repeat !== wantRepeat) {
    firstFailure = `the suffix array disagrees about "${text}": ${JSON.stringify(theirs)}`;
    break;
  }

  // Membership and counting, on substrings and on words that are not.
  for (let k = 0; k < 4; k += 1) {
    const m = rng.nextInt(1, 5);
    let word = '';
    for (let i = 0; i < m; i += 1) word += alphabet[rng.nextInt(0, alphabet.length)] as string;
    queries += 1;

    const c = run(q, `contains ${word}`);
    if (at(c, 'contains') !== text.includes(word)) {
      firstFailure = `"${word}" in "${text}": says ${at(c, 'contains')}`;
      break;
    }
    const o = run(q, `occurrences ${word}`);
    if (at(o, 'count') !== countIn(text, word)) {
      firstFailure = `"${word}" in "${text}" counted ${at(o, 'count')}, scanning gives ${countIn(text, word)}`;
      break;
    }
  }
}

check('the drawn automaton accepts exactly the substrings, and every count agrees',
  firstFailure === '',
  firstFailure === ''
    ? `${trials} words, ${queries} queries, ${splits} splits along the way`
    : firstFailure);

check('splits really happened, so the hard case was exercised',
  splits > 20, `${splits} splits`);

/* ── 6. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build abcbc', 'contains bcb', 'occurrences bc', 'distinct', 'repeated']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
