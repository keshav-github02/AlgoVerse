/**
 * Checks that the console's grammar comes entirely from specs. Run directly:
 *
 *     node packages/core/src/command.check.ts
 *
 * The two spec sets below are fixtures. They move into their plugin packages
 * once the plugin contract lands.
 */

import {
  complete, getInt, getIntList, getVersion, getWord, getWordList, help, parseCommand, usage,
  type CommandSpec, type OperationError,
} from './command.ts';

/* ── Fixture A: persistent segment tree ────────────────────────────── */

const SEGMENT_TREE: readonly CommandSpec[] = [
  { name: 'build', summary: 'Create version 0 from an array.', complexity: 'O(n)',
    params: [{ name: 'values', kind: 'int-list' }] },
  { name: 'update', summary: 'Write a value, producing a new version.', complexity: 'O(log n)',
    params: [{ name: 'version', kind: 'version' }, { name: 'index', kind: 'int' }, { name: 'value', kind: 'int' }] },
  { name: 'query', summary: 'Sum a half-open range in a version.', complexity: 'O(log n)',
    params: [{ name: 'version', kind: 'version' }, { name: 'lo', kind: 'int' }, { name: 'hi', kind: 'int' }] },
  { name: 'compare', summary: 'Diff two versions.', complexity: 'O(log n)',
    params: [{ name: 'a', kind: 'version' }, { name: 'b', kind: 'version' }] },
];

/* ── Fixture B: an unrelated algorithm, same parser ────────────────── */

const GRAPH: readonly CommandSpec[] = [
  { name: 'dijkstra', summary: 'Shortest paths from a source.', complexity: 'O(E log V)',
    params: [{ name: 'source', kind: 'int' }] },
  { name: 'bfs', summary: 'Breadth-first traversal.', complexity: 'O(V + E)',
    params: [{ name: 'source', kind: 'int' }] },
];

/* ── Harness ───────────────────────────────────────────────────────── */

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const render = (input: string, e: OperationError): string => {
  const [s, t] = e.span ?? [input.length, input.length];
  const caret = `${' '.repeat(s)}${'^'.repeat(Math.max(1, t - s))}`;
  return `      ${input}\n      ${caret}\n      ${e.code}: ${e.message}\n      hint: ${e.hint ?? '-'}`;
};

/* ── 1. Valid input ────────────────────────────────────────────────── */

console.log('\nvalid input');

const built = parseCommand('build [3 1 4 1 5 9 2 6]', SEGMENT_TREE);
check('build parses an int-list',
  built.ok && String(getIntList(built.command, 'values')) === String([3, 1, 4, 1, 5, 9, 2, 6]),
  built.ok ? `${getIntList(built.command, 'values').length} values` : '');

const upd = parseCommand('update v0 3 10', SEGMENT_TREE);
check('update binds version + two ints',
  upd.ok && getVersion(upd.command, 'version') === 0 && getInt(upd.command, 'index') === 3
    && getInt(upd.command, 'value') === 10);

const qry = parseCommand('query v1 2 5', SEGMENT_TREE);
check('query binds by param name',
  qry.ok && getVersion(qry.command, 'version') === 1 && getInt(qry.command, 'lo') === 2
    && getInt(qry.command, 'hi') === 5);

const cmp = parseCommand('compare v0 v1', SEGMENT_TREE);
check('compare takes two versions',
  cmp.ok && getVersion(cmp.command, 'a') === 0 && getVersion(cmp.command, 'b') === 1);

check('whitespace and commas are tolerated',
  (() => { const r = parseCommand('  build   [1, 2,  3]  ', SEGMENT_TREE);
    return r.ok && String(getIntList(r.command, 'values')) === String([1, 2, 3]); })());

check('negative integers parse',
  (() => { const r = parseCommand('update v0 1 -7', SEGMENT_TREE);
    return r.ok && getInt(r.command, 'value') === -7; })());

/* ── 1b. Text arguments ────────────────────────────────────────────── */

console.log('\ntext arguments');

const TEXT: readonly CommandSpec[] = [
  { name: 'insert', summary: 'Add a word.', complexity: 'O(len)',
    params: [{ name: 'version', kind: 'version' }, { name: 'word', kind: 'word' }] },
  { name: 'load', summary: 'Add several words.', complexity: 'O(total)',
    params: [{ name: 'words', kind: 'word-list' }] },
];

check('a word argument parses', (() => {
  const r = parseCommand('insert v0 cat', TEXT);
  return r.ok && getWord(r.command, 'word') === 'cat';
})());
check('words are lower-cased, so CAT and cat are one key', (() => {
  const r = parseCommand('insert v0 CaT', TEXT);
  return r.ok && getWord(r.command, 'word') === 'cat';
})());
check('a word list parses', (() => {
  const r = parseCommand('load [cat car dog]', TEXT);
  return r.ok && String(getWordList(r.command, 'words')) === 'cat,car,dog';
})());
check('a word list tolerates commas', (() => {
  const r = parseCommand('load [cat, car,  dog]', TEXT);
  return r.ok && getWordList(r.command, 'words').length === 3;
})());
check('digits are not words',
  (() => { const r = parseCommand('insert v0 42', TEXT); return !r.ok && r.error.code === 'BAD_ARGUMENT'; })(),
  (() => { const r = parseCommand('insert v0 42', TEXT); return r.ok ? '' : r.error.message; })());
check('a word with punctuation is rejected',
  (() => { const r = parseCommand("insert v0 ca-t", TEXT); return !r.ok; })());
check('a number where a word list is expected is rejected',
  (() => { const r = parseCommand('load [cat 3]', TEXT); return !r.ok && r.error.code === 'BAD_ARGUMENT'; })());
check('an empty word list is rejected',
  (() => { const r = parseCommand('load []', TEXT); return !r.ok; })());
check('a word list renders as brackets in usage',
  usage(TEXT[1] as CommandSpec) === 'load [words...]', usage(TEXT[1] as CommandSpec));
check('a word renders as an angle bracket in usage',
  usage(TEXT[0] as CommandSpec) === 'insert <version> <word>', usage(TEXT[0] as CommandSpec));
check('int lists still reject words after the refactor',
  (() => { const r = parseCommand('build [1 cat]', SEGMENT_TREE); return !r.ok; })());

/* ── 2. Errors carry the right span ────────────────────────────────── */

console.log('\nerrors, with the span the console underlines');

const cases: readonly {
  readonly label: string; readonly input: string;
  readonly code: string; readonly underlines: string;
}[] = [
  { label: 'unknown command, suggests a fix', input: 'updat v0 3 10', code: 'UNKNOWN_COMMAND', underlines: 'updat' },
  { label: 'missing argument',                input: 'update v0 3',   code: 'BAD_ARITY',       underlines: '' },
  { label: 'extra argument',                  input: 'compare v0 v1 v2', code: 'BAD_ARITY',    underlines: 'v2' },
  { label: 'not a version reference',         input: 'update vx 3 10', code: 'BAD_ARGUMENT',   underlines: 'vx' },
  { label: 'not a whole number',              input: 'update v0 x 10', code: 'BAD_ARGUMENT',   underlines: 'x' },
  { label: 'bad element inside a list',       input: 'build [1 2 zz]', code: 'BAD_ARGUMENT',   underlines: 'zz' },
  { label: 'unclosed bracket',                input: 'build [1 2',     code: 'PARSE_ERROR',    underlines: '[' },
  { label: 'list where a version was wanted', input: 'update [1] 3 10', code: 'BAD_ARGUMENT',  underlines: '[' },
  { label: 'empty input',                     input: '',               code: 'PARSE_ERROR',    underlines: '' },
];

for (const c of cases) {
  const r = parseCommand(c.input, SEGMENT_TREE);
  if (r.ok) { check(c.label, false, 'parsed when it should have failed'); continue; }
  const [s, t] = r.error.span ?? [c.input.length, c.input.length];
  const slice = c.input.slice(s, t);
  check(c.label, r.error.code === c.code && slice === c.underlines,
    `${r.error.code} underlines "${slice}"`);
}

console.log('\nrendered as a console would show it:\n');
const demo = 'update v0 3';
const shown = parseCommand(demo, SEGMENT_TREE);
if (!shown.ok) console.log(render(demo, shown.error));
const demo2 = 'updat v0 3 10';
const shown2 = parseCommand(demo2, SEGMENT_TREE);
if (!shown2.ok) console.log(`\n${render(demo2, shown2.error)}`);

/* ── 3. Help, usage and completion are derived, not written ────────── */

console.log('\nderived presentation');

check('usage is built from params', usage(SEGMENT_TREE[1] as CommandSpec) === 'update <version> <index> <value>',
  usage(SEGMENT_TREE[1] as CommandSpec));
check('list params render as brackets', usage(SEGMENT_TREE[0] as CommandSpec) === 'build [values...]',
  usage(SEGMENT_TREE[0] as CommandSpec));
check('help covers every command', help(SEGMENT_TREE).length === SEGMENT_TREE.length);
check('help includes declared complexity', help(SEGMENT_TREE).every((l) => l.includes('O(')));
check('completion filters by prefix', String(complete('up', SEGMENT_TREE).candidates) === 'update');
check('completion offers all on empty input',
  complete('', SEGMENT_TREE).candidates.length === SEGMENT_TREE.length);
check('completion hints usage mid-command', complete('update v0 ', SEGMENT_TREE).hint === 'update <version> <index> <value>');

console.log('\nhelp output, generated from the specs:\n');
for (const line of help(SEGMENT_TREE)) console.log(`      ${line}`);

/* ── 4. The parser knows no command names ──────────────────────────── */

console.log('\nspec-agnostic');

const dij = parseCommand('dijkstra 4', GRAPH);
check('same parser handles an unrelated command set', dij.ok && getInt(dij.command, 'source') === 4);
check('segment-tree commands are unknown to the graph set',
  (() => { const r = parseCommand('update v0 3 10', GRAPH); return !r.ok && r.error.code === 'UNKNOWN_COMMAND'; })());
check('graph commands are unknown to the segment-tree set',
  (() => { const r = parseCommand('dijkstra 4', SEGMENT_TREE); return !r.ok && r.error.code === 'UNKNOWN_COMMAND'; })());
check('help is generated for the graph set too',
  help(GRAPH).length === 2 && (help(GRAPH)[0] as string).startsWith('dijkstra <source>'));

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
