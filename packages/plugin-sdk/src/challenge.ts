/**
 * Challenges: here is a picture, now make it.
 *
 * A plugin declares a target as the commands that build it, and the player
 * sees only the result. They win by reaching the same shape - compared with
 * identities removed, so any route there counts - within a budget of commands.
 *
 * The target is a script rather than a stored structure for the same reason a
 * saved simulation is: a script cannot drift out of step with the plugin that
 * runs it, and the conformance kit can prove every target still builds.
 *
 * The interesting challenges are the ones where reading the picture does not
 * give the answer away. A binary search tree shows its keys but hides the
 * order they went in; a balanced tree hides it twice over.
 */

import { createRng, parseCommand, shapeOf, type OperationError } from '@algoverse/core';
import type { AlgorithmPlugin, StructureGraph } from './contract.ts';

export interface Challenge {
  /** Stable, so a solved challenge stays solved across releases. */
  readonly id: string;
  readonly title: string;
  /** What to do and what to notice, without the answer. */
  readonly brief: string;
  /** Commands that build the target. Never shown to the player. */
  readonly target: readonly string[];
  /** Successful commands allowed. Defaults to the length of the target. */
  readonly budget?: number;
}

/** The seed every challenge is built and played with, so randomised plugins agree with themselves. */
export const CHALLENGE_SEED = 1;

export function budgetOf(challenge: Challenge): number {
  return challenge.budget ?? challenge.target.length;
}

/** The structure the player is aiming for, or why it could not be built. */
export function targetOf(
  plugin: AlgorithmPlugin,
  challenge: Challenge,
): { ok: true; structure: StructureGraph } | { ok: false; error: OperationError; line: string } {
  const inst = plugin.createInstance({ rng: createRng(CHALLENGE_SEED) });
  for (const line of challenge.target) {
    const parsed = parseCommand(line, plugin.commands);
    if (!parsed.ok) return { ok: false, error: parsed.error, line };
    const r = inst.execute(parsed.command);
    if (!r.ok) return { ok: false, error: r.error, line };
  }
  return { ok: true, structure: inst.getStructure() };
}

export type Verdict =
  | { readonly state: 'solved'; readonly used: number }
  | { readonly state: 'playing'; readonly used: number; readonly left: number }
  | { readonly state: 'out-of-moves'; readonly used: number };

/**
 * Where the player stands. Matching the target over budget does not count:
 * spending commands freely is the one thing a budget exists to stop.
 */
export function judge(target: StructureGraph, current: StructureGraph, used: number, budget: number): Verdict {
  if (used <= budget && shapeOf(current) === shapeOf(target)) return { state: 'solved', used };
  if (used >= budget) return { state: 'out-of-moves', used };
  return { state: 'playing', used, left: budget - used };
}
