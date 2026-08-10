/**
 * Conformance and property tests for the persistent trie.
 *
 *     node packages/plugins/persistent-trie/src/plugin.check.ts
 */

import { createRng, help, layout, parseCommand, type OperationError } from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { persistentTrie as plugin } from './plugin.ts';

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

const has = (inst: PluginInstance, v: number, word: string): boolean =>
  (run(inst, `contains v${v} ${word}`).value as { found: boolean }).found;
const countOf = (inst: PluginInstance, v: number, prefix: string): number =>
  (run(inst, `count v${v} ${prefix}`).value as { words: number }).words;

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, ['build [cat car card dog]', 'insert v0 care', 'contains v1 care'])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. Correctness ────────────────────────────────────────────────── */

console.log('\ncorrectness');

const inst = fresh();
run(inst, 'build [cat car card dog]');

check('every word is present', ['cat', 'car', 'card', 'dog'].every((w) => has(inst, 0, w)));
check('a prefix is not a word', !has(inst, 0, 'ca'), 'ca is a prefix of car, not stored');
check('an absent word is absent', !has(inst, 0, 'cot'));
check('prefix counts are right',
  countOf(inst, 0, 'ca') === 3 && countOf(inst, 0, 'car') === 2 && countOf(inst, 0, 'd') === 1,
  `ca=${countOf(inst, 0, 'ca')}, car=${countOf(inst, 0, 'car')}, d=${countOf(inst, 0, 'd')}`);
check('the empty-ish prefix counts everything', countOf(inst, 0, 'c') === 3);
check('an unknown prefix counts nothing', countOf(inst, 0, 'zzz') === 0);

run(inst, 'insert v0 care');
check('insert adds the word', has(inst, 1, 'care'));
check('the earlier version does not have it', !has(inst, 0, 'care'));
check('counts update in the new version only',
  countOf(inst, 1, 'car') === 3 && countOf(inst, 0, 'car') === 2);
check('a duplicate insert is refused',
  run(inst, 'insert v0 cat').error?.code === 'PRECONDITION_FAILED');
check('inserting a prefix of an existing word works', (() => {
  const p = fresh();
  run(p, 'build [card]');
  run(p, 'insert v0 car');
  return has(p, 1, 'car') && has(p, 1, 'card') && !has(p, 0, 'car');
})());
check('an unknown version is refused with the list',
  (run(inst, 'contains v9 cat').error?.hint ?? '').includes('v0'));

/* ── 3. Sharing ────────────────────────────────────────────────────── */

console.log('\nsharing');

check('prefixes are shared between words', (() => {
  const p = fresh();
  // cat, car, card share "ca"; a trie storing each separately would need more.
  const r = run(p, 'build [cat car card]').value as { nodes: number };
  return r.nodes < 'cat'.length + 'car'.length + 'card'.length + 1;
})(), (() => {
  const p = fresh();
  const r = run(p, 'build [cat car card]').value as { nodes: number };
  return `${r.nodes} nodes for 10 letters`;
})());

check('an insert allocates one node per letter plus the root', (() => {
  const p = fresh();
  run(p, 'build [cat]');
  const r = run(p, 'insert v0 dog').value as { allocated: number };
  return r.allocated === 4;
})(), 'd, o, g and a new root');

check('compare reports real reuse', (() => {
  const p = fresh();
  run(p, 'build [cat car card dog]');
  run(p, 'insert v0 care');
  const r = run(p, 'compare v0 v1').value as { sharedPercent: number };
  return r.sharedPercent > 30 && r.sharedPercent < 100;
})(), (() => {
  const p = fresh();
  run(p, 'build [cat car card dog]');
  run(p, 'insert v0 care');
  return `${(run(p, 'compare v0 v1').value as { sharedPercent: number }).sharedPercent}% of v1 reused`;
})());

/* ── 4. Many children, which nothing before this had ───────────────── */

console.log('\nfan-out');

const wide = fresh();
run(wide, `build [${'abcdefghijklmnopqrstuvwxyz'.split('').map((c) => `${c}x`).join(' ')}]`);

check('the root has twenty-six children', (() => {
  const g = wide.getStructure();
  const root = g.roots[0];
  return g.edges.filter((e) => e.from === root).length === 26;
})());

check('children are laid out in alphabetical order', (() => {
  const scene = layout(wide.getStructure());
  const firstLetters = scene.nodes
    .filter((n) => n.node.slot.length === 3 && n.node.slot.startsWith('p:'))
    .sort((a, b) => a.x - b.x)
    .map((n) => n.node.slot.slice(2));
  return firstLetters.join('') === 'abcdefghijklmnopqrstuvwxyz';
})(), 'a to z, left to right');

check('no two nodes overlap on a row', (() => {
  const scene = layout(wide.getStructure());
  const rows = new Map<number, { x: number; width: number }[]>();
  for (const n of scene.nodes) rows.set(n.y, [...(rows.get(n.y) ?? []), { x: n.x, width: n.width }]);
  for (const row of rows.values()) {
    const sorted = [...row].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i += 1) {
      const a = sorted[i - 1] as { x: number; width: number };
      const b = sorted[i] as { x: number; width: number };
      if (b.x - a.x < (a.width + b.width) / 2) return false;
    }
  }
  return true;
})(), `${Math.round(layout(wide.getStructure()).width)}px wide`);

/* ── 5. Property test against a plain set ──────────────────────────── */

console.log('\nproperty test vs a plain set');

const rng = createRng(20_260_810);
const letters = 'abcd';
const randomWord = (): string =>
  Array.from({ length: rng.nextInt(1, 5) }, () => letters[rng.nextInt(0, letters.length)] as string).join('');

let trials = 0;
let queries = 0;
let firstFailure = '';

for (let t = 0; t < 25 && firstFailure === ''; t += 1) {
  const p = fresh();
  const start = [...new Set(Array.from({ length: rng.nextInt(1, 6) }, randomWord))];
  run(p, `build [${start.join(' ')}]`);
  const models: string[][] = [[...start]];
  trials += 1;

  for (let op = 0; op < 6 && firstFailure === ''; op += 1) {
    const from = rng.nextInt(0, models.length);
    const model = models[from] as string[];
    const word = randomWord();

    if (model.includes(word)) {
      if (run(p, `insert v${from} ${word}`).error?.code !== 'PRECONDITION_FAILED') {
        firstFailure = `re-inserting "${word}" should have been refused`;
      }
      continue;
    }
    if (run(p, `insert v${from} ${word}`).error !== null) { firstFailure = 'unexpected error'; break; }
    models.push([...model, word]);

    // Every version must hold exactly its own words, and count prefixes right.
    for (let v = 0; v < models.length && firstFailure === ''; v += 1) {
      const expected = (models[v] as string[]).slice().sort();
      for (const w of expected) {
        queries += 1;
        if (!has(p, v, w)) { firstFailure = `v${v} lost "${w}"`; break; }
      }
      for (const prefix of ['a', 'b', 'ab', 'cd', 'dddd']) {
        queries += 1;
        const want = expected.filter((w) => w.startsWith(prefix)).length;
        if (countOf(p, v, prefix) !== want) {
          firstFailure = `v${v} count "${prefix}": got ${countOf(p, v, prefix)}, expected ${want}`;
          break;
        }
      }
    }
  }
}

check('every version holds exactly its own words', firstFailure === '',
  firstFailure === '' ? `${trials} trials, ${queries} queries` : firstFailure);

/* ── 6. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['build [cat car card dog]', 'count v0 ca', 'insert v0 care', 'contains v1 care', 'compare v0 v1']) {
  const r = run(session, line);
  const out = r.error === null ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
