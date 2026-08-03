# AlgoVerse

> The VS Code for Algorithms and Data Structures.

An interactive simulation platform for understanding algorithms and data structures from the
inside. Not a gallery of animations — a debugger. Build a structure, run an operation, then step
through every internal change, inspect memory, scrub the timeline, and compare versions.

## Status

**Early development.** Phase 1 (persistent segment tree) is not yet implemented. The only
runnable artifact today is a layout spike:

```
spike/segment-tree-visual/index.html
```

Open it directly in a browser — it is a single self-contained file with no build step and no
dependencies. It renders three versions of a persistent segment tree and shows which nodes each
update allocates versus reuses.

There is no package to install yet. Setup instructions will land with the monorepo scaffold.

## The core idea

Algorithms never touch the UI. They emit events.

```
Operation  →  Event log  →  Reducer  →  Scene  →  Renderer
```

An operation runs to completion synchronously and returns its full event log. Nothing sleeps,
nothing animates itself. Playback is then pure presentation: the visual state at step *N* is
`fold(events[0..N])` through a pure reducer, with periodic keyframes so scrubbing stays fast.

That single decision is what makes stepping backward, timeline scrubbing, replay, saving, and
sharing all fall out of the same mechanism instead of needing four separate implementations.

## Architecture

Five packages, split along the seams that actually matter:

| Package | Responsibility |
| --- | --- |
| `core` | Event types, event log, pure reducer, keyframes, playback clock, timeline, memory model, statistics, layout, seeded RNG |
| `plugin-sdk` | The algorithm plugin contract, plus a conformance test kit every plugin runs |
| `renderer` | Turns a positioned scene into pixels. Knows nodes, edges, camera, animation — nothing else |
| `ui` | Reusable interface components |
| `plugins/*` | One package per algorithm or data structure |

Plus `apps/web`, the application shell.

Three layers, not two: a **plugin** declares semantic structure and a layout hint, **core/layout**
turns that into coordinates, and the **renderer** draws coordinates. Plugins stay free of pixel
math; the renderer stays free of algorithm knowledge.

The simulation engine contains no algorithm-specific logic, and the console derives its grammar,
autocomplete, and help text from each plugin's declared commands. Adding an algorithm means
adding a plugin — no engine changes.

See [docs/architecture.md](docs/architecture.md) for the plugin contract, the event model, and
the reasoning behind each decision.

## Repository layout

```
algoverse/
├── apps/
│   └── web/                 application shell
├── packages/
│   ├── core/
│   ├── plugin-sdk/
│   ├── renderer/
│   ├── ui/
│   └── plugins/
├── docs/
└── spike/                   throwaway prototypes, deleted once superseded
```

## Roadmap

| Phase | Scope |
| --- | --- |
| 1 | Persistent segment tree — build, update, query, version timeline, version comparison, memory sharing, playback, statistics, explanations |
| 2 | Persistent BIT, trie, BST, treap |
| 3 | AVL, red-black, B-tree, B+ tree, splay |
| 4 | Graphs — DFS, BFS, Dijkstra, Prim, Kruskal, SCC, bridges, articulation points |
| 5 | Strings — KMP, Rabin-Karp, Z algorithm, Aho-Corasick, suffix array, suffix tree, suffix automaton |
| 6 | Heavy-light decomposition, Euler tour tree, link-cut tree, merge sort tree, wavelet tree, Li Chao tree |

Phase 1 also ships a deliberately trivial second plugin. One plugin proves nothing about an
abstraction; two expose most of its leaks.

## Technology

React, TypeScript, Vite, Tailwind CSS, shadcn/ui, Zustand. pnpm workspaces with Turborepo.
Vitest for unit and property tests, Playwright for end-to-end once there is a UI worth testing.
Rendering is SVG behind a `Renderer` interface, with D3 used for layout math only.

Phase 1 runs entirely in the browser: saves go to local storage, shared simulations are
compressed into the URL. A backend arrives when accounts or collaboration require one.

## Contributing

The plugin contract is the extension point. A new algorithm should need no changes to `core`,
`renderer`, or `apps/web` — if it does, the contract is wrong and that is the bug worth fixing.

Engine changes need tests. Two kinds carry the weight: golden-file snapshots of event logs, and
property tests that check a structure against a naive reference model over random operation
sequences.

## License

Not yet chosen.
