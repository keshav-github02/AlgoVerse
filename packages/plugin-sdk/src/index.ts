export {
  ZERO_STATS,
  addStats,
  failed,
  type AlgorithmPlugin,
  type EngineContext,
  type ExplainContext,
  type Explainer,
  type LayoutHint,
  type OperationResult,
  type PluginInstance,
  type PluginMeta,
  type SerializedState,
  type Statistics,
  type StructureEdge,
  type StructureGraph,
  type StructureNode,
} from './contract.ts';

export { runConformance, type ConformanceResult } from './conformance.ts';

export {
  runBenchmark,
  type Benchmark,
  type BenchmarkResult,
  type Measurement,
} from './benchmark.ts';

export {
  CHALLENGE_SEED,
  budgetOf,
  judge,
  targetOf,
  type Challenge,
  type Verdict,
} from './challenge.ts';
