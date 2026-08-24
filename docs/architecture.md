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

Adding it also generalised complexity parsing. The size variable's name carries no information -
`O(len)`, `O(height)` and `O(n)` are all linear in whatever the benchmark varies - so any single
identifier now normalises to `n`. Two distinct identifiers still fail to parse, because
`O(E log V)` genuinely cannot be fitted on one axis.

### The answer to the one that is meant to be bad

The AVL tree is Phase 3's first structure and the direct reply to the unbalanced BST. Same sorted
input, same command, three different guarantees:

| Structure | Worst lookup | Average |
| --- | --- | --- |
| Persistent BST | 64 nodes | 32.5 |
| Persistent Treap | 10 nodes | 6.3 |
| Persistent AVL | 7 nodes | 5.1 |

Its benchmark deliberately uses the same sorted input as the BST's, so the two cost charts sit
side by side: one straight rising line, one logarithm.

**Rotations are the first operation that rearranges a node's children rather than copying them
along a path** - and they needed no new event kind. A rotation only changes which children the
newly-allocated nodes are handed, so `NodeAllocated`, `PointerSet` and `NodeReused` already
describe it exactly. The explainer supplies the word "rotation"; core never learns it. Persistence
makes rotation cheaper to model than in a mutable tree, where it is a genuine pointer shuffle.

Balance rides on `StructureNode.role`, which is already a free-form string: every node reports
`balanced`, `left-heavy` or `right-heavy`. Those three values *are* the invariant, so it can be
read straight off a node in the inspector.

The invariant is verified by **recomputing every subtree height from the graph** rather than
trusting the heights the plugin stores. A wrong stored height would otherwise make an unbalanced
tree report itself as balanced - the check would agree with the bug. Confirmed over 40 sorted
inserts followed by 20 erases, and again after every operation of a 240-operation property test.

Nothing in the contract needed changing. Five plugins ago each new structure exposed a leak; the
last two have not, which is the more useful signal.

### The first node that is not a single value

The B-tree holds up to three keys per node, and that broke two assumptions the contract had carried
unnoticed since the very first plugin.

| Assumption | Why it broke | Fix |
| --- | --- | --- |
| A node holds one value | `StructureNode.value` is a single number. A B-tree node holds several keys and none of them is *the* value | `values?: readonly number[]` alongside it, carried through the event log and drawn by the renderer |
| Every node is the same width | Layout wrote `o.nodeWidth` onto every node, even though `PositionedNode.width` had been per-node in the type all along | Width follows the text a node shows, for every plugin rather than just this one |

The second is the more interesting mistake. The *type* was right - width was per-node from the
beginning - and the implementation quietly filled it with a constant. Nothing failed, because until
now every node really did show one short number.

Its search cost also measures lower than the binary trees, at a constant of 0.66 against the AVL's
1.17: a B-tree compares several keys per node read, so it reads fewer nodes for the same number of
keys. That is the whole point of fan-out, and it now shows up as a number rather than a claim.

**Deletion is deliberately absent.** Removing from a B-tree needs borrowing and merging between
siblings, which is markedly more intricate than the rest of the plugin; a wrong implementation would
be worse than a missing one. The command simply is not declared, so the console never offers it.

The invariants are recomputed from the graph rather than trusted: key counts within bounds, keys
sorted, every key inside the range its parent implies, child count exactly one more than key count,
and all leaves at the same depth. Verified over a 200-key build, across thirty successive versions,
and after every operation of a 250-operation property test.

### The first read that writes

A splay tree drags whatever you looked up to the root, so `access` is a lookup *and* a
restructuring. Under persistence that means **a read produces a version** - and the version it read
keeps its old shape, which turns an invisible side effect into something you can scrub back to.

The contract already allowed it. `statsDelta` reports `{ versions: 1, queries: 1 }` for the same
operation, and both are true: the user asked a question, and the shape changed. A separate
`contains` command does the read-only version, so the distinction is available rather than assumed.

Its benchmark measures **a run of accesses, not one**. Each probe reads the version the previous
probe produced, so the rearrangement carries forward. That is the only way an amortised bound can be
observed: one access on a 64-key spine reads 32 nodes, and the same tree averages 4.6 over 64
accesses. A single probe would have measured the worst case and declared `O(log n) amortised`
false. The looser fit that results - R² 0.71 against the AVL's 0.97 - is itself the finding:
amortised is a claim about sequences, and it looks noisier than a guarantee because it is one.

Writing it also produced the sharpest instance yet of the conformance kit's reachability rule.
Splaying moves a node up **two** levels, and the natural implementation rotates twice over an
intermediate - which strands that intermediate the moment the second rotation rebuilds it. The first
attempt left 10 of 23 nodes unreachable, the second 2 of 15. Computing each case's final shape in
one step brought it to zero and cut the same script from 23 nodes to 13.

Nothing in that is visible from the answers, which were correct throughout. It shows up only as a
canvas full of debris, which is exactly why the rule lives in the kit rather than in one plugin.

### The first pointer that is not a tree edge

A B+ tree keeps its keys in the leaves and chains the leaves together, so a range query descends
once and then reads sideways. That chain is the first pointer here that does not mean "one level
down", and layout had assumed every edge did - following one would have staggered the leaves
downward and scrambled their order.

`StructureEdge.kind` now distinguishes `child` from `link`. Only `child` decides depth or
ordering; a `link` is drawn and nothing more. Layout also anchors a same-row edge at the sides
rather than top-to-bottom, which was meaningless for a horizontal pointer.

The conformance kit then caught the more interesting mistake. The first version *derived* the chain
inside `getStructure()` and never logged it, so replay produced a picture with five edges where the
plugin reported eight - precisely the invariant that check exists to protect. **A pointer the
picture shows and the log does not carry is a pointer replay cannot rebuild.** `PointerSet` gained
a `pointer` field, `SceneNode` gained a `links` map, and the chain became events like anything
else.

Fixing it surfaced why the chain was tempting to fake. A leaf shared between two versions can have a
different successor in each, and **a pointer that differs per version cannot live on a shared node**
- that is what persistence means. A production B+ tree pays for this by copying the predecessor leaf
and all its ancestors on every split. This plugin instead maintains the chain destructively while
the tree stays persistent, and says so: scrubbing moves the chain with you, but two versions' chains
cannot be seen at once.

### Phase 4 begins, and the placeholder goes

The graph is the first structure with no hierarchy at all - no root, no parent, and no guarantee it
is even connected. `force` had been a documented placeholder since layout was written: deterministic
ring placement with no relaxation, marked "replace before shipping graph algorithms". It is now a
real Fruchterman-Reingold simulation, and the graph plugin is what proves it.

**Deterministic by construction.** Nodes start evenly spaced on a circle in id order rather than at
random, and the iteration count is fixed. A layout that moved between runs would make every check
here untestable and every shared link show a different picture than its author saw. Settling is
followed by a separation pass, because a force simulation leaves nodes close but not reliably clear
of one another.

It works: on a ten-vertex graph, joined vertices settle **137px** apart and unjoined ones **420px**.

Three things the contract already handled, which is the more useful signal:

- Graph edges are `kind: 'link'` - neither end is the other's parent - so the machinery added for
  the B+ tree's leaf chain covered them unchanged.
- A traversal is a read that allocates nothing, so the version machinery simply goes unused.
- **Every vertex is an entry point.** An unrooted structure has no other honest answer for `roots`,
  and it is what keeps the "every allocated node is reachable" rule meaningful for a graph that
  might be disconnected.

### Order statistics, three ways

`kth` - the k-th smallest thing - is the same question asked of three
structures, and each answers it with what it already had lying around.

- **Segment tree**: descend, comparing k against the left child's total.
- **Fenwick tree**: take the widest block you can still afford. Nine cells for
  256 entries.
- **Balanced tree**: neither AVL nor red-black could do it at all. A search
  tree puts keys in order but cannot say *how far along* one is, so both gained
  a subtree count - kept in the same breath as the AVL's height, and for the
  same reason: a fact about a subtree that costs a walk to recompute and
  nothing to carry.

The check that matters for the trees is `the counts survive rebalancing`.
Nothing else reads the count, so a rotation that rebuilt a node without
recomputing it would be silently wrong ever after. Sixty-four sorted keys -
the input that rotates on nearly every insert - and every position verified.

`rank` came with it and is the inverse: how many keys come before a value,
whether or not that value is there. That last part is what makes it answer
"where would this go" as well as "where is it", and the two together are
checked against each other as well as against a sorted array.

### One Fenwick array cannot do both

The Fenwick tree answers a range and writes one index. Writing a *range* and
answering a prefix needs a different arrangement of the same idea - store the
array's differences, so a range add is two writes - and reading a sum back out
of differences needs a second array to undo the offsets.

That is a different structure, not another command, so it is a different
plugin. Folding it into the existing one would have cost `kth`, which descends
by taking the widest block it can afford: with two arrays a cell holds part of
a difference rather than the sum of a block, so there is no block to take and
finding a position drops to a binary search at O(log² n). It would also have
made every point write copy four chains instead of one. The contrast is the
lesson, and it is easier to see with both on the page.

The new plugin found the stranding bug this repository has now hit four times.
A range write touches two chains of the same array, and where they meet the
second walk was replacing the cell the first had just allocated - leaving it
allocated, pointed at by nothing, and part of no version. The chains are merged
before anything is allocated. An index whose two deltas *cancel* is still
copied: its value is unchanged but its children are not, and one cell cannot
hold the pointers of two versions at once.

### Lazy tags that are never pushed down

A range update marks the O(log n) nodes covering the range and leaves
everything below them alone. The textbook then *pushes* that tag down on the
next visit - and that is precisely what a persistent structure cannot do,
because the nodes below are shared with every earlier version and pushing
would rewrite their past.

So nothing is ever pushed. A tag stays where it lands and a query adds up the
tags it passes on the way down. The two ideas fit together better than they do
in the mutable case: not pushing is what makes a range update O(log n)
*allocations* rather than O(log n) now and an unbounded rewrite later. Measured
on 256 entries: covering 200 indices costs **19 nodes**, covering 2 costs 8.

The consequence worth knowing is that a node's number is no longer its range's
total - it is the total of everything at or below it, with the tags above it
still to be added. That is what the tree stores, so that is what is drawn, and
a node carrying a tag says so in its label.

Two things fell out of it:

- A point write under a tag must store `value - carried`, so that adding the
  tags back gives what was written. Getting that sign wrong is invisible until
  a range update and a point write meet on the same index, which is now a
  check of its own.
- `kth` descends by comparing against the left child, which needs every value
  to be non-negative. The range minimum added alongside `min` sits on the
  root, so the precondition costs nothing - the plugin refuses with the reason
  rather than returning a plausible wrong index.

The explainer went wrong in the way it has before: it described a reused node
under a tag as *untouched by this write*. It is not untouched - its values
change by the tag - it is merely not copied, and the old wording taught the
opposite of how a tag works. There is now a check on the wording itself.

### What the BIT deliberately does not do

The Fenwick tree gained `range` and `kth` and **not** range update. One
Fenwick array serves range updates with point reads, or point updates with
range reads, never both; doing both needs a second array alongside it, which
would also cost `kth` - the descent works because a prefix is a walk down the
parent chain, and with two arrays a prefix stops being one. Range updates
against range reads belong on the segment tree, where a tag can sit and wait.

`kth` is the operation the Fenwick shape gives away for free: each cell holds
a block whose width is a power of two, so the descent tries the widest blocks
first and takes each it can afford - **9 cells for 256 entries**. A plain array
of prefix sums cannot do it at all.

### Two greedy strategies that check each other

Prim and Kruskal live in one plugin, which breaks the one-package-per-algorithm
habit on purpose. They solve the same problem from opposite directions - one
grows a single tree outward, the other takes cheap edges from anywhere and lets
the pieces meet - and the fact worth teaching is that they must reach the same
total. That is a claim to test, not a remark to make, and having both here means
each tests the other.

Both rest on the **cut property**: split the vertices any way at all, and the
cheapest edge crossing that split belongs to some minimum spanning tree. Prim
uses it directly, its split always being reached-against-unreached. Kruskal uses
it the other way round: an edge whose ends are in different pieces is the
cheapest across the split separating those pieces, so it is safe.

Agreement is necessary but not sufficient - two greedy algorithms could be
wrong together. So the property test also enumerates **every** set of n - 1
edges and finds the cheapest spanning tree by brute force, which is the only
reference that actually answers "but is greedy really enough". Sixty graphs,
and in two of them the two strategies chose *different* edges of the same total,
which is exactly what ties permit and what the test is written to allow.

Prim here is the O(n²) scan rather than a heap version, and it is declared and
measured as such: **R² 1.0000**. The events count entries examined while
scanning for the cheapest frontier vertex, which is the work that makes it
quadratic. Kruskal's O(E log E) has two variables and so is not measured at
all - the same honest skip the earlier O(V + E) declarations take.

One small contrast worth noting in passing: neither algorithm needs weights to
be positive, and a check asserts a negative-weight graph works. Dijkstra next
door refuses one outright, and for a good reason - it never revisits a settled
vertex. A spanning tree has to span whatever the costs are.

### Bridges and cut vertices: one walk, two answers, one equals sign

Both answers fall out of the same depth-first walk, and the entire difference
between them is a comparison. For a child `c` of `v`, the walk records how far
back `c`'s subtree can climb: if it cannot get back past `v` at all, the edge
`v-c` is a **bridge**; if it cannot get back past `v` *itself*, `v` is a **cut
vertex**. That is `low[c] > disc[v]` against `low[c] >= disc[v]` - strictly
above `v` versus no higher than `v`. Getting back to `v` and no further saves
the edge, because a cycle runs through it, but does not save the vertex,
because the cycle runs through `v`.

The clearest picture of the gap is two triangles sharing a single vertex: **no
edge is a bridge** and **that vertex is a cut vertex**. A check asserts exactly
that, because it is the one case where a plausible implementation with the
wrong comparison still passes every other test.

The root of the walk is the exception and needs its own rule: it has no parent
to be separated from, so it is a cut vertex when it has **two or more children
in the walk tree**, not when a low-link says so. A star centred on vertex 2 with
the walk starting at vertex 1 pins this down - 1 has one branch and must not be
reported, 2 has two and must be.

Verification is the definition applied literally: take the thing away and count
the pieces by breadth-first search. Quadratic, impossible to misread, and the
only reference worth having for a one-pass trick. **67 random graphs, 7 of them
already in more than one piece**, because a bridge finder that quietly assumes
connectivity is a bridge finder that is wrong on real input. The property test
also asserts a relation *between* the two answers - a bridge's endpoint is a cut
vertex unless it has nothing else attached - which neither answer alone could
establish.

Repeated pairs are refused rather than tolerated, and the hint says why: the
walk skips the parent **by vertex**, not by edge, so a second edge between the
same pair would be invisible to it and the first would be reported as a bridge
it is not. That is a real limitation of this implementation, so it is stated at
the boundary instead of being silently mishandled inside.

### An undirected edge has one identity

The conformance check "event log describes the structure" failed here on
`edge 0-e3->2 is in the structure but not the log`. Neither the algorithm nor
the structure was wrong. `build [1 2 2 3 3 1 ...]` was logging the edge `3 1`
as a pointer from 3 to 1, in the order it was typed, while `getStructure`
normalised every edge to low-to-high and reported the same edge as 1 to 3. Two
names for one thing, so a replay of the log grew an edge the live structure
does not have.

This is the same rule as the treap pointers and the missing reading order, in a
form none of those took: **the log must be sufficient to draw the picture**
extends to naming things the way the picture names them. For a directed graph
the typed order *is* the identity and there is nothing to normalise; for an
undirected one it is an accident of input, and the log has to say which of the
two possible names it means. The fix was one canonical form in both places.
Worth noting that every hand-written expectation and the whole brute-force
property test passed while this was broken - only conformance, which compares
the log against the structure rather than either against arithmetic, could see
it.

### Two matchers that check each other

KMP and the Z algorithm are the same fact about a string written from opposite
ends. A **border** says "this prefix ends the way it begins"; a **Z value** says
"the beginning happens again here". Either can be converted into the other, and
that is worth having as a test rather than only as a remark: the Z plugin
derives borders from its own values, and the property test compares them against
what KMP computes independently, over 80 random words. Two algorithms written
from opposite directions agreeing is much stronger evidence than either one
matching a reference I also wrote.

Each is still checked against its own definition as well - borders by trying
every prefix-suffix pair, Z values by counting letters - because a shared
misunderstanding is the only way both could be wrong the same way, and the
definitions rule that out.

What they measure: KMP's search comes out at **R² 0.9998 with constant 1.98** on
the input a naive search does worst on, which is the guarantee stated exactly -
under two reads per letter, never more. The Z pass measures **R² 1.0000**.

Both put their links in the drawing rather than only in a returned array,
because in both cases the link is the algorithm. KMP's failure link says where a
mismatch resumes, and following those links from any position enumerates every
border of that prefix - which is literally what the inner loop does. The Z
plugin's link says which earlier position an answer was *copied* from, so the
picture distinguishes the entries that were free from the ones that were paid
for.

Two of my own expectations were wrong and the tests caught both. `aab` has no
border at all - it ends in b and begins with a - so `aabaaab`'s border chain is
just [3]. And in `aaaa` only two of the four Z values come free: position 1
cannot copy, because there is no interval yet when it is reached, and comparing
is precisely what *creates* the interval the two after it borrow from.

### Rabin-Karp: the matcher that can be wrong

KMP and the Z algorithm compare letters, so when they report a match there is
one. This is the first plugin here whose comparison is *evidence* rather than
proof - it compares a number, and numbers collide. The interesting design
question is therefore not how to make collisions rare but where to put the
consequence of one, and the answer is that **every hash hit is verified letter
by letter** before it is reported.

That makes the modulus a command rather than a constant. `modulus 1` makes every
hash collide, which turns the algorithm into the naive scan it is meant to
replace - and two checks pin down the pair of claims that matters: the reported
positions are **identical** under a hopeless modulus and a good one, while the
comparison count is not. The answer never depends on the hash; only the cost
does. A hash function is an optimisation, and a check that only ever runs with a
good modulus would never find out whether the code believed that.

Verification is checked three ways at once. The rolled window hash is compared
against the hash computed from scratch, which is the definition the roll claims
to equal; the positions are compared against a plain scan; and they are compared
against **both** exact matchers already in the repo. Four independent opinions
about the same question, over 240 searches, 55 of which had a hash lie to them.

The one bug in this algorithm that produces plausible wrong answers rather than
a crash is the sign of the intermediate. Removing the leaving letter can take
the running value negative, and a remainder of a negative number is negative in
this language, so the hash quietly stops matching itself. A check runs the roll
under modulus 101 over letters near the top of the alphabet, where that happens
on nearly every step, and asserts every hash is both correct and non-negative.

### Zero is the point, and a benchmark cannot measure it

The benchmark had to be changed, and the reason is a genuine limit on what the
event log observes. Cost here is counted in nodes touched. Run the pattern
`aaab` over a long run of `a` - the pair KMP is measured on - and with a large
modulus no window ever collides, so Rabin-Karp touches the pattern **zero**
times at every size. That is precisely its advantage: KMP touches the pattern
once per letter of text, and this touches it never.

But a flat zero is not a growth curve. Using it as the benchmark would have
measured nothing and reported the result as constant time, which is the same
dishonesty the heavy-light benchmarks were caught in earlier. So the zero is
asserted as a **check** - where a claim about a specific case belongs - and the
benchmark measures a text where the pattern occurs every second position, so
verification work genuinely scales: `2 * (n / 2) = n` comparisons, measured as
**O(n)**. The declared `O(n + m)` has two variables and so is skipped by the
complexity check, the same honest skip the graph plugins take.

The other thing this plugin needed was a redraw. Changing the modulus changes
every number in the picture, and the spine has no event meaning "this node's
value is different now" - every structure before this one was persistent or
append-only, so a value never changed in place. Re-emitting the allocations is
what the spine already means by a redraw, since `build` after `build` works the
same way, and conformance caught the first attempt: a `NodeReused` event carries
no value, so the replayed picture kept the old hashes while the live one showed
the new ones.

### Aho-Corasick: KMP with the pattern replaced by a set

Rabin-Karp's own opening paragraph claims that comparing a single number lets
one pass hunt for many patterns at once. This is the structure that actually
delivers it, and it is KMP with one phrase generalised. A failure link points at
the longest proper suffix of this state's string **that is also a prefix of some
word**; with one word the only prefixes are its own, so the links form a chain
and the picture is KMP's; with several they form a tree over a tree.

One consequence is worth stating as a fact about the algorithm rather than about
the code: the links have to be found **breadth-first**. A node's link is found
by following its parent's link and taking the same letter, so the parent's link
must already be known - and the parent is one level up. Depth order is not an
optimisation here, it is the only order in which the definition can be applied
at all.

Both link kinds are verified against their definitions, recomputed from the
published picture rather than from the plugin's own fields: every state's string
is read back down the trie, and its failure target is compared against trying
every suffix from the longest down. **60 word sets, 180 searches, 93 of them
finding more matches than there were words** - which is the case that matters,
because a word can end inside another. Occurrences are checked against a plain
scan and against KMP run once per word, which is precisely what this replaces.

### Counting is linear; listing cannot be

A text can contain a quadratic number of occurrences - `[a aa aaa]` over five
letters of `a` has twelve - and no algorithm can report more matches than it has
time to write down. Rather than declare one bound and quietly mean the other,
this splits them into two commands.

`count` keeps a precomputed number per state: how many words end at this state
or anywhere along its failure chain, which is one addition per state at build
time. Counting is then **one read per letter** whatever the words are, declared
`O(n)` and measured at **R² 1.0000, constant 1.33** - the 1.33 being the
fallbacks, which are amortised away against the letters that caused them.
`search` lists the occurrences, declared `O(n + z)`, and follows *output* links
so it steps once per match rather than once per letter of the current string.

The difference is not asserted, it is measured out of the event log: the same
automaton over the same five letters touches **7 nodes to count and 14 to
list**, and a check on a text with no matches at all confirms the two costs
become equal - which is what `O(n + z)` reduces to when z is zero.

### A role has to be known before the node is drawn

Conformance rejected the first version with `node 2 role: log says inner,
structure says word`. The trie was built by walking each word and allocating
states as it went, then marking the last state of each word as a word-ending -
and *ending a word* is part of what a state is. It changes the colour in the
picture, and the log carries a role on the event that brings a node into being.
Marking it afterwards meant a node was drawn as one thing and quietly became
another, which is exactly what the event log cannot express.

The fix is the pattern the stranding bugs kept needing, arrived at for a
different reason: **shape the structure before drawing any of it.** The trie is
now built in full, and only then does a second pass emit the allocations, with
each role already settled. It is the fourth or fifth time this has been the
answer, and the reason is always the same - the log describes what happened, so
nothing may happen before there is something true to say about it.

Two checks were also deleted rather than fixed. `build []` is refused by the
parser, which knows a list parameter cannot be empty, so the plugin's own guard
was unreachable - and an unreachable guard is worse than none, because nothing
would notice if it were wrong. The word-limit check had the mirror-image
problem: it built sixty-five names containing digits, which the parser refused
first, so it passed without ever reaching the limit it claimed to test.

### Suffix array: reading order had to go in the log

The first structure here that is neither a tree nor a graph - just n starting
positions, sorted. Sorting them is what makes searching cheap: the suffixes
beginning with a pattern are exactly the ones that sort together, so every
occurrence is one contiguous block and a search is a binary search that does
not care how many matches there are.

It is built by prefix doubling, which never compares two suffixes. Ranks from
one round become the "letters" of the next, so each round accounts for twice
as much of every suffix and no comparison looks at more than two numbers. The
LCP array is Kasai's method, and it sits on the **edges** between neighbours
rather than in a list beside them, because that is what it is - a measurement
between two suffixes, not a property of either.

Two things it exposed:

- **`order` was never in the event log.** It is on `StructureNode`, ten
  plugins set it, and none of it could ever be replayed - the drawing rebuilt
  from the log had no reading order at all. That is the "log must be sufficient
  to draw the picture" rule being broken repo-wide, and the BIT is the clearest
  victim: its own docstring says cells must be drawn in index order. `order`
  now travels with `NodeAllocated`, and the BIT logs it.
- **A linear layout stacks by depth**, and every suffix claimed depth 0. All
  six piled onto one point, and every edge between them was then dropped for
  having no length - which the demo's own union check caught as *5 edges exist
  at some step but are not in the union layout*. The smallest suffix now takes
  the largest depth, because a linear layout grows upward from zero.

### Euler tour: the encoding decided the algorithm

Heavy-light flattens a tree so a *path* is a few ranges, and cannot survive the
tree changing shape. This flattens a forest so a *subtree* is one range, and
exists to be cut apart and rejoined. Both are held as sequences; only this one
has to splice them.

The first attempt wrote each vertex down once and each edge twice. It is the
obvious encoding, it makes a tour readable, and **reroot is wrong on it**.
Rerooting is meant to be a rotation - split the sequence at v and swap the
halves - but a vertex entry has to sit where the walk first reaches that
vertex, and rotating changes which edge reaches it first. The old root's entry
ends up somewhere the walk has already been. Every other operation is built on
reroot, so the encoding decided the algorithm: entries are **edges only**, and
a vertex is written down in exactly one case, when it has no edges to stand
for it. An edge has no position to be wrong about, so the rotation is exact.

Two bugs found by two different checks, both of which had caught something
before:

- **"the event log describes the structure"** failed with *log yields 0 edges,
  structure reports 12*. Splitting and joining rearrange the treap constantly
  and none of it was being logged, so a replay showed a heap of disconnected
  entries. The same rule that caught the B+ tree's unlogged leaf chain.
- **"one tour per tree"** reported four. Logging the pointer changes had come
  with a guard - skip when the pointer is already what it should be - and that
  guard also skipped restoring the parent link. Merging detaches a subtree
  before handing it back, so "the pointer already says this" does not mean
  there is nothing to do: the child had just been orphaned and was about to be
  adopted by the same node again. The parent is now always restored and only
  the event is conditional.

### Link-cut: drawing what the structure is, not what it means

A link-cut tree is heavy-light made dynamic. Heavy-light cuts a tree into chains
once, by subtree size, and cannot survive the tree changing shape; this cuts a
forest into **preferred paths** chosen by what was asked about last, holds each
in a splay tree keyed by depth, and joins them with path-parent pointers. It is
the third answer in the repo to "what happens when the tree moves" - heavy-light
says nothing does, Euler tour tree keeps subtrees and connectivity, and this
keeps paths.

The design question that took the longest was what to draw. The obvious answer
is the forest it represents, and it is the wrong one: the represented forest is
what the structure *means*, and the splay forest is what it *is*. Draw the
meaning and every rearrangement is invisible, which would leave the most
interesting thing about the structure - that a query restructures the storage
without touching the tree - impossible to see. So the picture is the splay
forest: solid edges are splay children, so a preferred path is a connected
component of them, and the straight ones are path-parents.

That decision has to be paid for, because a picture of the storage is only
useful if the tree can be recovered from it. **A check does exactly that.** It
takes `getStructure()`, walks each splay tree in-order to get its path from
shallowest to deepest, reads each vertex's parent as the entry before it, takes
the first entry's parent from the splay root's path-parent, and compares the
whole forest against a plain parent array - after every operation, in every
random trial. A drawing that cannot be turned back into the tree it stands for
is not a drawing of it, however pretty. One check makes the point directly:
asking about two different vertices in turn changes the drawn edges and leaves
the recovered forest identical.

Correctness is checked against a parent array with every question answered by
walking, and connectivity is checked a second time against the **Euler tour
tree**, which stores the same forest as a sequence and has no notion of a root
at all. **40 forests, 371 changes - 198 cuts, 76 links, 120 everts.**

### Why nothing in a link-cut node is drawn except its pointers

Every field a link-cut node carries is mutable: subtree aggregates change on
every rotation, and which preferred path a vertex belongs to changes on every
access. None of them appear in the picture, and that is not an oversight.

The spine has no event meaning **"this node's field changed"** - only allocate,
delete, and pointer-set. Every structure before these last two was persistent,
where a change makes a new node by path copying, or append-only. Rabin-Karp hit
the same wall a moment earlier and worked around it by re-emitting its
allocations as a redraw, which is affordable for a whole pattern once but not
for O(log n) nodes on every single query.

So the aggregates stay internal - `path` reads them at the splay root after an
access, and a check compares them against adding the path up by hand - and
preferred paths are shown by the edge structure rather than by `group`, which
would have to change on every access. The published node is `id`, `label`,
`value`, `role`, `slot`, and nothing else that can move. Only pointers change,
and pointers are exactly what the log can say.

This is now the third plugin to want a field update, and the case for adding one
to the spine is real. It has not been added: it touches the reducer, conformance,
both renderers and every explainer, and that is a change to argue for before
making, not one to slip in behind a plugin.

### Evert: a lazy bit that could not be drawn

The textbook link-cut tree reverses a path with a lazy bit on each splay node,
pushed down as the tree is walked, which makes `evert` cost the same as
everything else. That bit is exactly the mutable field the log cannot describe -
and unlike an aggregate, it is not internal bookkeeping: a pending reversal
means the drawn left and right children are the wrong way round, so the picture
would show a path running the wrong direction and the in-order reading that
recovers the forest would produce a reversed tree.

The choice was between a picture that lies and an operation that costs more.
This reverses the pointers eagerly instead, so `evert` costs the length of the
path rather than a logarithm, and is **declared `O(n)`** with the reason at the
call site. Everything else in the structure keeps its bound. It is worth being
explicit that this is a real limitation and not a subtlety: a link-cut tree with
a linear `evert` is not the one in the literature.

### A stride is not a random sequence

`path` measured **R² 0.8886** against `O(log n)` at first, and the fit got
*worse* as the sizes grew - which means the measured cost was growing more
slowly than a logarithm. The probes were `i * 7919 mod n`, the same trick that
fixed the splay benchmark, and here it was measuring the wrong thing again in a
subtler way. Over 2n queries that sequence visits every vertex exactly twice **in
the same order both times**, and adapting to a repeating access sequence is what
a splay tree is *for*. The benchmark was measuring static optimality and
reporting it as the general case.

Pseudo-random positions from a seeded generator give **R² 0.9872**, and the
measurements rise by about 0.7 per doubling, which is what a logarithm looks
like. The first attempt at that generator used the usual large multiplier and
was silently broken: `2^31 * 1103515245` is far past the point where a double is
exact, so it collapsed to a single value, asked about the same vertex every
time, and found it already at the root - reporting `path` as costing **zero**
visits at every size. A benchmark that measures nothing does not look like an
error, it looks like a fast operation, which is the reason to read the raw
numbers rather than only the fitted verdict.

### Colour by group, not only by provenance

A node's colour has always come from `origin` - which generation allocated it.
That is the right thing to see in a persistent structure, and useless in one
without history, where every node has origin 0 and the whole picture is one
colour.

Two plugins wanted the same thing and were refused it. Strongly connected
components wanted to colour by component; heavy-light decomposition wants to
colour by chain, and a decomposition you cannot see is not one you can reason
about. Repurposing `origin` was rejected both times - it means *when*, and
overloading it to mean *what it is part of* would make two unrelated things
indistinguishable in the model.

So `group` is its own optional field, carried through `StructureNode`,
`NodeAllocated`, `SceneNode` and the renderer. It takes the same palette,
because no structure needs both at once: a partition is interesting exactly
when there is no history to show.

### Heavy-light: two benchmarks that were measuring the wrong thing

The decomposition itself was straightforward. What it cost was two honest
measurements, and both failures were in this repository's own tests rather
than in the algorithm.

Declaring `O(log² n)` meant adding that growth class, and adding it
immediately reclassified the **splay tree**: its `access` had been declared
`O(log n) amortised` and now measured `log² n` at a better fit. Chasing that
down, the splay's benchmark was doing two wrong things at once. It capped the
probe count at 48 regardless of `n`, so at n = 256 the (n log n)/m startup
term - not the amortised bound - was most of what it measured. And its probe
keys swept the tree in ascending order, which a splay tree does in O(1)
amortised, so the pattern that did run was measuring a real property but not
the declared one. Probes proportional to `n`, stepping by a prime, put it at
R² 0.954 for `log n`.

Then HLD's own `path` measured `O(1)`. Two separate causes:

- The implementation emitted a `NodeVisited` for every vertex in every range,
  which is O(path length) work inside an operation whose entire purpose is not
  to touch those vertices. It now emits the two ends of each range.
- The benchmark probed the path between two leaves half the tree apart. That
  is the longest path by vertices and not by *chains*: both ends sat on the
  same heavy spine, so it crossed two chains at every size. A path down the
  all-right spine crosses a light edge per level, and measures R² **1.0000**
  against `log n`.

What is declared is what the log can honestly show: the number of contiguous
ranges. The second logarithm - the segment tree query inside each range -
happens in a plain array with no nodes to visit, so no event can report it.

### Red-black: the balance that needs no parent pointer

The AVL tree keeps a height on every node; this one keeps a single bit. What
makes it worth having here is not the algorithm but how it is written.

Textbook red-black insertion walks back **up** from the new leaf through parent
pointers, recolouring and rotating. A persistent tree has no parent pointers to
walk, and cannot have them: a node is shared by every version that still
contains it, so it has no single parent to point at. The functional
formulation - a `balance` that takes a colour and two subtrees and returns the
repaired shape - needs none, so the awkward constraint and the natural
implementation happen to agree.

Deletion carries a shortfall rather than a pointer. Removing a black node
leaves its path one black short, and that is carried up as two colours that
exist for the length of one operation and are never stored: **double black**
and **negative black**. A check asserts no allocated node ever has one - a
transient colour reaching a node would mean the repair silently gave up.

Shapes are drafted before anything is allocated, for the reason the treap
established: rebalancing discards intermediate arrangements, and a node
allocated into one it then discards is stranded. Drafting first means the
discarded arrangement was never allocated. An untouched subtree stays a bare
`NodeId` in the draft, which is also what keeps the sharing exact.

One thing the tests corrected, and it was the test: `getStructure().roots`
drops null roots, because a version emptied by its last erase has no node to
point at. Matching roots to versions **by index** therefore silently shifts
once any version is empty. They are matched by order among the non-empty
versions instead, which turned out to be the stronger check anyway - it
compares every version on every write rather than just the newest.

### The one thing it did not handle: direction

`StructureEdge` has always run `from` to `to`, so the model knew which way every pointer pointed.
Nothing drew it. In a tree that is fine - the parent is simply the one higher up, and position says
everything. Two vertices side by side have no such cue, so `1 -> 2` and `2 -> 1` were the same
picture.

The fix is one optional field, `directed`, carried the whole way down: `StructureEdge` ->
`PointerSet` -> `ScenePointer` -> `PositionedEdge`. It goes in the **log**, not only in
`getStructure()`, for the reason the B+ tree's leaf chain established: the log has to be sufficient
to draw the picture, or scrubbing backwards shows something the log never said.

Rendering it forced a second change. A hierarchy edge is a bezier that leaves and arrives
*vertically*, because it always descends - so an arrowhead on one would point straight down no
matter where the target actually was. Links are now drawn as **straight lines between box
boundaries**, which is both what a graph conventionally looks like and what makes an arrowhead
mean something. Hierarchy keeps its curve.

`scc` and `topo` are then the same question from either side. A topological order exists exactly
when no component holds more than one vertex, and the components that do are the knots blocking it.
Tarjan is checked against **Kosaraju** - a different route to the same answer, so a slip in
low-link bookkeeping has nowhere to hide - and separately against mutual reachability computed from
`reach` alone.

One thing the tests corrected: `topo` first reported the leftover vertices as `inCycles`, which is
wrong. A vertex *downstream* of a cycle is stuck too, because nothing in the cycle is ever emitted
to free it. The field is `unplaced`, and it counts everything a cycle can reach.

One check needed loosening rather than the code. `bfs` declares `O(V + E)`, and two variables
cannot be fitted against one axis - the complexity parser says so deliberately. The measured-cost
check now reports that as **skipped** rather than failed: there is nothing to agree or disagree
with, and saying so beats both failing and quietly passing.

### The first edges that carry data

Everything before Dijkstra put its information in nodes. A shortest path is decided by what the
*edges* are worth, and `StructureEdge` had nowhere to put a number.

The fix was not to add one field. `SceneNode` already carried `children` and `links` as two maps
keyed the same way, and a weight would have made a third - which is the point at which the shape is
wrong rather than merely growing. Both collapsed into one `pointers` map of
`{ to, kind, weight? }`. Six call sites, and every suite passed unchanged afterwards.

The weight travels in the log, on `PointerSet`, for the same reason the B+ tree's leaf chain had to:
a value the picture shows and the log does not carry is a value replay cannot rebuild. The renderer
draws it at the edge midpoint, stroked in the surface colour so a line never crosses its own number.

**Dijkstra selects by scanning, not with a heap, and that is deliberate.** Every vertex the scan
reads is emitted as a read, so the O(V²) is visible in the cost chart rather than asserted - and the
case for a heap is made by the curve. The benchmark stops at 64 vertices because a quadratic scan
that files an event per read would otherwise log sixteen thousand of them to measure one point.

A negative cost is refused rather than quietly mishandled, with the reason in the hint: Dijkstra
settles a vertex once and never revisits it, which is exactly what a negative edge would break.

Correctness is checked against **a different algorithm**, not a reimplementation of the same one -
repeated relaxation over every edge, which arrives at the same distances by a route that shares no
code. Twenty-nine graphs, eighty-nine sources. Every route `path` reports is also walked edge by
edge to confirm it costs what it claims.

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

A plugin declares a `benchmark` - how to build itself at a given size, and which command to time -
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
looser 0.939 is what *expected* looks like next to a guarantee - which is the distinction the word
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
