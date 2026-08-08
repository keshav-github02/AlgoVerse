/**
 * Seeded randomness.
 *
 * Plugins draw from this, never from Math.random(). A randomised structure
 * (treap, skip list) that reads the global RNG replays differently from the
 * run its author saw, which breaks shared links and makes bugs unrepeatable.
 */

export interface Rng {
  readonly seed: number;
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [lo, hi). */
  nextInt(lo: number, hi: number): number;
}

/** mulberry32 - small, fast, and good enough for layout and structure decisions. */
export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    seed,
    next,
    nextInt: (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo)),
  };
}
