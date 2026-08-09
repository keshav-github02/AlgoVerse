/**
 * Complexity parsing and curve fitting. Run directly:
 *
 *     node packages/core/src/complexity.check.ts
 */

import { GROWTH_CLASSES, classify, fitGrowth, parseComplexity, type Sample } from './complexity.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

/* ── Parsing ───────────────────────────────────────────────────────── */

console.log('\nparsing');

const cases: readonly [string, string | null][] = [
  ['O(1)', '1'],
  ['O(log n)', 'log n'],
  ['O(n)', 'n'],
  ['O(n log n)', 'n log n'],
  ['O(n^2)', 'n²'],
  ['O(n²)', 'n²'],
  ['O(log n) expected', 'log n'],
  ['O(log n) amortised', 'log n'],
  ['o(LOG N)', 'log n'],
  ['O( n  log  n )', 'n log n'],
  ['O(n * log n)', 'n log n'],
  ['O(E log V)', null],
  ['linear', null],
  ['', null],
];
for (const [input, expected] of cases) {
  const got = parseComplexity(input)?.label ?? null;
  check(`"${input}" reads as ${expected ?? 'nothing'}`, got === expected, got ?? 'null');
}

/* ── Fitting ───────────────────────────────────────────────────────── */

console.log('\nfitting');

const sizes = [8, 16, 32, 64, 128, 256];
const from = (f: (n: number) => number): Sample[] => sizes.map((n) => ({ n, cost: f(n) }));

check('a perfect logarithm fits log n exactly', (() => {
  const fit = fitGrowth(from((n) => 3 * Math.log2(n)), GROWTH_CLASSES[1] as never);
  return Math.abs(fit.rSquared - 1) < 1e-9 && Math.abs(fit.constant - 3) < 1e-9;
})());

check('a constant series fits O(1)', (() => {
  const fit = fitGrowth(from(() => 7), GROWTH_CLASSES[0] as never);
  return Math.abs(fit.rSquared - 1) < 1e-9 && Math.abs(fit.constant - 7) < 1e-9;
})());

check('a flat series with no variance still scores 1 when reproduced', (() => {
  const fit = fitGrowth(from(() => 5), GROWTH_CLASSES[0] as never);
  return fit.rSquared === 1;
})());
check('a flat series scores 0 against a curve that cannot reproduce it', (() => {
  const fit = fitGrowth(from(() => 5), GROWTH_CLASSES[2] as never);
  return fit.rSquared === 0;
})());

check('the fit has no intercept, so flat cannot pass for logarithmic', (() => {
  // With an intercept, a constant series fits any curve at scale zero.
  const fit = fitGrowth(from(() => 9), GROWTH_CLASSES[1] as never);
  return fit.rSquared < 0.9;
})(), `R² ${fitGrowth(from(() => 9), GROWTH_CLASSES[1] as never).rSquared.toFixed(3)}`);

check('r squared is never negative', (() => {
  const fit = fitGrowth(from((n) => 1000 / n), GROWTH_CLASSES[4] as never);
  return fit.rSquared >= 0;
})());
check('an empty sample set does not divide by zero', (() => {
  const fit = fitGrowth([], GROWTH_CLASSES[1] as never);
  return fit.constant === 0 && fit.rSquared === 0 && fit.predicted.length === 0;
})());

/* ── Classification ────────────────────────────────────────────────── */

console.log('\nclassification');

const bestOf = (f: (n: number) => number): string => classify(from(f))[0]?.growth.label ?? '?';
check('recognises constant', bestOf(() => 4) === '1', bestOf(() => 4));
check('recognises logarithmic', bestOf((n) => 2.5 * Math.log2(n)) === 'log n', bestOf((n) => 2.5 * Math.log2(n)));
check('recognises linear', bestOf((n) => 0.5 * n) === 'n', bestOf((n) => 0.5 * n));
check('recognises linearithmic', bestOf((n) => n * Math.log2(n)) === 'n log n', bestOf((n) => n * Math.log2(n)));
check('recognises quadratic', bestOf((n) => n * n) === 'n²', bestOf((n) => n * n));

check('tolerates noise around a logarithm', (() => {
  // A treap's depth wobbles; the class should still be recognisable.
  const noisy = sizes.map((n, i) => ({ n, cost: Math.log2(n) * (1 + (i % 3 === 0 ? 0.12 : -0.08)) }));
  return classify(noisy)[0]?.growth.label === 'log n';
})());

check('classification is ordered by fit', (() => {
  const ranked = classify(from((n) => 3 * Math.log2(n)));
  return ranked.every((f, i) => i === 0 || f.rSquared <= (ranked[i - 1]?.rSquared ?? 1));
})());

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
