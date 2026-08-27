/**
 * Conformance, the failure links against their own definition, and the
 * occurrences against a plain scan and against KMP run once per word.
 *
 *     node packages/plugins/aho-corasick/src/plugin.check.ts
 */

import {
  Timeline, createRng, help, parseCommand,
  type NodeId, type OperationError, type SimEvent, type StructureGraph,
} from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { kmp } from '@algoverse/plugin-kmp';
import { ahoCorasick as plugin } from './plugin.ts';

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

/** How many nodes an operation actually touched, which is its measured cost. */
function visitsOf(inst: PluginInstance, line: string): number {
  const parsed = parseCommand(line, plugin.commands);
  if (!parsed.ok) return -1;
  const r = inst.execute(parsed.command);
  if (!r.ok) return -1;
  return r.events.filter((e) => e.kind === 'NodeVisited').length;
}

const at = (r: { value: unknown }, key: string): unknown =>
  (r.value as Record<string, unknown> | null)?.[key];

/* ── References ────────────────────────────────────────────────────── */

/** Every occurrence of every word, found by looking at every position. */
function scan(text: string, words: readonly string[]): string[] {
  const out: string[] = [];
  for (const word of words) {
    for (let i = 0; i + word.length <= text.length; i += 1) {
      if (text.slice(i, i + word.length) === word) out.push(`${word}@${i}`);
    }
  }
  return out.sort((a, b) => {
    const [wa, ia] = a.split('@') as [string, string];
    const [wb, ib] = b.split('@') as [string, string];
    return Number(ia) - Number(ib) || wa.localeCompare(wb);
  });
}

/**
 * The same question asked of KMP, one word at a time.
 *
 * This is what Aho-Corasick replaces: a separate pass per word, each with its
 * own borders. The answers must be identical - all that changes is that one
 * pass does the work of all of them.
 */
function byKmp(text: string, words: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const word of words) {
    const inst = kmp.createInstance({ rng: createRng(1) });
    for (const line of [`build ${word}`, `search ${text}`]) {
      const parsed = parseCommand(line, kmp.commands);
      if (!parsed.ok) return null;
      const r = inst.execute(parsed.command);
      if (!r.ok) return null;
      if (line.startsWith('search')) {
        for (const p of (r.value as { positions: number[] }).positions) out.push(`${word}@${p}`);
      }
    }
  }
  return out.sort((a, b) => {
    const [wa, ia] = a.split('@') as [string, string];
    const [wb, ib] = b.split('@') as [string, string];
    return Number(ia) - Number(ib) || wa.localeCompare(wb);
  });
}

/* ── Reading the automaton off the picture ─────────────────────────── */

interface Read {
  readonly stringOf: Map<NodeId, string>;
  readonly fail: Map<NodeId, NodeId>;
  readonly output: Map<NodeId, NodeId>;
}

/** Every state's string, and its two kinds of link, taken from the drawing. */
function readAutomaton(g: StructureGraph): Read | string {
  const children = new Map<NodeId, [string, NodeId][]>();
  const fail = new Map<NodeId, NodeId>();
  const output = new Map<NodeId, NodeId>();
  const label = new Map<NodeId, string>();
  for (const n of g.nodes) label.set(n.id, n.label);

  for (const e of g.edges) {
    if (e.slot === 'fail') fail.set(e.from, e.to);
    else if (e.slot === 'out') output.set(e.from, e.to);
    else if (e.slot.startsWith('c')) {
      const list = children.get(e.from) ?? [];
      list.push([e.slot.slice(1), e.to]);
      children.set(e.from, list);
    } else return `unexpected slot "${e.slot}"`;
  }

  const root = g.roots[0];
  if (root === undefined) return 'no root';
  const stringOf = new Map<NodeId, string>([[root, '']]);
  const queue: NodeId[] = [root];
  while (queue.length > 0) {
    const id = queue.shift() as NodeId;
    for (const [letter, child] of children.get(id) ?? []) {
      if (letter !== label.get(child)) {
        return `edge says "${letter}" but the state is labelled "${String(label.get(child))}"`;
      }
      stringOf.set(child, `${stringOf.get(id) as string}${letter}`);
      queue.push(child);
    }
  }
  if (stringOf.size !== g.nodes.length) {
    return `${stringOf.size} of ${g.nodes.length} states are reachable from the root`;
  }
  return { stringOf, fail, output };
}

/** The definition, applied by trying every suffix from the longest down. */
function longestUsableSuffix(s: string, prefixes: ReadonlySet<string>): string {
  for (let len = s.length - 1; len > 0; len -= 1) {
    const tail = s.slice(s.length - len);
    if (prefixes.has(tail)) return tail;
  }
  return '';
}

function allPrefixes(words: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const w of words) for (let i = 1; i <= w.length; i += 1) out.add(w.slice(0, i));
  return out;
}

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, [
  'build [he she his hers]', 'search ushers', 'count ushers', 'links',
])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. The worked example ─────────────────────────────────────────── */

console.log('\nhe, she, his, hers');

const words = ['he', 'she', 'his', 'hers'];
const inst = fresh();
const built = run(inst, `build [${words.join(' ')}]`);

check('the trie shares what the words share', (() => {
  /*
   * he, hers and his all begin with h, and he is a prefix of hers, so twelve
   * letters of words need only nine states below the root: h, he, her, hers,
   * hi, his, s, sh, she.
   */
  return at(built, 'letters') === 12 && at(built, 'states') === 10
    && at(built, 'shared') === 3 && at(built, 'deepest') === 4;
})(), `${String(at(built, 'letters'))} letters in ${String(at(built, 'states'))} states, `
  + `${String(at(built, 'shared'))} shared`);

check('every occurrence of every word is found in one pass', (() => {
  const r = run(inst, 'search ushers');
  // she at 1, then he and hers both starting at 2.
  return at(r, 'count') === 3
    && JSON.stringify(at(r, 'occurrences')) === JSON.stringify(['she@1', 'he@2', 'hers@2']);
})(), 'she@1, he@2, hers@2 - and his is not there');

check('a word that is a suffix of another is still found', (() => {
  /*
   * The case output links exist for. "he" ends inside "she", so the state for
   * "she" is not itself the end of "he" - something has to point at it.
   */
  const q = fresh();
  run(q, 'build [she he]');
  const r = run(q, 'search she');
  return at(r, 'count') === 2
    && JSON.stringify(at(r, 'occurrences')) === JSON.stringify(['she@0', 'he@1']);
})());

check('three words ending at the same letter are all reported', (() => {
  const q = fresh();
  run(q, 'build [abc bc c]');
  const r = run(q, 'search abc');
  return at(r, 'count') === 3
    && JSON.stringify(at(r, 'occurrences')) === JSON.stringify(['abc@0', 'bc@1', 'c@2']);
})(), 'one position, three matches, one chain of output links');

check('overlapping occurrences of one word are all found', (() => {
  const q = fresh();
  run(q, 'build [aa]');
  return JSON.stringify(at(run(q, 'search aaaa'), 'occurrences'))
    === JSON.stringify(['aa@0', 'aa@1', 'aa@2']);
})());

check('a letter in no word sends the walk back to the root', (() => {
  const q = fresh();
  run(q, 'build [abc]');
  const r = run(q, 'search abxabc');
  return at(r, 'count') === 1 && JSON.stringify(at(r, 'occurrences')) === JSON.stringify(['abc@3']);
})(), 'the x throws away the ab, and abc is still found after it');

/* ── 3. The failure links against their definition ─────────────────── */

console.log('\nfailure links');

check('every link goes to the longest usable suffix', (() => {
  const read = readAutomaton(inst.getStructure());
  if (typeof read === 'string') return false;
  const prefixes = allPrefixes(words);
  for (const [id, s] of read.stringOf) {
    if (s === '') continue;
    const target = read.fail.get(id);
    const got = target === undefined ? '' : read.stringOf.get(target) as string;
    if (got !== longestUsableSuffix(s, prefixes)) return false;
  }
  return true;
})(), 'checked against trying every suffix of every state');

check('the link from "she" resumes at "he"', (() => {
  const read = readAutomaton(inst.getStructure());
  if (typeof read === 'string') return false;
  const byString = new Map([...read.stringOf].map(([id, s]) => [s, id]));
  const she = byString.get('she') as NodeId;
  return read.stringOf.get(read.fail.get(she) as NodeId) === 'he';
})(), 'having read s-h-e, the last two letters still begin a word');

check('a state whose suffix begins nothing resumes at the root', (() => {
  const read = readAutomaton(inst.getStructure());
  if (typeof read === 'string') return false;
  const byString = new Map([...read.stringOf].map(([id, s]) => [s, id]));
  const hi = byString.get('hi') as NodeId;
  // "i" starts no word, so nothing of "hi" survives.
  return read.stringOf.get(read.fail.get(hi) as NodeId) === '';
})());

check('output links point at the nearest state that ends a word', (() => {
  const read = readAutomaton(inst.getStructure());
  if (typeof read === 'string') return false;
  const byString = new Map([...read.stringOf].map(([id, s]) => [s, id]));
  const she = byString.get('she') as NodeId;
  const her = byString.get('her') as NodeId;
  // "she" contains "he"; "her" contains nothing that is a whole word.
  return read.stringOf.get(read.output.get(she) as NodeId) === 'he'
    && read.output.get(her) === undefined;
})());

check('the links table reads the states back as strings', (() => {
  const r = run(inst, 'links');
  const rows = at(r, 'rows') as { state: string; resumesAt: string; ends: boolean }[];
  const she = rows.find((row) => row.state === 'she');
  return rows.length === 9 && she?.resumesAt === 'he' && she.ends === true;
})(), 'nine states below the root');

/* ── 4. Counting without listing ───────────────────────────────────── */

console.log('\ncounting against listing');

check('the two agree about how many there are', (() => {
  const q = fresh();
  run(q, 'build [a aa aaa]');
  const text = 'aaaaa';
  return at(run(q, `count ${text}`), 'count') === at(run(q, `search ${text}`), 'count');
})());

check('counting costs one read per letter, whatever the words are', (() => {
  const q = fresh();
  run(q, 'build [a aa aaa]');
  const r = run(q, 'count aaaaa');
  // a occurs 5 times, aa 4, aaa 3: twelve matches from five letters.
  return at(r, 'count') === 12 && at(r, 'reads') === 5;
})(), 'twelve occurrences reported after five reads');

check('listing costs more, and the log says so', (() => {
  /*
   * The difference between O(n) and O(n + z), measured rather than asserted:
   * the same text and the same automaton, and listing touches a node per match
   * on top of the walk.
   */
  const q = fresh();
  run(q, 'build [a aa aaa]');
  const counting = visitsOf(q, 'count aaaaa');
  const listing = visitsOf(q, 'search aaaaa');
  /*
   * Counting touches the states the walk passes through, which is one per
   * letter plus the fallbacks - bounded by the text and nothing else. Listing
   * touches one more per match it has to write down, and there are twelve
   * matches in these five letters.
   */
  return counting >= 5 && listing > counting;
})(), (() => {
  const q = fresh();
  run(q, 'build [a aa aaa]');
  return `${visitsOf(q, 'count aaaaa')} nodes to count, ${visitsOf(q, 'search aaaaa')} to list`;
})());

check('with nothing to report they cost the same', (() => {
  const q = fresh();
  run(q, 'build [xyz]');
  return visitsOf(q, 'count aaaaa') === visitsOf(q, 'search aaaaa');
})(), 'z is zero, so O(n + z) is O(n)');

/* ── 4b. The trie is built in the open ─────────────────────────────── */

console.log('');
console.log('the log of the construction');

function buildLog(line: string): readonly SimEvent[] {
  const parsed = parseCommand(line, plugin.commands);
  if (!parsed.ok) return [];
  const r = fresh().execute(parsed.command);
  return r.ok ? r.events : [];
}

check('a state is drawn before it is known to finish a word', (() => {
  /*
   * The thing that used to be impossible. Reading "he" letter by letter, the
   * state for "he" is allocated when the e arrives and only becomes the end of
   * a word once the word is finished - so at some step of the replay it is an
   * ordinary state, and at a later one it is not.
   */
  const log = buildLog('build [he she his hers]');
  const line = new Timeline();
  line.append(log);

  const roleAt = (step: number): string | undefined => {
    for (const [, node] of line.stateAt(step).nodes) {
      if (node.slot === 'ce' && node.value === 2) return node.role;
    }
    return undefined;
  };

  let sawInner = false;
  let sawWord = false;
  for (let step = 0; step <= line.length; step += 1) {
    const role = roleAt(step);
    if (role === 'inner') sawInner = true;
    if (role === 'word' && sawInner) sawWord = true;
  }
  return sawInner && sawWord;
})(), 'the state for "he" is ordinary, then it is a word');

check('one such change per word, and never more', (() => {
  const log = buildLog('build [he she his hers]');
  // Two distinct words cannot end at the same state, so the count is exact.
  return log.filter((e) => e.kind === 'NodeUpdated').length === 4;
})(), '4 words, 4 states told to count as one');

check('the trie edges appear as the letters are read, not afterwards', (() => {
  /*
   * The first pointer must come before the last allocation - if the whole trie
   * were shaped and then drawn, every allocation would precede every pointer.
   */
  const log = buildLog('build [he she his hers]');
  const firstPointer = log.findIndex((e) => e.kind === 'PointerSet');
  const lastAllocation = log.reduce(
    (last, e, i) => (e.kind === 'NodeAllocated' ? i : last), -1,
  );
  return firstPointer >= 0 && firstPointer < lastAllocation;
})());

/* ── 5. Against KMP, one word at a time ────────────────────────────── */

console.log('\nagainst KMP');

check('one pass finds exactly what four passes of KMP find', (() => {
  const text = 'ushersheherhis';
  const q = fresh();
  run(q, `build [${words.join(' ')}]`);
  const mine = at(run(q, `search ${text}`), 'occurrences') as string[];
  const theirs = byKmp(text, words);
  return theirs !== null && JSON.stringify(mine) === JSON.stringify(theirs)
    && JSON.stringify(mine) === JSON.stringify(scan(text, words));
})(), 'ushersheherhis, all three ways');

/* ── 6. Refusing ───────────────────────────────────────────────────── */

console.log('\nerrors');

check('nothing can be searched before a build', (() => {
  const parsed = parseCommand('search abc', plugin.commands);
  if (!parsed.ok) return false;
  const r = fresh().execute(parsed.command);
  return !r.ok && r.error.code === 'PRECONDITION_FAILED';
})());
check('an empty list is refused before the plugin sees it', (() => {
  // The parser knows a list parameter cannot be empty, so the plugin needs no
  // check of its own - and a check it could never reach would be worse than
  // none, since nothing would notice if it were wrong.
  const parsed = parseCommand('build []', plugin.commands);
  return !parsed.ok && parsed.error.code === 'BAD_ARGUMENT'
    && parsed.error.message.includes('cannot be empty');
})());
check('a repeated word is refused, with the consequence spelled out',
  (run(fresh(), 'build [he she he]').error?.hint ?? '').includes('reported twice at every position'));
check('an over-long text is refused, with the limit', (() => {
  const q = fresh();
  run(q, 'build [ab]');
  return (run(q, `search ${'a'.repeat(5000)}`).error?.hint ?? '').includes('longest is');
})());
check('too many words is refused, with the limit', (() => {
  // Real words, so the limit is what refuses them rather than the parser -
  // a check that cannot reach the code it names is a check of nothing.
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const many = Array.from({ length: 65 }, (_, i) =>
    `${letters[Math.floor(i / 26)] as string}${letters[i % 26] as string}`);
  const r = run(fresh(), `build [${many.join(' ')}]`);
  return r.error?.code === 'BAD_ARGUMENT' && (r.error.hint ?? '').includes('the limit is 64');
})());

/* ── 7. Property test ──────────────────────────────────────────────── */

console.log('\nproperty test vs a scan, vs KMP, and vs the definition');

const rng = createRng(20_260_902);
let trials = 0;
let searches = 0;
let withOverlap = 0;
let firstFailure = '';

for (let t = 0; t < 60 && firstFailure === ''; t += 1) {
  const alphabet = rng.next() < 0.6 ? 'ab' : 'abc';
  const count = rng.nextInt(1, 6);
  const chosen = new Set<string>();
  for (let i = 0; i < count; i += 1) {
    const m = rng.nextInt(1, 5);
    let word = '';
    for (let k = 0; k < m; k += 1) word += alphabet[rng.nextInt(0, alphabet.length)] as string;
    chosen.add(word);
  }
  const set = [...chosen];

  const q = fresh();
  const build = `build [${set.join(' ')}]`;
  const b = run(q, build);
  if (b.error !== null) { firstFailure = `${build}: ${b.error.message}`; break; }
  trials += 1;

  // The links, against the definition, on every automaton and not only the
  // worked example.
  const read = readAutomaton(q.getStructure());
  if (typeof read === 'string') { firstFailure = `picture: ${read}`; break; }
  const prefixes = allPrefixes(set);
  for (const [id, s] of read.stringOf) {
    if (s === '') continue;
    const target = read.fail.get(id);
    const got = target === undefined ? '' : read.stringOf.get(target) as string;
    const want = longestUsableSuffix(s, prefixes);
    if (got !== want) {
      firstFailure = `"${s}" resumes at "${got}", the longest usable suffix is "${want}"`;
      break;
    }
    // And the output link, against its own definition.
    const outTarget = read.output.get(id);
    const outGot = outTarget === undefined ? null : read.stringOf.get(outTarget) as string;
    let outWant: string | null = null;
    for (let cut = 1; cut < s.length; cut += 1) {
      const tail = s.slice(cut);
      if (set.includes(tail)) { outWant = tail; break; }
    }
    if (outGot !== outWant) {
      firstFailure = `"${s}" outputs to ${String(outGot)}, the nearest whole word suffix is `
        + `${String(outWant)}`;
      break;
    }
  }
  if (firstFailure !== '') break;

  for (let s = 0; s < 3 && firstFailure === ''; s += 1) {
    const n = rng.nextInt(1, 22);
    let text = '';
    for (let i = 0; i < n; i += 1) text += alphabet[rng.nextInt(0, alphabet.length)] as string;

    const r = run(q, `search ${text}`);
    if (r.error !== null) { firstFailure = `search ${text}: ${r.error.message}`; break; }
    searches += 1;

    const got = at(r, 'occurrences') as string[];
    const want = scan(text, set);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      firstFailure = `[${set}] in "${text}" found [${got}], scanning gives [${want}]`;
      break;
    }
    if (want.length > set.length) withOverlap += 1;

    const theirs = byKmp(text, set);
    if (theirs === null || JSON.stringify(theirs) !== JSON.stringify(want)) {
      firstFailure = `KMP disagrees on [${set}] in "${text}": [${String(theirs)}]`;
      break;
    }

    // Counting has to agree with listing, and cost one read per letter.
    const c = run(q, `count ${text}`);
    if (at(c, 'count') !== want.length || at(c, 'reads') !== text.length) {
      firstFailure = `count says ${at(c, 'count')} in ${at(c, 'reads')} reads, `
        + `there are ${want.length} in ${text.length} letters`;
      break;
    }
  }
}

check('occurrences match a scan and KMP, and every link matches its definition',
  firstFailure === '',
  firstFailure === ''
    ? `${trials} word sets, ${searches} searches, ${withOverlap} with more matches than words`
    : firstFailure);

/* ── 8. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build [he she his hers]', 'search ushers', 'count ushers', 'links']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
