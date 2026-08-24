/**
 * Conformance, the tree against the definition of a compressed suffix trie, and
 * its substring statistics against **both** other structures that hold the same
 * information - the suffix array and the suffix automaton.
 *
 *     node packages/plugins/suffix-tree/src/plugin.check.ts
 */

import {
  createRng, help, parseCommand,
  type NodeId, type OperationError, type StructureGraph,
} from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { suffixArray } from '@algoverse/plugin-suffix-array';
import { suffixAutomaton } from '@algoverse/plugin-suffix-automaton';
import { suffixTree as plugin } from './plugin.ts';

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

/* ── The definitions ───────────────────────────────────────────────── */

function allSubstrings(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length; i += 1) {
    for (let j = i + 1; j <= s.length; j += 1) out.add(s.slice(i, j));
  }
  return out;
}

function countIn(text: string, word: string): number {
  let n = 0;
  for (let i = 0; i + word.length <= text.length; i += 1) {
    if (text.slice(i, i + word.length) === word) n += 1;
  }
  return n;
}

function longestRepeat(s: string): number {
  let best = 0;
  for (const sub of allSubstrings(s)) {
    if (sub.length > best && countIn(s, sub) >= 2) best = sub.length;
  }
  return best;
}

/* ── The other two structures, asked the same things ───────────────── */

/** The suffix array: sorted suffixes and shared prefixes. */
function byArray(text: string): { distinct: number; repeat: number } | null {
  const inst = suffixArray.createInstance({ rng: createRng(1) });
  let distinct: number | null = null;
  for (const line of [`build ${text}`, 'lrs']) {
    const parsed = parseCommand(line, suffixArray.commands);
    if (!parsed.ok) return null;
    const r = inst.execute(parsed.command);
    if (!r.ok) return null;
    if (line.startsWith('build')) {
      distinct = (r.value as { distinctSubstrings: number }).distinctSubstrings;
    } else if (distinct !== null) {
      return { distinct, repeat: (r.value as { length: number }).length };
    }
  }
  return null;
}

/** The suffix automaton: merged position classes. */
class Automaton {
  readonly inst: PluginInstance;

  constructor(text: string) {
    this.inst = suffixAutomaton.createInstance({ rng: createRng(1) });
    this.ask(`build ${text}`, 'text');
  }

  ask(line: string, key: string): unknown {
    const parsed = parseCommand(line, suffixAutomaton.commands);
    if (!parsed.ok) return null;
    const r = this.inst.execute(parsed.command);
    if (!r.ok) return null;
    return (r.value as Record<string, unknown>)[key];
  }
}

/* ── Reading the tree off the picture ──────────────────────────────── */

/**
 * Whether the drawn tree really is the compressed trie of all the suffixes.
 *
 * Three claims, each checkable from the drawing alone: the strings spelled by
 * root-to-leaf paths are exactly the suffixes of the word with a terminator on
 * it; every branching node has at least two children, or the edge above it
 * should have been part of the one below; and no two edges from one node begin
 * with the same character, or the walk would have a choice to make.
 */
function treeProblem(g: StructureGraph, text: string): string {
  const label = new Map<NodeId, string>();
  const role = new Map<NodeId, string>();
  for (const n of g.nodes) {
    label.set(n.id, n.label);
    role.set(n.id, n.role);
  }
  const kids = new Map<NodeId, NodeId[]>();
  const links = new Map<NodeId, NodeId>();
  const hasParent = new Set<NodeId>();

  for (const e of g.edges) {
    if (e.slot === 'link') { links.set(e.from, e.to); continue; }
    if (!e.slot.startsWith('c')) return `unexpected slot "${e.slot}"`;
    if (hasParent.has(e.to)) return `node ${e.to} has two parents`;
    hasParent.add(e.to);
    const first = e.slot.slice(1);
    const own = label.get(e.to) ?? '';
    if (own[0] !== first) return `an edge keyed "${first}" spells "${own}"`;
    kids.set(e.from, [...(kids.get(e.from) ?? []), e.to]);
  }

  const root = g.roots[0];
  if (root === undefined) return 'no root';

  const spelled: string[] = [];
  let seen = 0;
  const walk = (id: NodeId, path: string): string => {
    seen += 1;
    const children = kids.get(id) ?? [];
    const firsts = new Set(children.map((c) => (label.get(c) ?? '')[0]));
    if (firsts.size !== children.length) return `two edges from one node begin alike`;

    if (children.length === 0) {
      if (role.get(id) !== 'suffix') return `a childless node is drawn as a ${String(role.get(id))}`;
      spelled.push(path);
      return '';
    }
    if (id !== root && children.length < 2) {
      return `a branch with one child: "${path}" should not be a node at all`;
    }
    for (const c of children) {
      const deeper = walk(c, `${path}${label.get(c) ?? ''}`);
      if (deeper !== '') return deeper;
    }
    return '';
  };

  const problem = walk(root, '');
  if (problem !== '') return problem;
  if (seen !== g.nodes.length) return `${seen} of ${g.nodes.length} nodes hang off the root`;

  const s = `${text}$`;
  const want = Array.from({ length: s.length }, (_, i) => s.slice(i)).sort();
  const got = spelled.slice().sort();
  if (got.join('|') !== want.join('|')) {
    return `the leaves spell [${got}], the suffixes are [${want}]`;
  }

  /*
   * And the suffix links, against their definition: dropping the first
   * character of a node's path lands on the node its link points at.
   */
  const byPath = new Map<string, NodeId>();
  const paths = new Map<NodeId, string>();
  const record = (id: NodeId, path: string): void => {
    byPath.set(path, id);
    paths.set(id, path);
    for (const c of kids.get(id) ?? []) record(c, `${path}${label.get(c) ?? ''}`);
  };
  record(root, '');
  for (const [from, to] of links) {
    const path = paths.get(from) ?? '';
    const shorter = path.slice(1);
    if (byPath.get(shorter) !== to) {
      return `"${path}" links to "${String(paths.get(to))}", dropping its first letter gives "${shorter}"`;
    }
  }
  return '';
}

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, [
  'build abcbc', 'contains bcb', 'occurrences bc', 'repeated', 'edges',
])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. A worked example ───────────────────────────────────────────── */

console.log('\nabcbc');

const inst = fresh();
const built = run(inst, 'build abcbc');

check('there is one leaf per suffix, terminator included', (() => {
  // abcbc$ has six suffixes, so six leaves.
  return at(built, 'leaves') === 6 && at(built, 'length') === 5;
})(), `${String(at(built, 'leaves'))} leaves for five letters`);

check('a branch appears exactly where two suffixes part company', (() => {
  /*
   * bc occurs at 1 and 3, and so does c. Each gives one branching node, and
   * nothing else in abcbc repeats - so two branches and two splits.
   */
  return at(built, 'branches') === 2 && at(built, 'splits') === 2;
})(), 'bc and c each repeat, so two branches');

check('the distinct substring count comes out of the edge lengths', (() => {
  return at(built, 'distinctSubstrings') === allSubstrings('abcbc').size;
})(), `${String(at(built, 'distinctSubstrings'))} substrings`);

check('membership walks whole edges at a time', (() => {
  return at(run(inst, 'contains bcb'), 'contains') === true
    && at(run(inst, 'contains bcbc'), 'contains') === true
    && at(run(inst, 'contains bb'), 'contains') === false
    && at(run(inst, 'contains abcbcb'), 'contains') === false;
})());

check('a miss says how far it got', (() => {
  const r = run(inst, 'contains cba');
  return at(r, 'contains') === false && at(r, 'matched') === 2;
})(), 'cb is there, cba is not');

check('occurrences are the leaves below the path', (() => {
  return at(run(inst, 'occurrences bc'), 'count') === 2
    && at(run(inst, 'occurrences c'), 'count') === 2
    && at(run(inst, 'occurrences a'), 'count') === 1
    && at(run(inst, 'occurrences abcbc'), 'count') === 1
    && at(run(inst, 'occurrences bb'), 'count') === 0;
})(), 'bc twice, a once, bb never');

check('the longest repeat is the deepest branch', (() => {
  const r = run(inst, 'repeated');
  return at(r, 'length') === 2 && at(r, 'substring') === 'bc' && at(r, 'occurrences') === 2;
})(), 'bc, and it is a branch because b-c-b and b-c-$ differ after it');

check('a word with no repeat has no branches at all', (() => {
  const q = fresh();
  const r = run(q, 'build abcd');
  return at(r, 'branches') === 0 && at(r, 'splits') === 0
    && at(run(q, 'repeated'), 'length') === 0
    && at(run(q, 'repeated'), 'substring') === null;
})(), 'every suffix leaves the root by a different letter');

check('one letter is the smallest tree', (() => {
  const q = fresh();
  const r = run(q, 'build a');
  // a$ and $: two leaves off the root.
  return at(r, 'leaves') === 2 && at(r, 'nodes') === 3
    && at(r, 'distinctSubstrings') === 1
    && at(run(q, 'occurrences a'), 'count') === 1;
})());

check('a word of one repeated letter is a chain of branches', (() => {
  const q = fresh();
  const r = run(q, 'build aaaa');
  /*
   * Every *proper* prefix of aaaa repeats, so a, aa and aaa each branch - three
   * of them, not four. aaaa itself occurs once and so is a leaf, which is the
   * same reason the longest repeat here is aaa rather than the whole word.
   */
  return at(r, 'leaves') === 5 && at(r, 'branches') === 3
    && at(r, 'distinctSubstrings') === 4
    && at(run(q, 'occurrences aa'), 'count') === 3
    && at(run(q, 'repeated'), 'length') === 3
    && at(run(q, 'repeated'), 'substring') === 'aaa';
})(), 'a, aa and aaa each branch; aaaa occurs once and is a leaf');

/* ── 3. The picture is the trie ────────────────────────────────────── */

console.log('\nthe drawn tree against what a suffix tree is');

check('the leaves spell the suffixes, branches really branch, links check out',
  treeProblem(inst.getStructure(), 'abcbc') === '',
  treeProblem(inst.getStructure(), 'abcbc') || 'all three claims, off the drawing');

check('and on words that stress the construction', (() => {
  for (const word of ['aaaa', 'abab', 'mississippi', 'abcabxabcd', 'banana']) {
    const q = fresh();
    run(q, `build ${word}`);
    const problem = treeProblem(q.getStructure(), word);
    if (problem !== '') return false;
  }
  return true;
})(), 'aaaa, abab, mississippi, abcabxabcd, banana');

/* ── 4. Against the other two ways of holding the same thing ───────── */

console.log('\nagainst the suffix array and the suffix automaton');

check('all three agree on the substring count and the longest repeat', (() => {
  for (const word of ['abcbc', 'banana', 'mississippi', 'aabaaab', 'abracadabra']) {
    const q = fresh();
    const b = run(q, `build ${word}`);
    const rep = run(q, 'repeated');
    const array = byArray(word);
    const automaton = new Automaton(word);
    if (array === null) return false;
    const want = allSubstrings(word).size;
    if (at(b, 'distinctSubstrings') !== want) return false;
    if (array.distinct !== want) return false;
    if (automaton.ask(`build ${word}`, 'distinctSubstrings') !== want) return false;
    const repeat = longestRepeat(word);
    if (at(rep, 'length') !== repeat) return false;
    if (array.repeat !== repeat) return false;
    if (automaton.ask('repeated', 'length') !== repeat) return false;
  }
  return true;
})(), 'five words, three structures, and enumeration as the referee');

check('the tree and the automaton count occurrences alike', (() => {
  const word = 'mississippi';
  const q = fresh();
  run(q, `build ${word}`);
  const automaton = new Automaton(word);
  for (const sub of ['i', 'is', 'ss', 'issi', 'ppi', 'x', 'sip']) {
    const mine = at(run(q, `occurrences ${sub}`), 'count');
    if (mine !== countIn(word, sub)) return false;
    if (automaton.ask(`occurrences ${sub}`, 'count') !== mine) return false;
  }
  return true;
})(), 'seven substrings of mississippi');

/* ── 5. Refusing ───────────────────────────────────────────────────── */

console.log('\nerrors');

check('nothing can be asked before a build', (() => {
  const parsed = parseCommand('repeated', plugin.commands);
  if (!parsed.ok) return false;
  const r = fresh().execute(parsed.command);
  return !r.ok && r.error.code === 'PRECONDITION_FAILED';
})());
check('an over-long word is refused, with the limit',
  (run(fresh(), `build ${'a'.repeat(2000)}`).error?.hint ?? '').includes('longest is'));

/* ── 6. Property test ──────────────────────────────────────────────── */

console.log('\nproperty test vs enumeration, and vs both neighbours');

const rng = createRng(20_260_906);
let trials = 0;
let queries = 0;
let branches = 0;
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
  branches += at(b, 'branches') as number;

  // The tree is a suffix tree, read off the drawing.
  const problem = treeProblem(q.getStructure(), text);
  if (problem !== '') { firstFailure = `"${text}" ${problem}`; break; }

  // One leaf per suffix of the word plus its terminator, always.
  if (at(b, 'leaves') !== n + 1) {
    firstFailure = `"${text}" has ${at(b, 'leaves')} leaves, it has ${n + 1} suffixes`;
    break;
  }

  const want = allSubstrings(text);
  if (at(b, 'distinctSubstrings') !== want.size) {
    firstFailure = `"${text}" says ${at(b, 'distinctSubstrings')} substrings, there are ${want.size}`;
    break;
  }

  const repeat = longestRepeat(text);
  const rep = run(q, 'repeated');
  if (at(rep, 'length') !== repeat) {
    firstFailure = `"${text}" longest repeat ${at(rep, 'length')}, trying all gives ${repeat}`;
    break;
  }
  const reported = at(rep, 'substring') as string | null;
  if (reported !== null && (reported.length !== repeat || countIn(text, reported) < 2)) {
    firstFailure = `"${text}" reported "${String(reported)}" as its longest repeat`;
    break;
  }

  // The other two structures, on the same word.
  const array = byArray(text);
  const automaton = new Automaton(text);
  if (array === null || array.distinct !== want.size || array.repeat !== repeat) {
    firstFailure = `the suffix array disagrees about "${text}": ${JSON.stringify(array)}`;
    break;
  }
  if (automaton.ask(`build ${text}`, 'distinctSubstrings') !== want.size
    || automaton.ask('repeated', 'length') !== repeat) {
    firstFailure = `the suffix automaton disagrees about "${text}"`;
    break;
  }

  for (let k = 0; k < 4 && firstFailure === ''; k += 1) {
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
      firstFailure = `"${word}" in "${text}" counted ${at(o, 'count')}, `
        + `scanning gives ${countIn(text, word)}`;
      break;
    }
    if (automaton.ask(`occurrences ${word}`, 'count') !== at(o, 'count')) {
      firstFailure = `the automaton counts "${word}" in "${text}" differently`;
      break;
    }
  }
}

check('the tree is a suffix tree, and all three structures agree about the word',
  firstFailure === '',
  firstFailure === ''
    ? `${trials} words, ${queries} queries, ${branches} branching nodes built`
    : firstFailure);

check('branches really were built, so splitting was exercised',
  branches > 100, `${branches} branching nodes`);

/* ── 7. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build abcbc', 'contains bcb', 'occurrences bc', 'repeated', 'edges']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
