/**
 * Measuring what an operation actually costs.
 *
 * The engine cannot know how to build a structure of size n, or which command
 * is worth timing, so a plugin says. Everything after that is generic: run the
 * setup, run the probes, count what the event log reports.
 *
 * Cost is counted in events, not seconds. A wall-clock measurement of a
 * teaching-sized structure measures the JIT; the number of nodes an operation
 * touches is the thing the complexity claim is actually about.
 */

import { createRng, parseCommand, type Rng } from '@algoverse/core';
import type { AlgorithmPlugin } from './contract.ts';

export interface Benchmark {
  /** Sizes to sample. Powers of two keep log-shaped costs clean. */
  readonly sizes: readonly number[];
  /** Commands that build a structure of this size. */
  setup(n: number): readonly string[];
  /** Commands whose average cost is measured. */
  probes(n: number): readonly string[];
  /** The command being measured, so its declared complexity can be found. */
  readonly command: string;
}

export interface Measurement {
  readonly n: number;
  /** Nodes touched by a traversal, averaged over the probes. */
  readonly visits: number;
  /** Nodes allocated, averaged over the probes. */
  readonly allocations: number;
}

export interface BenchmarkResult {
  readonly command: string;
  readonly declared: string | null;
  readonly measurements: readonly Measurement[];
  /** Probes that did not run - a benchmark describing itself wrongly. */
  readonly skipped: number;
}

export function runBenchmark(
  plugin: AlgorithmPlugin,
  seed = 1,
): BenchmarkResult | null {
  const benchmark = plugin.benchmark;
  if (benchmark === undefined) return null;

  const declared = plugin.commands.find((c) => c.name === benchmark.command)?.complexity ?? null;
  const measurements: Measurement[] = [];
  let skipped = 0;

  for (const n of benchmark.sizes) {
    // A fresh instance per size, and a fresh RNG, so one size cannot inherit
    // another's shape through a randomised structure.
    const rng: Rng = createRng(seed);
    const inst = plugin.createInstance({ rng });

    let usable = true;
    for (const line of benchmark.setup(n)) {
      const parsed = parseCommand(line, plugin.commands);
      if (!parsed.ok || !inst.execute(parsed.command).ok) { usable = false; break; }
    }
    if (!usable) { skipped += 1; continue; }

    let visits = 0;
    let allocations = 0;
    let counted = 0;
    for (const line of benchmark.probes(n)) {
      const parsed = parseCommand(line, plugin.commands);
      if (!parsed.ok) { skipped += 1; continue; }
      const result = inst.execute(parsed.command);
      if (!result.ok) { skipped += 1; continue; }
      for (const e of result.events) {
        if (e.kind === 'NodeVisited') visits += 1;
        if (e.kind === 'NodeAllocated') allocations += 1;
      }
      counted += 1;
    }
    if (counted === 0) { skipped += 1; continue; }

    measurements.push({ n, visits: visits / counted, allocations: allocations / counted });
  }

  return { command: benchmark.command, declared, measurements, skipped };
}
