/**
 * Declared complexity versus measured cost.
 *
 * A `CommandSpec` says `O(log n)`. The event log says how many nodes an
 * operation actually touched. This turns the first into a curve, fits the
 * second to it, and reports how well they agree - which is the difference
 * between being told a structure is logarithmic and watching it be.
 *
 * Nothing here knows what a plugin is; it takes numbers and returns numbers.
 */

export interface Growth {
  /** Normalised form, e.g. "log n". */
  readonly label: string;
  readonly of: (n: number) => number;
}

/** The classes worth distinguishing at the sizes a teaching tool can run. */
export const GROWTH_CLASSES: readonly Growth[] = [
  { label: '1', of: () => 1 },
  { label: 'log n', of: (n) => Math.log2(Math.max(2, n)) },
  // A path decomposed into O(log n) ranges, each searched in O(log n).
  { label: 'log² n', of: (n) => Math.log2(Math.max(2, n)) ** 2 },
  { label: 'n', of: (n) => n },
  { label: 'n log n', of: (n) => n * Math.log2(Math.max(2, n)) },
  { label: 'n²', of: (n) => n * n },
];

/**
 * Reads the inside of an `O(...)`, ignoring qualifiers like "expected" or
 * "amortised" - they describe when the bound holds, not its shape.
 */
export function parseComplexity(declared: string): Growth | null {
  const inside = /o\s*\(([^)]*)\)/i.exec(declared);
  if (inside === null) return null;
  // Collapse whitespace last: replacing "*" with a space is what creates the
  // runs that need collapsing.
  const body = (inside[1] ?? '')
    .toLowerCase()
    .replace(/\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  /**
   * The size variable's name carries no information: `O(len)`, `O(height)` and
   * `O(n)` are all linear in whatever is being varied, and the benchmark
   * decides what that is. Two distinct names mean two variables, which a
   * single-variable fit cannot describe - `O(E log V)` stays unreadable.
   */
  const withLog = body.replace(/\blg\b|\bln\b/g, 'log');
  const names = new Set((withLog.match(/[a-z]+/g) ?? []).filter((w) => w !== 'log'));
  if (names.size > 1) return null;

  const normalised = withLog
    .replace(/\^2|²/g, '^2')
    .replace(/[a-z]+/g, (w) => (w === 'log' ? 'log' : 'n'));

  switch (normalised) {
    case '1': return GROWTH_CLASSES[0] as Growth;
    case 'log n': return GROWTH_CLASSES[1] as Growth;
    case 'log^2 n': return GROWTH_CLASSES[2] as Growth;
    case 'n': return GROWTH_CLASSES[3] as Growth;
    case 'n log n': return GROWTH_CLASSES[4] as Growth;
    case 'n^2': return GROWTH_CLASSES[5] as Growth;
    default: return null;
  }
}

export interface Sample {
  readonly n: number;
  readonly cost: number;
}

export interface Fit {
  readonly growth: Growth;
  /** Scaling that best matches the curve to the measurements. */
  readonly constant: number;
  /** 1 is a perfect match; 0 is no better than guessing the mean. */
  readonly rSquared: number;
  readonly predicted: readonly number[];
}

/**
 * Least squares through the origin: the curve's shape is fixed, only its
 * scale is free. Fitting an intercept as well would let a flat line pass for
 * a logarithm at small sizes.
 */
export function fitGrowth(samples: readonly Sample[], growth: Growth): Fit {
  if (samples.length === 0) {
    return { growth, constant: 0, rSquared: 0, predicted: [] };
  }

  let numerator = 0;
  let denominator = 0;
  for (const s of samples) {
    const g = growth.of(s.n);
    numerator += g * s.cost;
    denominator += g * g;
  }
  const constant = denominator === 0 ? 0 : numerator / denominator;
  const predicted = samples.map((s) => constant * growth.of(s.n));

  const mean = samples.reduce((a, s) => a + s.cost, 0) / samples.length;
  let residual = 0;
  let total = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i] as Sample;
    residual += (s.cost - (predicted[i] as number)) ** 2;
    total += (s.cost - mean) ** 2;
  }

  // A flat measurement has no variance to explain, so the fit is judged purely
  // on whether it reproduces the values.
  const rSquared = total === 0
    ? (residual < 1e-9 ? 1 : 0)
    : Math.max(0, 1 - residual / total);

  return { growth, constant, rSquared, predicted };
}

/** Every class, best fit first. The winner is what the numbers actually look like. */
export function classify(samples: readonly Sample[]): readonly Fit[] {
  return GROWTH_CLASSES
    .map((g) => fitGrowth(samples, g))
    .sort((a, b) => b.rSquared - a.rSquared);
}
