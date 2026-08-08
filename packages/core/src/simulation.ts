/**
 * Saving and sharing.
 *
 * A saved simulation is the **list of commands**, not the structure they
 * produced. Replaying them rebuilds the state, the event log, the marks and the
 * timeline, so a loaded simulation can be scrubbed exactly like a fresh one.
 * Saving the structure instead would restore the final picture and throw away
 * the history - and would be a second source of truth free to drift from the
 * log.
 *
 * This is only sound because operations are deterministic: no wall-clock reads,
 * and randomness comes from a seed that travels in the file.
 *
 * The plugin's own `serialize()` is kept as a **digest**. After replaying, the
 * caller can compare it against the saved one; a mismatch means the plugin's
 * behaviour changed since the file was written, which is exactly the silent
 * failure a command-replay format is otherwise prone to.
 */

import type { OperationError } from './command.ts';

export const SIMULATION_SCHEMA = 1;

export interface SimulationFile {
  readonly schemaVersion: number;
  readonly pluginId: string;
  readonly seed: number;
  readonly commands: readonly string[];
  /** Hash of `instance.serialize()` at save time, or null if unknown. */
  readonly digest: string | null;
}

/**
 * FNV-1a over the serialised state. A hash, not the state itself: embedding
 * the structure made a four-command share link 3187 characters, and it grows
 * with the data rather than with the script. Eight hex digits is ample for
 * catching "this plugin no longer behaves as it did", which is not an
 * adversarial problem.
 */
export function digestOf(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Compact on-the-wire shape. Long keys would double the size of a share link. */
interface Wire {
  readonly v: number;
  readonly p: string;
  readonly s: number;
  readonly c: readonly string[];
  readonly d?: string;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string | null {
  try {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function encodeSimulation(file: SimulationFile): string {
  const wire: Wire = {
    v: file.schemaVersion,
    p: file.pluginId,
    s: file.seed,
    c: file.commands,
    ...(file.digest === null ? {} : { d: file.digest }),
  };
  return toBase64Url(JSON.stringify(wire));
}

function bad(message: string, hint: string): OperationError {
  return { code: 'PARSE_ERROR', message, hint };
}

export type DecodeResult =
  | { readonly ok: true; readonly file: SimulationFile }
  | { readonly ok: false; readonly error: OperationError };

export function decodeSimulation(encoded: string): DecodeResult {
  const json = fromBase64Url(encoded.trim());
  if (json === null) return { ok: false, error: bad('This is not a valid saved simulation.', 'the link may be truncated') };

  let wire: unknown;
  try {
    wire = JSON.parse(json);
  } catch {
    return { ok: false, error: bad('This saved simulation is corrupt.', 'the link may be truncated') };
  }

  if (typeof wire !== 'object' || wire === null) {
    return { ok: false, error: bad('This saved simulation is corrupt.', 'expected an object') };
  }
  const w = wire as Partial<Wire>;

  if (typeof w.v !== 'number') {
    return { ok: false, error: bad('This saved simulation has no version.', 'it may predate saving') };
  }
  if (w.v > SIMULATION_SCHEMA) {
    return {
      ok: false,
      error: {
        code: 'INCOMPATIBLE_SAVE',
        message: `This simulation was saved by a newer version (format ${w.v}, this build reads ${SIMULATION_SCHEMA}).`,
        hint: 'update AlgoVerse to open it',
      },
    };
  }
  if (typeof w.p !== 'string' || typeof w.s !== 'number' || !Array.isArray(w.c)
      || w.c.some((line) => typeof line !== 'string')) {
    return { ok: false, error: bad('This saved simulation is missing required fields.', 'it may be corrupt') };
  }

  return {
    ok: true,
    file: {
      schemaVersion: w.v,
      pluginId: w.p,
      seed: w.s,
      commands: w.c,
      digest: typeof w.d === 'string' ? w.d : null,
    },
  };
}
