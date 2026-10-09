/**
 * Questions, from the event log.
 *
 * A quiz stops the playback just before an event and asks what it will be.
 * Everything is derived from the log and the state in front of it, so every
 * structure gets a quiz without its plugin writing one - the same reason the
 * console never needed a plugin to describe its own grammar.
 *
 * Only two kinds of question are asked, because they are the two a learner
 * can actually reason towards from the picture:
 *
 * - **Which node does the algorithm look at next?** Answered by clicking it.
 *   A traversal is the algorithm's decision made visible.
 * - **What value is about to be written?** Multiple choice, with the other
 *   values on screen as the wrong answers - plausible because they are there.
 *
 * Allocations of a value nobody could predict from the picture still qualify:
 * the answer is in the command that was typed, which is on screen too.
 */

import type { Rng } from './rng.ts';
import type { Mark, NodeId, SceneState, SimEvent } from './timeline.ts';
import { EMPTY_SCENE, reduce } from './timeline.ts';

export type Question =
  | {
      readonly kind: 'next-visit';
      /** Index of the event being asked about. The state shown is the one before it. */
      readonly step: number;
      /** The operation it belongs to, as typed. */
      readonly operation: string;
      readonly answer: NodeId;
    }
  | {
      readonly kind: 'next-value';
      readonly step: number;
      readonly operation: string;
      /** The node being written, or allocated. */
      readonly node: NodeId;
      /** Whether the node is new, so the prompt can say "created" or "changes". */
      readonly fresh: boolean;
      readonly answer: number;
      /** Always contains the answer, in ascending order so position gives nothing away. */
      readonly options: readonly number[];
    };

export interface QuizSource {
  readonly length: number;
  readonly marks: readonly Mark[];
  eventAt(step: number): SimEvent | undefined;
}

const MAX_OPTIONS = 4;

function shuffle<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = rng.nextInt(0, i + 1);
    [items[i], items[j]] = [items[j] as T, items[i] as T];
  }
  return items;
}

function options(answer: number, state: SceneState, rng: Rng): number[] {
  const others = new Set<number>();
  for (const n of state.nodes.values()) if (n.value !== answer) others.add(n.value);
  const picked = shuffle([...others], rng).slice(0, MAX_OPTIONS - 1);
  // A structure with nothing else on screen still gets a choice, so a correct
  // answer is never just the only button.
  for (const near of [answer + 1, answer - 1, answer + 2]) {
    if (picked.length >= 2) break;
    if (!picked.includes(near)) picked.push(near);
  }
  return [answer, ...picked].sort((a, b) => a - b);
}

/** Every question the log could support, in order. */
export function candidates(source: QuizSource, rng: Rng): Question[] {
  const out: Question[] = [];
  let state = EMPTY_SCENE;
  let mark = 0;
  for (let step = 0; step < source.length; step += 1) {
    const event = source.eventAt(step) as SimEvent;
    while (mark < source.marks.length && step >= (source.marks[mark] as Mark).index) mark += 1;
    const operation = source.marks[mark]?.label ?? '';

    if (event.kind === 'NodeVisited') {
      // Asking which of one node comes next is not a question.
      if (state.nodes.has(event.node) && state.nodes.size >= 2) {
        out.push({ kind: 'next-visit', step, operation, answer: event.node });
      }
    } else if (event.kind === 'NodeAllocated') {
      out.push({
        kind: 'next-value', step, operation, node: event.node, fresh: true,
        answer: event.value, options: options(event.value, state, rng),
      });
    } else if (event.kind === 'NodeUpdated' && event.value !== undefined) {
      const before = state.nodes.get(event.node);
      // A restatement of the same value has no right answer worth finding.
      if (before !== undefined && before.value !== event.value) {
        out.push({
          kind: 'next-value', step, operation, node: event.node, fresh: false,
          answer: event.value, options: options(event.value, state, rng),
        });
      }
    }
    state = reduce(state, event);
  }
  return out;
}

/**
 * At most `limit` questions, spread across the whole log rather than bunched
 * at the start - the first operation is usually a build, and a quiz made only
 * of build questions misses everything the user came to watch.
 *
 * Visits are preferred two to one where both are available, because a visit is
 * the algorithm choosing, and a value is more often the algorithm copying.
 */
export function buildQuiz(source: QuizSource, rng: Rng, limit = 10): Question[] {
  const all = candidates(source, rng);
  if (all.length <= limit) return all;
  const visits = all.filter((q) => q.kind === 'next-visit');
  const values = all.filter((q) => q.kind === 'next-value');
  const wantVisits = Math.min(visits.length, Math.max(limit - values.length, Math.ceil((limit * 2) / 3)));
  const spread = (from: Question[], n: number): Question[] =>
    n <= 0 ? [] : Array.from({ length: n }, (_, i) => from[Math.floor((i * from.length) / n)] as Question);
  return [...spread(visits, wantVisits), ...spread(values, limit - wantVisits)]
    .sort((a, b) => a.step - b.step);
}

/** A node id for a visit question, a value for a value question. */
export function isCorrect(q: Question, given: number): boolean {
  return given === q.answer;
}
