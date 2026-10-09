/**
 * Challenge mode.
 *
 * The target is drawn; the commands that built it are not. The player types
 * their own, and the verdict compares shapes with identities removed - so any
 * route to the same picture counts. See plugin-sdk's `challenge.ts`.
 */

import { useMemo, type JSX } from 'react';
import { layout, type PositionedScene } from '@algoverse/core';
import {
  budgetOf, judge, targetOf,
  type AlgorithmPlugin, type Challenge, type StructureGraph, type Verdict,
} from '@algoverse/plugin-sdk';
import type { Session } from '../engine.ts';
import { Scene } from './Scene.tsx';

const BTN = 'rounded border border-[var(--line)] bg-[var(--bg)] px-2 py-1 font-mono text-[11px] ' +
  'text-[var(--text)] hover:border-[var(--faint)] focus-visible:outline focus-visible:outline-2 ' +
  'focus-visible:outline-[var(--accent)] disabled:opacity-35';

export interface ChallengeState {
  readonly challenge: Challenge;
  readonly target: StructureGraph | null;
  readonly picture: PositionedScene | null;
  readonly verdict: Verdict | null;
  readonly budget: number;
  /** Why the target could not be built, which would be a plugin bug. */
  readonly problem: string | null;
}

export function useChallenge(
  plugin: AlgorithmPlugin,
  id: string | null,
  session: Session,
): ChallengeState | null {
  const challenge = plugin.challenges?.find((c) => c.id === id);
  const built = useMemo(
    () => (challenge === undefined ? null : targetOf(plugin, challenge)),
    [plugin, challenge],
  );
  if (challenge === undefined || built === null) return null;
  if (!built.ok) {
    return {
      challenge, target: null, picture: null, verdict: null, budget: budgetOf(challenge),
      problem: `"${built.line}" fails: ${built.error.message}`,
    };
  }
  const budget = budgetOf(challenge);
  return {
    challenge,
    target: built.structure,
    picture: layout(built.structure),
    verdict: judge(built.structure, session.structure(), session.script.length, budget),
    budget,
    problem: null,
  };
}

/** The target, drawn read-only above the player's own canvas. */
export function TargetPicture({ state, showLabels }: {
  readonly state: ChallengeState;
  readonly showLabels: boolean;
}): JSX.Element {
  if (state.picture === null) {
    return <p className="text-xs text-[var(--bad)]">{state.problem}</p>;
  }
  return (
    <Scene
      scene={state.picture} visited={[]} selected={null} showLabels={showLabels}
      onSelect={() => undefined}
    />
  );
}

export function ChallengePanel({ plugin, state, solved, onPick, onRetry }: {
  readonly plugin: AlgorithmPlugin;
  readonly state: ChallengeState | null;
  readonly solved: ReadonlySet<string>;
  readonly onPick: (id: string) => void;
  readonly onRetry: () => void;
}): JSX.Element {
  const list = plugin.challenges ?? [];
  const v = state?.verdict ?? null;

  return (
    <div className="flex flex-col gap-3 text-xs">
      {state !== null && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold">{state.challenge.title}</p>
          <p className="leading-relaxed text-[var(--dim)]">{state.challenge.brief}</p>
          {v !== null && (
            <p
              role="status"
              className={`font-mono text-[11px] ${
                v.state === 'solved' ? 'text-[var(--good)]'
                  : v.state === 'out-of-moves' ? 'text-[var(--bad)]' : 'text-[var(--text)]'}`}
            >
              {v.state === 'solved'
                ? `Solved in ${v.used} of ${state.budget} command${state.budget === 1 ? '' : 's'}.`
                : v.state === 'out-of-moves'
                ? `Out of commands - ${v.used} used, and the shapes still differ.`
                : `${v.used} of ${state.budget} command${state.budget === 1 ? '' : 's'} used. ` +
                  'Type below the canvas.'}
            </p>
          )}
          {v !== null && v.state !== 'playing' && (
            <button className={`${BTN} self-start`} onClick={onRetry}>
              {v.state === 'solved' ? 'play again' : 'retry'}
            </button>
          )}
        </div>
      )}

      <ul className="flex flex-col gap-1 border-t border-[var(--line)] pt-2">
        {list.map((c) => {
          const done = solved.has(`${plugin.meta.id}/${c.id}`);
          return (
            <li key={c.id}>
              <button
                onClick={() => onPick(c.id)}
                className={`flex w-full items-baseline gap-2 rounded px-2 py-1 text-left ${
                  c.id === state?.challenge.id
                    ? 'bg-[var(--bg)] font-medium text-[var(--text)]'
                    : 'text-[var(--dim)] hover:bg-[var(--bg)]'}`}
              >
                <span className="flex-1">{c.title}</span>
                <span className="font-mono text-[10px] text-[var(--faint)]">
                  {done ? 'solved' : `${budgetOf(c)} cmd${budgetOf(c) === 1 ? '' : 's'}`}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
