/**
 * Running a plugin's benchmark and comparing the result to what it claims.
 *
 * Kept out of the component so it can be checked without a browser, and so the
 * question "does this structure behave the way it says" has an answer that does
 * not depend on anything being rendered.
 */

import {
  classify, fitGrowth, parseComplexity,
  type Fit, type Growth, type Sample,
} from '@algoverse/core';
import { runBenchmark, type AlgorithmPlugin, type Measurement } from '@algoverse/plugin-sdk';

export interface ComplexityReport {
  readonly command: string;
  readonly declared: string | null;
  readonly declaredGrowth: Growth | null;
  /** How well the declared curve explains the measurements. */
  readonly declaredFit: Fit | null;
  /** The class the numbers actually look like, whatever was declared. */
  readonly bestFit: Fit;
  readonly measurements: readonly Measurement[];
  readonly samples: readonly Sample[];
  /** True when the best-fitting class is the one declared. */
  readonly agrees: boolean;
}

/** Cost is nodes touched; for a command that only allocates, nodes allocated. */
function costOf(m: Measurement): number {
  return m.visits > 0 ? m.visits : m.allocations;
}

export interface Box {
  readonly width: number;
  readonly height: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface Geometry {
  readonly ticks: readonly number[];
  /** Pixel centres of each sample, in order. */
  readonly measured: readonly { readonly x: number; readonly y: number }[];
  readonly predicted: readonly { readonly x: number; readonly y: number }[];
  readonly xOf: (index: number) => number;
  readonly yOf: (cost: number) => number;
}

/**
 * Round tick steps, so the axis reads 0/5/10 rather than 0/4.7/9.4.
 *
 * The loop runs until a tick reaches the peak, never stopping just below it:
 * an axis topping out under its own data draws points above the plot area.
 */
function niceTicks(max: number): number[] {
  const raw = Math.max(max, 1) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? magnitude * 10;
  const out: number[] = [];
  for (let v = 0; ; v += step) {
    out.push(v);
    if (v >= max - 1e-9 || out.length > 32) break;
  }
  return out;
}

/**
 * Sample positions are spaced evenly by index, and the sizes double, so the x
 * axis is logarithmic. That is what makes a logarithmic cost draw as a straight
 * line instead of a curve the reader has to judge by eye.
 */
export function chartGeometry(report: ComplexityReport, box: Box): Geometry {
  const plotW = box.width - box.left - box.right;
  const plotH = box.height - box.top - box.bottom;
  const { samples } = report;
  const predictedValues = report.declaredFit?.predicted ?? [];

  const peak = Math.max(...samples.map((s) => s.cost), ...predictedValues, 1);
  const ticks = niceTicks(peak);
  const top = ticks[ticks.length - 1] as number;

  const xOf = (i: number): number =>
    box.left + (samples.length <= 1 ? plotW / 2 : (i * plotW) / (samples.length - 1));
  const yOf = (cost: number): number => box.top + plotH - (cost / Math.max(1, top)) * plotH;

  return {
    ticks,
    xOf,
    yOf,
    measured: samples.map((s, i) => ({ x: xOf(i), y: yOf(s.cost) })),
    predicted: predictedValues.map((v, i) => ({ x: xOf(i), y: yOf(v) })),
  };
}

export function measurePlugin(plugin: AlgorithmPlugin, seed = 1): ComplexityReport | null {
  const result = runBenchmark(plugin, seed);
  if (result === null || result.measurements.length < 3) return null;

  const samples: Sample[] = result.measurements.map((m) => ({ n: m.n, cost: costOf(m) }));
  const declaredGrowth = result.declared === null ? null : parseComplexity(result.declared);
  const declaredFit = declaredGrowth === null ? null : fitGrowth(samples, declaredGrowth);
  const bestFit = classify(samples)[0] as Fit;

  return {
    command: result.command,
    declared: result.declared,
    declaredGrowth,
    declaredFit,
    bestFit,
    measurements: result.measurements,
    samples,
    agrees: declaredGrowth !== null && bestFit.growth.label === declaredGrowth.label,
  };
}
