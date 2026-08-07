# Architecture

This document records the design AlgoVerse is being built against, and the reasoning behind the
choices that are expensive to reverse. It is the authoritative architecture record for the
project. Where it departs from the original project brief, every deviation is itemised in
[Deviations](#deviations-from-the-original-specification) at the end.

---

## 1. The spine

Algorithms never manipulate the UI. They emit events.

```
ParsedCommand  →  PluginInstance.execute()  →  OperationResult { value, events, statsDelta }
                                                      │
                                                      ▼
                                              Event log (append-only)
                                                      │
                                    ┌─────────────────┴─────────────────┐
                                    ▼                                   ▼
                          Reducer + keyframes                  Statistics engine
                                    │
                                    ▼
                          Scene (semantic structure)
                                    │
                                    ▼
                          Layout (coordinates)
                                    │
                                    ▼
                                Renderer
```

Two rules keep this honest, and everything else follows from them:

1. **An operation runs to completion synchronously.** No `await sleep()` inside an algorithm,
   ever. The operation returns its entire event log at once.
2. **Events are pure serialisable data.** No functions, closures, class instances, DOM
   references, or object identity. If it cannot survive `JSON.parse(JSON.stringify(e))`, it is
   not an event.

Rule 1 makes algorithms testable and makes scrubbing possible. Rule 2 makes saving, sharing, and
replay possible. Both are cheap now and near-impossible to retrofit.

---

## 2. Time travel

The event log is the source of truth. Visual state at step *N* is:

```ts
state(N) = events.slice(0, N).reduce(reduce, initialState)
```

`reduce` is pure. Stepping backward means rewinding to the nearest keyframe and replaying
forward, not undoing.

**Why not inverse events.** The alternative — every event carries its own undo — doubles the
authoring cost of every plugin, and a single incorrect inverse produces state corruption that
only shows up after a specific sequence of steps. Re-derivation cannot drift, because there is
only one code path.

Keyframes are full state snapshots taken every *K* steps (start with `K = 50`, tune later) so
scrubbing to an arbitrary step is bounded work rather than replaying from zero.

This one mechanism delivers step-back, timeline scrubbing, replay, save/load, and version
comparison. Any feature that seems to need its own state history is a sign something bypassed
the log.

### Step granularity

A single `update` on a persistent segment tree is one logical operation, roughly a dozen
primitive events. Users want both readings: "run the whole update" and "descend one node."

Every event carries a `granularity` tag, and the playback engine filters by it. Stepping at
`coarse` advances to the next operation boundary; `fine` advances one event. This is trivial to
add now and a schema migration later.

---

## 3. The plugin contract

The contract is **declarative and command-based**, not a fixed set of methods.

```ts
interface AlgorithmPlugin {
  readonly meta: PluginMeta;              // id, name, category, declared complexities
  readonly commands: readonly CommandSpec[];
  createInstance(ctx: EngineContext): PluginInstance;
}

interface CommandSpec {
  readonly name: string;                  // "update"
  readonly params: readonly ParamSpec[];  // typed, named, with help text
  readonly summary: string;
  readonly complexity?: string;           // "O(log n)"
}

interface PluginInstance {
  execute(cmd: ParsedCommand): OperationResult;
  getStructure(): StructureGraph;         // semantic nodes + edges + layout hint
  serialize(): SerializedState;
  reset(): void;
}

// A union, not optional fields: `ok` narrows to exactly one of value/error.
// Events and stats are reported either way — a failed query may still have
// visited nodes worth showing.
type OperationResult =
  | { ok: true;  value: unknown;         events: readonly SimEvent[]; statsDelta: Partial<Statistics> }
  | { ok: false; error: OperationError;  events: readonly SimEvent[]; statsDelta: Partial<Statistics> };

interface EngineContext {
  readonly rng: Rng;                      // seeded — never Math.random()
}
```

There is no emitter in the context. An operation *returns* its events rather than
emitting them as it goes, which is what keeps it synchronous and its log complete.

**Why not `build()` / `update()` / `query()`.** That shape is derived from one data structure. A
graph plugin has no `update(index, value)`; DFS has no `query(l, r)`; Dijkstra has `run(source)`;
KMP has `search(text, pattern)`. Fixing the method set forces every later algorithm through a
union-typed `update()`, and the engine starts branching on plugin identity to interpret it —
exactly what the architecture forbids.

Declaring commands as data means the console derives its grammar, autocomplete, validation, and
`help` output from `commands`. Otherwise the console becomes the second place that hardcodes
algorithm knowledge, and the leak simply moves.

### The two-plugin rule

Phase 1 ships the persistent segment tree **and** a deliberately trivial second plugin (a plain
array or a stack). One plugin reveals zero abstraction leaks — every accidental assumption still
looks like the contract. Two reveal most of them, cheaply.

`plugin-sdk` exports a conformance kit. It is handed a plugin and a script of command strings and
derives the rest — it names no command. Fourteen checks cover metadata, spec well-formedness,
JSON round-tripping of events and serialised state, determinism across fresh instances, `reset`,
and error-versus-throw behaviour.

The one that carries the most weight:

> **The event log must fully describe the structure.** Replay the log through `core`'s reducer and
> the resulting scene must match `getStructure()` exactly — same node ids, values, labels,
> children, and roots.

If a plugin mutates state without emitting an event, replay silently diverges from reality and
time travel is broken in a way no unit test would catch. This check catches it.

The probe for error handling is also derived rather than written: for every command declaring a
`version` parameter, the kit synthesises a call against `v999` and requires an `ok: false` result
rather than an exception.

---

## 4. Layering

Three layers, not two.

| Layer | Owns | Must not know |
| --- | --- | --- |
| Plugin | Semantic structure: nodes with roles, edges, a layout hint | Pixels, coordinates, colours |
| `core/layout` | Coordinates, from structure + layout hint | What algorithm produced the structure |
| `renderer` | Drawing, camera, animated transitions | Both of the above |

Layout hints are a closed set: `tree | dag | force | linear | grid`. The plugin says "this is a
DAG"; layout decides where things go.

Each `StructureNode` also carries a **`slot`** — an opaque grouping key — and an **`origin`**, the
version that allocated it. Slots are how the spike's finding survives into the contract: nodes
sharing a slot occupy one logical position and the layout engine fans them apart, which is what
keeps several versions of the same node aligned. The persistent segment tree uses
`depth:lo:hi`, but layout never parses it — it only groups by equality. `origin` drives provenance
colouring, so hue means "which version allocated this" without the renderer knowing what a
version is.

The original specification defines the renderer's ignorance but not who computes layout. Putting
it in the plugin means every new algorithm reimplements tree layout. Putting it in the renderer
means the renderer needs structural knowledge it is supposed to lack. It belongs between them.

### Rendering

SVG for Phase 1, behind a `Renderer` interface. Good to roughly 1–2k elements, inspectable in
devtools, styleable with the rest of the app, and accessible. A Canvas or WebGL implementation
slots in behind the same interface when graph sizes demand it.

**Not React Flow.** It is built for node-editor interfaces: draggable nodes, user-authored graphs,
one React component per node. AlgoVerse needs author-controlled layout, many simultaneous
animated transitions driven by its own clock, and eventually hundreds of nodes. DOM-per-node
does not get there, and the migration cost rises with every phase.

D3 is used for layout math only — `d3-hierarchy`, `d3-force`. It never owns the DOM.

Animation is one `requestAnimationFrame` loop reading the playback clock and interpolating.
Spring libraries animate on their own schedule, which is incompatible with frame-accurate
scrubbing; Framer Motion is fine for interface chrome and absent from the canvas.

### State ownership

The engine is plain TypeScript, instantiated outside React.

Zustand holds only coarse interface state: current step, `isPlaying`, speed, selection, panel
layout. The event log and per-frame animation state stay out of it — putting them in a React
store re-renders the tree at 60 Hz. The renderer subscribes to the engine directly and mutates
imperatively.

---

## 5. Memory model

Every node exposes: unique ID, value, children, **parents**, created version, shared count,
reference count, and a logical address.

**Parents is a list, not a single value.** A node shared across versions genuinely has several
parents — one per version whose spine points at it. The spike confirms this on real data: with
three versions over eight elements, interior shared nodes have two distinct parents from
different versions. Modelling it as a scalar makes the sharing story unrepresentable.

IDs are branded types — `NodeId`, `VersionId`, `StepIndex` — not bare numbers. In a system where
nearly every value is an identifier, this costs nothing and eliminates a whole class of silent
mix-up.

---

## 6. Statistics

Two different things share the word "complexity", and the original specification lists them as one.

- **Declared** complexity is static, comes from `CommandSpec.complexity`, and is documentation.
- **Measured** counters — nodes visited, comparisons, allocations, copies, shared nodes, tree
  height — are runtime facts derived from the event log.

Keeping them separate enables the feature worth having: plotting measured cost against the
theoretical curve. Seeing actual node visits track `log₂ n` is the point.

---

## 7. Determinism

Three requirements, all cheap now:

- **Seeded RNG.** Randomised structures (treap in Phase 2) draw from `ctx.rng`. A single
  `Math.random()` call makes replay and shared links diverge from what the author saw.
- **No wall-clock reads** inside algorithms or reducers.
- **Schema versioning.** Every `SerializedState` carries a `schemaVersion`, with a migration
  path from the first release. Without it, the first refactor invalidates every shared link ever
  created.

---

## 8. Errors

Operations return errors, they do not throw them.

```ts
type ErrorCode =
  // owned by the parser — syntax only
  | 'PARSE_ERROR' | 'UNKNOWN_COMMAND' | 'BAD_ARITY' | 'BAD_ARGUMENT'
  // owned by the plugin — semantics, at execution time
  | 'UNKNOWN_VERSION' | 'INDEX_OUT_OF_RANGE' | 'INVALID_RANGE';

interface OperationError {
  code: ErrorCode;
  message: string;                        // shown to the user
  span?: readonly [number, number];       // character range in the console input
  hint?: string;                          // "versions available: v0, v1, v2"
}
```

The split matters: the parser validates that `v9` is *shaped* like a version reference, and the
plugin decides whether version 9 *exists*. Only the plugin knows how many versions there are.

`query v9 2 5` against three versions should point at `v9` and say what exists. Typed codes make
that testable; string throws do not.

---

## 9. Explanations

Explanations are **templates over events**, authored per plugin as pure functions:

```ts
type Explainer = (event: SimEvent, ctx: ExplainContext) => string;
```

"Copied node 14 because version 1 writes index 3, which lies in its range." Deterministic,
offline, testable, and versionable with the event schema. No generated prose, nothing to review
at runtime.

---

## 10. Accessibility

A visualisation-first tool has to work when the visualisation does not.

- The event log is readable as text — each step has a description, which the explainer already
  produces.
- Playback and node traversal are keyboard-operable; nodes are focusable with descriptive labels.
- No meaning carried by colour alone. Node provenance uses stroke weight and a corner marker
  alongside hue; reused pointers are dashed as well as tinted.
- `prefers-reduced-motion` disables transitions; stepping still works.

---

## 11. Performance budget

Targets, so renderer decisions have something to be measured against:

| Metric | Phase 1 target |
| --- | --- |
| Segment tree size, visualised | n ≤ 64 |
| Versions displayed simultaneously | ≤ 3 (see open questions) |
| Graph nodes (Phase 4) | ≤ 500 |
| Frame rate during playback | 60 fps |
| Scrub to arbitrary step | < 50 ms |

---

## 12. Testing

Three layers, in descending order of value per line:

1. **Property tests against a reference model.** Run random operation sequences against both the
   real structure and a naive implementation; assert they agree. For persistent structures,
   assert additionally that **no earlier version changes after a later update** — that invariant
   is the entire reason the structure exists.
2. **Golden-file event logs.** Snapshot the log for a fixed operation sequence. Catches
   unintended changes in what the visualisation will show, which unit tests miss entirely.
3. **Re-derivation tests.** For every log, `state(N)` computed forward must equal `state(N)`
   reached by scrubbing backward from the end. This is what guarantees time travel is correct.

The spike's model already passes (1) — 108 of 108 range queries across three versions, with v0
unchanged after both updates.

---

## 13. Open questions

- **Version window.** Layout places *y* by depth and *x* by range midpoint, so version copies of
  the same range share a slot and fan apart. The widest fanned slot sets the canvas width, not
  the tree. Three versions over eight elements fits at roughly 1200 px; eight versions over
  sixteen will not. Resolve with slot-aware column widths, a hard cap on simultaneously displayed
  versions, or a dedicated diff view — decide before `core/layout` is written.
- **Keyframe interval.** `K = 50` is a guess. Measure once real logs exist.
- **View modes.** `single | diff | union` is the current model. Whether `diff` is a distinct
  layout or a filter over `union` is unresolved.
- **License.** Not chosen. Required before any public release.

---

## Deviations from the original specification

Every change from the original project brief, with its reason.

| # | Specification | Change | Reason |
| --- | --- | --- | --- |
| 1 | Plugin interface is `build/update/query/reset/serialize/deserialize/getStatistics` | Declarative `commands` + a single `execute(ParsedCommand)` | The fixed method set is shaped by one data structure. Graphs, shortest paths, and string matching do not fit it, and forcing them through breaks the rule that the engine holds no algorithm-specific logic. |
| 2 | 15 packages | 5 packages, with subsystems as folders and boundaries enforced by lint rules | `event-system`, `animation-engine`, `playback-engine`, `memory-engine`, and `statistics` are small and mutually dependent. Splitting a package later is easy; merging is not. |
| 3 | NestJS, PostgreSQL, Redis, object storage, hosted auth, error and product analytics in scope | Deferred. Phase 1 is browser-only: local storage plus compressed URL sharing | Nothing in Phase 1 needs a server. The infrastructure cost is weeks and delays the only part that carries product risk. |
| 4 | React Flow | Custom SVG behind a `Renderer` interface; D3 for layout math only | React Flow targets node-editor interfaces. DOM-per-node caps scale and its animation model conflicts with frame-accurate playback. |
| 5 | Monaco Editor | Deferred | Roughly 3 MB for a capability Phase 1 does not use. Running user-authored algorithms is a large, security-sensitive feature in its own right. |
| 6 | "Previous Step" listed without a mechanism | Deterministic re-derivation from the event log plus keyframes | Inverse events double plugin authoring cost and corrupt state when a single inverse is wrong. |
| 7 | Node exposes "Parent" | `parents: NodeId[]` | Shared nodes have one parent per referencing version. Demonstrated on real data by the spike. |
| 8 | "Time Complexity" and "Space Complexity" listed among runtime statistics | Split into declared (static, from plugin metadata) and measured (counters from the event log) | They are different kinds of value. Separating them enables plotting measured cost against the theoretical curve. |
| 9 | Not specified | Added: typed error model, seeded RNG in plugin context, `schemaVersion` on serialised state, event `granularity` tags, layout as its own layer, explicit accessibility and performance targets | Each is inexpensive to add now and either a breaking change or a rewrite later. |
| 10 | Phase 1 is the persistent segment tree alone | Plus one trivial second plugin | A single implementation cannot demonstrate that an abstraction is not shaped around it. |
