/**
 * Quiz generation checks. Run directly:
 *
 *     node packages/core/src/quiz.check.ts
 */

import { createRng } from './rng.ts';
import { buildQuiz, candidates, isCorrect } from './quiz.ts';
import { Timeline, type NodeId, type SimEvent } from './timeline.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const id = (n: number): NodeId => n as NodeId;
const alloc = (n: number, value: number): SimEvent => ({
  kind: 'NodeAllocated', node: id(n), value, label: `n${n}`, role: 'x', slot: `s${n}`, origin: 0,
});
const visit = (n: number): SimEvent => ({ kind: 'NodeVisited', node: id(n) });

const tl = new Timeline();
tl.append([alloc(0, 10)], 'one');
tl.append([alloc(1, 20), alloc(2, 30)], 'two');
tl.append([visit(0), visit(2), { kind: 'NodeUpdated', node: id(2), value: 35 }], 'walk');
tl.append([{ kind: 'NodeUpdated', node: id(1), value: 20 }, visit(1)], 'restate');

const all = candidates(tl, createRng(1));

console.log('\nwhat gets asked');

check('every allocation is a value question',
  all.filter((q) => q.kind === 'next-value' && q.fresh).length === 3);
check('a visit is asked only when there is more than one node to choose from',
  all.filter((q) => q.kind === 'next-visit').length === 3);
check('a change of value is asked', all.some((q) => q.kind === 'next-value' && !q.fresh && q.answer === 35));
check('restating the same value is not', !all.some((q) => q.kind === 'next-value' && !q.fresh && q.answer === 20));
check('each question knows its operation',
  all.map((q) => q.operation).join(',') === 'one,two,two,walk,walk,walk,restate',
  all.map((q) => q.operation).join(','));
check('steps point at the event being asked about',
  all.every((q) => {
    const e = tl.eventAt(q.step);
    return q.kind === 'next-visit'
      ? e?.kind === 'NodeVisited' && e.node === q.answer
      : (e?.kind === 'NodeAllocated' || e?.kind === 'NodeUpdated') && e.value === q.answer;
  }));

console.log('\noptions');

const values = all.filter((q) => q.kind === 'next-value');
check('the answer is always an option',
  values.every((q) => q.kind === 'next-value' && q.options.includes(q.answer)));
check('there are always at least three options',
  values.every((q) => q.kind === 'next-value' && q.options.length >= 3));
check('options are distinct', values.every((q) => q.kind === 'next-value' && new Set(q.options).size === q.options.length));
check('options are sorted, so position gives nothing away',
  values.every((q) => q.kind === 'next-value' && q.options.every((o, i) => i === 0 || (q.options[i - 1] as number) < o)));
check('wrong answers come from what is on screen where possible', (() => {
  const q = values.find((v) => v.kind === 'next-value' && v.answer === 35);
  return q?.kind === 'next-value' && q.options.includes(10) && q.options.includes(20) && q.options.includes(30);
})());

console.log('\nselection');

const long = new Timeline();
long.append(Array.from({ length: 40 }, (_, i) => alloc(i, i)), 'build');
for (let k = 0; k < 10; k += 1) long.append([visit(k), visit(k + 10), visit(k + 20)], `walk ${k}`);
const quiz = buildQuiz(long, createRng(2), 9);
check('a quiz is capped at its limit', quiz.length === 9);
check('questions stay in log order', quiz.every((q, i) => i === 0 || (quiz[i - 1]?.step ?? 0) < q.step));
check('visits are preferred', quiz.filter((q) => q.kind === 'next-visit').length >= 6);
check('questions are spread over the log, not bunched at the start',
  new Set(quiz.map((q) => q.operation)).size >= 5, [...new Set(quiz.map((q) => q.operation))].join(' | '));
check('the same seed gives the same quiz',
  JSON.stringify(buildQuiz(long, createRng(2), 9)) === JSON.stringify(quiz));
check('a short log gives every question it has', buildQuiz(tl, createRng(1), 50).length === all.length);
check('an empty log gives no questions', buildQuiz(new Timeline(), createRng(1)).length === 0);

console.log('\ngrading');

const first = all[0];
check('the answer is correct', first !== undefined && isCorrect(first, first.answer));
check('anything else is not', first !== undefined && !isCorrect(first, first.answer + 1));

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
