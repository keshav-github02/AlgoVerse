# AlgoVerse

> The VS Code for Algorithms and Data Structures.

An interactive simulation platform for understanding algorithms and data structures from the
inside. Not a gallery of animations — a debugger. Build a structure, run an operation, then step
through every internal change, inspect memory, scrub the timeline, and compare versions.

## Status

**Early development.** The engine core and the first plugin work; there is no user interface yet.

Working today: the event log and time travel, the spec-driven command parser, the plugin contract
with its conformance kit, a persistent segment tree that runs `build`, `update`, `query` and
`compare`, and a stack that exists to keep the contract honest.

```
pnpm install
pnpm check          # type-check, then every package's property tests
pnpm demo           # render real plugin output to demo/index.html
```

Requires Node 22.6 or newer. Sources run directly as TypeScript, with no build step.

`pnpm demo` drives the real engine end to end — parse, execute, file events, replay, lay out,
render — and writes a scrubbable page. Open `demo/index.html` in a browser and step through every
event, or jump operation by operation. Each frame is reconstructed from the event log, not read out
of the plugin.

There is also a self-contained layout prototype at `spike/segment-tree-visual/index.html`, kept for
comparison. It predates the engine and hardcodes its data.

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

| Package | Responsibility | State |
| --- | --- | --- |
| `core` | Event types, event log, pure reducer, keyframes, playback, command parser, layout, seeded RNG | working |
| `plugin-sdk` | The algorithm plugin contract, plus a conformance kit every plugin runs | working |
| `plugins/*` | One package per algorithm or data structure | segment tree + stack |
| `renderer` | Turns a positioned scene into pixels. Knows nodes, edges, camera — nothing else | SVG working |
| `ui` | Reusable interface components | not started |

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
