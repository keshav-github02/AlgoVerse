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

**Why not inverse events.** The alternative - every event carries its own undo - doubles the
authoring cost of every plugin, and a single incorrect inverse produces state corruption that
only shows up after a specific sequence of steps. Re-derivation cannot drift, because there is
only one code path.

Keyframes are full state snapshots taken every *K* steps (start with `K = 50`, tune later) so
scrubbing to an arbitrary step is bounded work rather than replaying from zero.

This one mechanism delivers step-back, timeline scrubbing, replay, save/load, and version
comparison. Any feature that seems to need its own state history is a sign something bypassed
the log.

### Drawing from the log

`sceneToStructure` turns a replayed `SceneState` into the same `StructureGraph` a plugin reports.
That is the join that makes the central claim true: scrub to step 40 and the picture is what the
structure *was* at step 40, reconstructed rather than remembered. Nothing asks the plugin.

For this to work the log has to be self-sufficient, so `NodeAllocated` carries `role`, `depth`,
`slot` and `origin` alongside the value and label. Anything the picture needs that the log does not
carry is a place where replay silently falls back on present-day state.

The conformance kit compares the derived graph against `getStructure()` field by field - a `slot`
that disagrees puts a node in the wrong place, an `origin` that disagrees gives it the wrong colour.

### Comparing versions

`diffRoots` walks edges from two roots and classifies every node as shared, only-in-A, only-in-B,
or neither. It is purely structural - nothing in it knows what a version is, which is why the same
function answers "what does this version see" for a persistent tree and "what is still linked" for
anything else. The segment tree's `compare` command calls it rather than carrying its own traversal.

The renderer expresses the result through a generic three-level `emphasis` map: **primary**,
**secondary**, **muted**. The caller decides what the levels mean; the renderer only knows one reads
louder than the next. Shared nodes get primary, because reuse is the point of the comparison - the
handful of differing nodes are the easy part to see.

Emphasis is carried by stroke weight and dash pattern as well as opacity, so the distinction
survives for anyone who cannot separate the shades. An edge is drawn only as loud as its quieter
end, which keeps pointers into muted regions from standing out.

### Layout is computed once, not per frame

Playback lays out the **union of every node that ever exists**, then draws each frame as a subset of
those fixed positions.

Laying out each frame independently would be the obvious approach and it is wrong: surviving nodes
would slide sideways every time a neighbour appeared, so the picture would read as churn rather than
as an algorithm running. The union is not the final state either - a structure that deletes nodes
(the stack) has a union strictly larger than anything visible at once.

### Playback

`Playback` owns a position in the log and nothing else. **There is no timer inside it**: the host
calls `tick(deltaMs)` from its own animation loop. That keeps playback deterministic and testable,
and it is what actually enforces the separation between algorithm time and wall-clock time.

Fractional time accumulates across ticks, so a slow speed still advances instead of rounding to zero
every frame. Playback pauses at the end rather than looping.

### Step granularity

`Timeline.append(events, label)` records a **mark** at each operation boundary, labelled with the
console line that produced it. Coarse stepping (`nextMark`/`prevMark`) moves operation by operation;
fine stepping moves event by event. This replaces the earlier plan to tag every event with a
granularity level - the boundary is a property of the operation, not of its individual events, so
recording it once per `append` is both cheaper and harder to get wrong.

A single `update` on a persistent segment tree is one logical operation, roughly a dozen
primitive events. Users want both readings: "run the whole update" and "descend one node."

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
// Events and stats are reported either way - a failed query may still have
// visited nodes worth showing.
type OperationResult =
  | { ok: true;  value: unknown;         events: readonly SimEvent[]; statsDelta: Partial<Statistics> }
  | { ok: false; error: OperationError;  events: readonly SimEvent[]; statsDelta: Partial<Statistics> };

interface EngineContext {
  readonly rng: Rng;                      // seeded - never Math.random()
}
```

There is no emitter in the context. An operation *returns* its events rather than
emitting them as it goes, which is what keeps it synchronous and its log complete.

**Why not `build()` / `update()` / `query()`.** That shape is derived from one data structure. A
graph plugin has no `update(index, value)`; DFS has no `query(l, r)`; Dijkstra has `run(source)`;
KMP has `search(text, pattern)`. Fixing the method set forces every later algorithm through a
union-typed `update()`, and the engine starts branching on plugin identity to interpret it -
exactly what the architecture forbids.

Declaring commands as data means the console derives its grammar, autocomplete, validation, and
`help` output from `commands`. Otherwise the console becomes the second place that hardcodes
algorithm knowledge, and the leak simply moves.

### The two-plugin rule

Phase 1 ships the persistent segment tree **and** a deliberately trivial second plugin. One plugin
reveals zero abstraction leaks - every accidental assumption still looks like the contract. Two
reveal most of them, cheaply.

The second plugin is a **stack**: no versions, no tree, no ranges, and it *deletes* nodes. It was
written after the segment tree and immediately found four leaks, all of which would have blocked
later phases:

| Leak | Why it mattered | Fix |
| --- | --- | --- |
| `PointerSet.slot` was `'left' \| 'right'` | Binary-tree-shaped. A stack cell points *below*; a B-tree node has many children | Slots are plugin-defined strings, and `SceneNode.children` is a map keyed by slot instead of `left`/`right` fields |
| No way to remove a node | `pop` had nothing to emit, so the replayed log kept nodes the structure had dropped | Added a `NodeDeleted` event |
| `roots` only ever grew | `VersionCommitted` appended, which suits version history but not a stack whose top moves | Split them: `RootsSet` replaces the current entry points, `VersionCommitted` appends to `versions` |
| No error code for "not in a valid state" | Popping an empty stack fits none of the segment tree's codes | Added `PRECONDITION_FAILED` |

A fifth problem was in the conformance kit rather than the contract: its bad-semantics probe only
examines commands declaring a `version` parameter, so against a stack it examined nothing and
reported a pass. It now reports **skipped**, which is the truth.

### What the third plugin found

The persistent BIT is a Fenwick tree with path copying - persistent like the segment tree, but a
different shape. It exposed two more assumptions, both invisible while every plugin was a tree:

| Assumption | Why it broke | Fix |
| --- | --- | --- |
| A version has one root | A Fenwick forest has one root only when *n* is a power of two; at *n* = 6 the roots are cells 4 and 6 | `VersionCommitted` carries `roots: NodeId[]`, and `SceneState.versions` is a list of root lists |
| Reading order is traversal order | True for a tree, false for anything indexed: cell 4 belongs at column 4, not centred between cells 2 and 3 | `StructureNode.order` is optional; when every slot declares one, layout places by it and skips centring |

The first is the more important: "a version is a set of entry points, not one node" is the truthful
model, and it will matter again for any forest-shaped structure.

Both are cheap changes that were expensive to foresee. The README's claim that adding an algorithm
needs no engine changes held for the stack and did not hold here - which is the argument for adding
plugins early rather than after the contract has hardened.

### What the fourth plugin found

The treap is the first plugin to draw from `ctx.rng`. Until it existed, every plugin took `_ctx`
and ignored it - so the save format's central claim, that replay is sound *because* randomness comes
from a seed carried in the file, had never been exercised. It now is: the same seed rebuilds the
same tree, a different seed builds a different one, and every version holds the right keys under
either.

It also forced two changes:

| Assumption | Why it broke | Fix |
| --- | --- | --- |
| Every node has a depth | A shared subtree sits at different depths in different versions, so no single number is true | `depth` is optional; layout derives it breadth-first from the roots when absent |
| A plugin only allocates what it keeps | Split-then-merge insert copied each path twice and orphaned the first copy - 64% of the canvas was unreachable | Insert descends and splits once; build constructs directly instead of inserting repeatedly. The conformance kit now checks it |

That last one is the useful one. **"Every allocated node is reachable"** is a generic property, and
the kit now enforces it for every plugin - it catches wasted allocation that nothing else would
notice, because the result still looks correct and merely renders a canvas full of debris.

### What the fifth plugin found

The trie is the first structure whose arguments are not numbers, and the first whose nodes have more
than two children. It needed one contract extension and caught two things.

`word` and `word-list` join `int`, `version` and `int-list` as parameter kinds. Adding one is
exactly what a spec-driven parser is for: the console picked up `build [cat car dog]` and
`insert v0 care` with no console changes, because it never knew the kinds it already had either.

Two problems, both caught by checks written for earlier plugins:

- **The conformance kit could not probe it.** Its bad-semantics probe synthesises a call for every
  versioned command, and only knew how to invent numbers - so against the trie it reported "could
  not parse probe" rather than testing anything. It now has a stand-in per kind.
- **`build` stranded 8 of 22 nodes.** Inserting the words one at a time path-copies on every
  insert and commits only the final root, exactly as the treap's build did. The
  "every allocated node is reachable" check, added *because* of the treap, caught the identical
  mistake in a plugin written weeks later and before it ever reached a screen.

The second is the argument for pushing findings into the kit rather than fixing them once. Building
the trie's shape first and allocating bottom-up brings it to 6 nodes for the 10 letters of
`cat car card` - the prefix sharing the structure exists for.

Nothing else needed changing. A node stands for a prefix, so its depth is its prefix length and is
stable across versions; children are ordered by the letter on the pointer, which the layout engine's
natural sort already handled. Twenty-six children lay out a to z with no overlap.

### The one that is meant to be bad

The unbalanced BST is the treap with the randomness removed, and it is the first structure here
built to demonstrate a *failure*. Every other plugin behaves well; a tool for understanding
algorithms should be able to show what going wrong looks like.

Its `build` inserts in the order given rather than sorting first, because insertion order is the
only thing that decides a BST's shape. Sorting would hide the entire effect. The same 32 keys, in
the same sorted order:

| Structure | Worst lookup | Average lookup |
| --- | --- | --- |
| Persistent BST | 32 nodes | 16.5 |
| Persistent Treap | 9 nodes | 5.2 |

That is what the treap's random priorities are buying, and it is now visible rather than asserted.
The BST's benchmark deliberately uses sorted input, so its cost chart draws a straight rising line
against everything else's logarithm.

Adding it also generalised complexity parsing. The size variable's name carries no information —
`O(len)`, `O(height)` and `O(n)` are all linear in whatever the benchmark varies — so any single
identifier now normalises to `n`. Two distinct identifiers still fail to parse, because
`O(E log V)` genuinely cannot be fitted on one axis.

Two residual compromises, both recorded rather than fixed:

- `StructureNode.origin` names the version that allocated a node. A structure without history sets
  it to `0` for everything. Harmless, but it is history vocabulary in a general interface.
- `Statistics` is a fixed set of counters. A stack leaves `versions` at zero and reads `updates` as
  "pushes and pops". This holds for now; plugin-declared statistics are the eventual fix.

`plugin-sdk` exports a conformance kit. It is handed a plugin and a script of command strings and
derives the rest - it names no command. Fourteen checks cover metadata, spec well-formedness,
JSON round-tripping of events and serialised state, determinism across fresh instances, `reset`,
and error-versus-throw behaviour.

The one that carries the most weight:

> **The event log must fully describe the structure.** Replay the log through `core`'s reducer and
> the resulting scene must match `getStructure()` exactly - same node ids, values, labels,
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

Each `StructureNode` also carries a **`slot`** - an opaque grouping key - and an **`origin`**, the
version that allocated it. Slots are how the spike's finding survives into the contract: nodes
sharing a slot occupy one logical position and the layout engine fans them apart, which is what
keeps several versions of the same node aligned. The persistent segment tree uses
`depth:lo:hi`, but layout never parses it - it only groups by equality. `origin` drives provenance
colouring, so hue means "which version allocated this" without the renderer knowing what a
version is.

The original specification defines the renderer's ignorance but not who computes layout. Putting
it in the plugin means every new algorithm reimplements tree layout. Putting it in the renderer
means the renderer needs structural knowledge it is supposed to lack. It belongs between them.

### Layout

Leaf slots take their *x* from a depth-first walk of the roots and are laid down left to right,
each consuming exactly the width its own fan needs. Parents then centre over their children, and a
per-depth separation pass pushes apart anything centring pulled together. *y* comes straight from
`StructureNode.depth`.

Child order comes from a **natural sort of the pointer name**, so `c2` precedes `c10`. Alphabetical
ordering would have shuffled a B-tree's children.

**The version-window question is settled: no cap, no separate diff view.** The prototype worried
that the widest fanned slot would set the canvas width and blow up as versions accumulated. With
per-slot widths it does not, because an update only touches `log n` slots - most slots never fan at
all. Width comes out at roughly `(n + versions) x 66 + n x 26` pixels:

| Elements | Versions | Nodes | Width |
| --- | --- | --- | --- |
| 8 | 3 | 23 | 858 px |
| 8 | 8 | 43 | 1188 px |
| 16 | 16 | 106 | 2388 px |
| 32 | 16 | 153 | 3732 px |
| 64 | 32 | 344 | 7476 px |

Linear in both, with no overlap at any size - verified rather than reasoned. Sixty-four elements
across thirty-two versions is wide enough to need panning, but that is a camera concern, not a
correctness one, and the earlier plan to cap displayed versions can be dropped.

`force` is a placeholder: deterministic ring placement with no relaxation. It must be replaced
before the graph phase.

### Rendering

SVG for Phase 1, behind a `Renderer` interface. Good to roughly 1–2k elements, inspectable in
devtools, styleable with the rest of the app, and accessible. A Canvas or WebGL implementation
slots in behind the same interface when graph sizes demand it.

**Not React Flow.** It is built for node-editor interfaces: draggable nodes, user-authored graphs,
one React component per node. AlgoVerse needs author-controlled layout, many simultaneous
animated transitions driven by its own clock, and eventually hundreds of nodes. DOM-per-node
does not get there, and the migration cost rises with every phase.

D3 is used for layout math only - `d3-hierarchy`, `d3-force`. It never owns the DOM.

Animation is one `requestAnimationFrame` loop reading the playback clock and interpolating.
Spring libraries animate on their own schedule, which is incompatible with frame-accurate
scrubbing; Framer Motion is fine for interface chrome and absent from the canvas.

### State ownership

The engine is plain TypeScript, instantiated outside React.

Zustand holds only coarse interface state: current step, `isPlaying`, speed, selection, panel
layout. The event log and per-frame animation state stay out of it - putting them in a React
store re-renders the tree at 60 Hz. The renderer subscribes to the engine directly and mutates
imperatively.

---

## 5. Memory model

Every node exposes: unique ID, value, children, **parents**, created version, shared count,
reference count, and a logical address.

**Parents is a list, not a single value.** A node shared across versions genuinely has several
parents - one per version whose spine points at it. The spike confirms this on real data: with
three versions over eight elements, interior shared nodes have two distinct parents from
different versions. Modelling it as a scalar makes the sharing story unrepresentable.

IDs are branded types - `NodeId`, `VersionId`, `StepIndex` - not bare numbers. In a system where
nearly every value is an identifier, this costs nothing and eliminates a whole class of silent
mix-up.

---

## 6. Statistics

Two different things share the word "complexity", and the original specification lists them as one.

- **Declared** complexity is static, comes from `CommandSpec.complexity`, and is documentation.
- **Measured** counters - nodes visited, comparisons, allocations, copies, shared nodes, tree
  height - are runtime facts derived from the event log.

Keeping them separate enables the feature worth having, which now exists: measured cost plotted
against the theoretical curve.

A plugin declares a `benchmark` — how to build itself at a given size, and which command to time —
because the engine cannot know either. Everything after that is generic. Cost is counted in
**events, not seconds**: a wall-clock reading of a teaching-sized structure measures the JIT, while
the number of nodes an operation touches is what the complexity claim is actually about.

The declared string is parsed into a curve and fitted by least squares **through the origin**. The
shape is fixed; only its scale is free. Fitting an intercept as well would let a flat measurement
pass for a logarithm at small sizes.

The measurements are also classified against every growth class independently, so the tool reports
what the numbers *look like* rather than only how well they match what was claimed. A declaration
that disagrees with its own behaviour is then visible rather than assumed:

| Structure | Command | Declared | Measured | Fit |
| --- | --- | --- | --- | --- |
| Segment tree | `query` | O(log n) | 11 → 31 visits | R² 0.998, ×3.83 |
| BIT | `prefix` | O(log n) | 3 → 8 visits | **R² 1.0000, ×1.00** |
| Treap | `find` | O(log n) expected | 2.9 → 9.6 visits | R² 0.939, ×1.08 |
| Stack | `peek` | O(1) | flat at 1 | R² 1.0000 |

The BIT's prefix walk is exactly `log₂ n`. The segment tree's constant of 3.83 is the "up to four
nodes per level" bound for range queries, visible in the data rather than asserted. The treap's
looser 0.939 is what *expected* looks like next to a guarantee — which is the distinction the word
is carrying, and it is now something you can see.

The chart spaces its x axis by `log₂ n`, so a logarithmic cost draws as a **straight line**. On a
linear axis, logarithmic and linear both look like gentle curves and the reader is left to judge the
difference by eye.

---

## 7. Determinism

Three requirements, all cheap now:

- **Seeded RNG.** Randomised structures (treap in Phase 2) draw from `ctx.rng`. A single
  `Math.random()` call makes replay and shared links diverge from what the author saw.
- **No wall-clock reads** inside algorithms or reducers.
- **Schema versioning.** Every `SerializedState` carries a `schemaVersion`, with a migration
  path from the first release. Without it, the first refactor invalidates every shared link ever
  created.

These are not hygiene - they are what makes the save format below possible at all.

---

## 7a. Saving and sharing

**A saved simulation is the list of commands, not the structure they produced.** Replaying rebuilds
the state, the event log, the marks and the timeline, so a loaded simulation scrubs exactly like a
fresh one. Saving the structure would restore the final picture and throw away the history - and
would be a second source of truth, free to drift from the log. It is the same argument as
re-derivation over inverse events, one level up.

This only works because operations are deterministic, and the seed travels in the file.

```ts
interface SimulationFile {
  schemaVersion: number;
  pluginId: string;
  seed: number;
  commands: readonly string[];
  digest: string | null;
}
```

Only commands that **succeeded** are recorded. A rejected command changed nothing, so saving it
would just reproduce the error on load.

`PluginInstance.serialize()` is not the save format, but it is not dead either: it produces the
**digest**. After replaying, the loader compares it against the saved one, which catches the silent
failure a command-replay format is otherwise prone to - a plugin whose behaviour changed since the
file was written, replaying the same script into a different structure.

The digest is a **hash**, not the state. Embedding the serialised structure made a four-command
share link 3187 characters and grew with the data rather than the script; hashing it brought the
same link to 184. Eight hex digits of FNV-1a is ample for "this no longer behaves as it did", which
is not an adversarial problem.

A digest mismatch **warns rather than refuses**. The file is still the user's work, and opening it
with a caveat beats refusing to open it at all. A missing plugin is a hard failure, because there is
nothing to open.

---

## 8. Errors

Operations return errors, they do not throw them.

```ts
type ErrorCode =
  // owned by the parser - syntax only
  | 'PARSE_ERROR' | 'UNKNOWN_COMMAND' | 'BAD_ARITY' | 'BAD_ARGUMENT'
  // owned by the plugin - semantics, at execution time
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

Explanations are **templates over events**, authored per plugin as pure functions and declared as
an optional `explain` on the plugin:

```ts
type Explainer = (event: SimEvent, ctx: ExplainContext) => string | null;

interface ExplainContext {
  readonly after: SceneState;            // state immediately after the event
  readonly command: ParsedCommand | null; // so a sentence can cite real arguments
  readonly step: number;
}
```

> Copy of range [2, 4), because the write to index 3 falls inside range [2, 4). Only nodes on this
> one root-to-leaf path are copied - everything else is shared.

Deterministic, offline, testable, and versionable with the event schema. No generated prose,
nothing to review at runtime.

**Prose is never stored in the log.** An explainer could just as easily have run at execution time
and stapled its output onto each event, which would have been simpler - but that puts English into
serialised state, bloats every saved simulation, and means improving a sentence requires re-running
the algorithm. Reconstructing on demand keeps the log pure data and leaves one obvious place to add
other languages.

The context carries the **command**, which is what lets an explanation say *why* rather than *what*:
without it the best available sentence is "a node was allocated". Returning `null` falls back to the
generic description, so a plugin narrates only what is worth narrating and the mechanical events
still say something.

Explanations are prose, and prose is easy to get confidently wrong - the first version of the
segment tree's query explainer described ranges lying entirely outside the query as "straddling the
edge", because it tested for *contained* and treated everything else as *partial*. Assertions that
only check for non-empty text will not catch that. Read the output.

---

## 10. Accessibility

A visualisation-first tool has to work when the visualisation does not.

- The event log is readable as text - each step has a description, which the explainer already
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
   assert additionally that **no earlier version changes after a later update** - that invariant
   is the entire reason the structure exists.
2. **Golden-file event logs.** Snapshot the log for a fixed operation sequence. Catches
   unintended changes in what the visualisation will show, which unit tests miss entirely.
3. **Re-derivation tests.** For every log, `state(N)` computed forward must equal `state(N)`
   reached by scrubbing backward from the end. This is what guarantees time travel is correct.

The spike's model already passes (1) - 108 of 108 range queries across three versions, with v0
unchanged after both updates.

---

## 13. Open questions

- ~~**Version window.**~~ **Resolved - no cap is needed.** See [Layout](#layout) below.
- **Keyframe interval.** `K = 50` is a guess. Measure once real logs exist.
- ~~**View modes.**~~ **Resolved.** `diff` is a filter over the union, not a separate layout: it
  reuses the same coordinates and only changes emphasis, so switching between comparing and
  watching never moves a node. Comparison appears whenever the replayed scene reports two or more
  versions - driven by the data, so a structure without history simply never offers it.
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
