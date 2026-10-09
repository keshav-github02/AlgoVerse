/**
 * Quiz mode.
 *
 * Playback stops just before an event and the question is what it will be.
 * Answering steps forward one event, so the explanation panel shows the
 * algorithm's own reason straight after the guess - which is the part worth
 * reading, right or wrong.
 *
 * The questions come from the log (see core's `quiz.ts`), so this component
 * knows nothing about any structure.
 */

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { isCorrect, type NodeId, type Question } from '@algoverse/core';
import type { Emphasis } from '@algoverse/renderer';
import type { Session } from '../engine.ts';

const LIMIT = 10;

export interface QuizRun {
  readonly questions: readonly Question[];
  readonly index: number;
  readonly question: Question | undefined;
  /** What was given for the current question, once answered. */
  readonly given: number | null;
  readonly score: number;
  readonly done: boolean;
  /** Node emphasis for the canvas: the answer, and a wrong guess, after answering. */
  readonly emphasis: ReadonlyMap<NodeId, Emphasis> | undefined;
  answer(value: number): void;
  next(): void;
  restart(): void;
}

export function useQuiz(session: Session, active: boolean): QuizRun {
  const [attempt, setAttempt] = useState(0);
  const [index, setIndex] = useState(0);
  const [given, setGiven] = useState<number | null>(null);
  const [score, setScore] = useState(0);

  // Running another command while quizzing changes the log, so the quiz is
  // rebuilt from the top rather than left pointing at steps that moved.
  const length = session.script.length;
  const questions = useMemo(
    () => (active ? session.quiz(LIMIT, attempt) : []),
    [session, active, attempt, length],
  );
  useEffect(() => {
    setIndex(0); setGiven(null); setScore(0);
  }, [questions]);

  const question = questions[index];
  const done = active && index >= questions.length;

  // The canvas shows the state just before the event being asked about.
  const { playback } = session;
  useEffect(() => {
    if (!active) return;
    playback.pause();
    if (question === undefined) { playback.last(); return; }
    playback.seek(given === null ? question.step : question.step + 1);
  }, [active, playback, question, given]);

  const answer = useCallback((value: number) => {
    if (question === undefined || given !== null) return;
    setGiven(value);
    if (isCorrect(question, value)) setScore((s) => s + 1);
  }, [question, given]);

  const next = useCallback(() => {
    setIndex((i) => i + 1);
    setGiven(null);
  }, []);

  const restart = useCallback(() => setAttempt((a) => a + 1), []);

  const emphasis = useMemo(() => {
    if (question === undefined || given === null) return undefined;
    const target = question.kind === 'next-visit' ? question.answer : question.node;
    const map = new Map<NodeId, Emphasis>([[target, 'primary']]);
    if (question.kind === 'next-visit' && given !== question.answer) map.set(given as NodeId, 'secondary');
    return map;
  }, [question, given]);

  return { questions, index, question, given, score, done, emphasis, answer, next, restart };
}

const BTN = 'rounded border border-[var(--line)] bg-[var(--bg)] px-2 py-1 font-mono text-[11px] ' +
  'text-[var(--text)] hover:border-[var(--faint)] focus-visible:outline focus-visible:outline-2 ' +
  'focus-visible:outline-[var(--accent)] disabled:opacity-35';

function prompt(q: Question, label: (id: NodeId) => string): string {
  if (q.kind === 'next-visit') return 'Which node does the algorithm look at next? Click it on the canvas.';
  return q.fresh
    ? 'A new node is about to be created. What value will it hold?'
    : `${label(q.node)} is about to change. What will it hold?`;
}

export function QuizPanel({ run, explanation, label }: {
  readonly run: QuizRun;
  readonly explanation: string;
  readonly label: (id: NodeId) => string;
}): JSX.Element {
  const { question, given } = run;

  if (run.questions.length === 0) {
    return (
      <p className="text-xs italic text-[var(--faint)]">
        Nothing to ask about yet. Run a few commands, then come back - the questions come from what
        the algorithm actually did.
      </p>
    );
  }

  if (run.done || question === undefined) {
    return (
      <div className="flex flex-col gap-2 text-xs">
        <p className="text-sm font-semibold tabular-nums">{run.score} / {run.questions.length}</p>
        <p className="text-[var(--dim)]">
          {run.score === run.questions.length
            ? 'Every one. You could have written the algorithm.'
            : 'Each question you missed is a step worth replaying with the explanation open.'}
        </p>
        <button className={`${BTN} self-start`} onClick={run.restart}>again</button>
      </div>
    );
  }

  const right = given !== null && given === question.answer;
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex justify-between font-mono text-[10px] text-[var(--faint)]">
        <span>question {run.index + 1}/{run.questions.length} · {question.operation}</span>
        <span className="tabular-nums">score {run.score}</span>
      </div>
      <p className="leading-relaxed text-[var(--text)]">{prompt(question, label)}</p>

      {question.kind === 'next-value' && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Answers">
          {question.options.map((o) => (
            <button
              key={o}
              className={`${BTN} tabular-nums ${
                given !== null && o === question.answer ? 'border-[var(--good)] text-[var(--good)]'
                  : given === o ? 'border-[var(--bad)] text-[var(--bad)]' : ''}`}
              disabled={given !== null}
              onClick={() => run.answer(o)}
            >{o}</button>
          ))}
        </div>
      )}

      {given !== null && (
        <>
          <p role="status" className={right ? 'text-[var(--good)]' : 'text-[var(--bad)]'}>
            {right ? 'Right.' : question.kind === 'next-visit'
              ? `Not that one - it was ${label(question.answer)}, outlined on the canvas.`
              : `Not quite - it was ${question.answer}.`}
          </p>
          <p className="leading-relaxed text-[var(--dim)]">{explanation}</p>
          <button className={`${BTN} self-start`} onClick={run.next} autoFocus>
            {run.index + 1 === run.questions.length ? 'finish' : 'next'}
          </button>
        </>
      )}
    </div>
  );
}
