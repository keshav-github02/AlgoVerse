# AlgoVerse

> The VS Code for Algorithms and Data Structures.

An interactive simulation platform for understanding algorithms and data structures from the
inside. Not a gallery of animations - a debugger. Build a structure, run an operation, then step
through every internal change, inspect memory, scrub the timeline, and compare versions.

## Status

**Early development, but usable.** The application runs: pick a structure, type commands, and step
through every internal change.

```
pnpm install
pnpm dev            # the app, at http://localhost:5173
pnpm check          # type-check, then every package's property tests
pnpm demo           # render a scrubbable page to demo/index.html
```

Requires Node 22.6 or newer. Packages run directly as TypeScript with no build step; only the
application is bundled.

In the app: choose a structure on the left, type a command below the canvas, then scrub the
timeline at the top. `Space` plays and pauses, arrow keys step, `Shift` with them jumps operation to
operation. Click a node to inspect it. Every frame is reconstructed from the event log rather than
read out of the plugin, so scrubbing backwards shows what a node *was*, not what it became.

`pnpm demo` writes the same thing to a standalone page with no server, at `demo/index.html`.

There is also an early layout prototype at `spike/segment-tree-visual/index.html`, kept for
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

Four packages, split along the seams that actually matter:

| Package | Responsibility | State |
| --- | --- | --- |
| `core` | Event types, event log, pure reducer, keyframes, playback, command parser, layout, seeded RNG | working |
| `plugin-sdk` | The algorithm plugin contract, plus a conformance kit every plugin runs | working |
| `plugins/*` | One package per algorithm or data structure | segment tree, BIT, treap, trie, BST, stack |
| `renderer` | Turns a positioned scene into pixels. Knows nodes, edges, camera - nothing else | SVG working |

Plus `apps/web`, the application shell: sidebar, canvas, console, inspector, statistics, and the playback timeline.

Three layers, not two: a **plugin** declares semantic structure and a layout hint, **core/layout**
turns that into coordinates, and the **renderer** draws coordinates. Plugins stay free of pixel
math; the renderer stays free of algorithm knowledge.

The simulation engine contains no algorithm-specific logic, and the console derives its grammar,
autocomplete, and help text from each plugin's declared commands. Adding an algorithm means
adding a plugin - no engine changes.

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
│   └── plugins/
├── docs/
└── spike/                   throwaway prototypes, deleted once superseded
```

## Roadmap

| Phase | Scope |
| --- | --- |
| 1 | Persistent segment tree - build, update, query, version timeline, version comparison, memory sharing, playback, statistics, explanations |
| 2 | Persistent BIT, treap, trie and BST — **complete** |
| 3 | AVL, red-black, B-tree, B+ tree, splay |
| 4 | Graphs - DFS, BFS, Dijkstra, Prim, Kruskal, SCC, bridges, articulation points |
| 5 | Strings - KMP, Rabin-Karp, Z algorithm, Aho-Corasick, suffix array, suffix tree, suffix automaton |
| 6 | Heavy-light decomposition, Euler tour tree, link-cut tree, merge sort tree, wavelet tree, Li Chao tree |

Phase 1 also ships a deliberately trivial second plugin. One plugin proves nothing about an
abstraction; two expose most of its leaks.

## Technology

In use today: React, TypeScript, Vite, Tailwind CSS and Zustand, on pnpm workspaces. Rendering is
hand-written SVG behind a renderer interface. Tests are plain TypeScript files run directly by Node
- every package exposes `check`.

Deliberately not yet adopted, to keep the dependency surface honest:

| Planned | Why not yet |
| --- | --- |
| Turborepo | Nothing takes long enough to need caching |
| Vitest | The `check` scripts run in under a second with no runner |
| Playwright | Worth adding once the interface stops changing weekly |
| shadcn/ui | Only a handful of controls exist so far |
| D3 | Layout is hand-written; `d3-hierarchy` becomes worthwhile at force-directed graphs |

Phase 1 runs entirely in the browser. A session autosaves to local storage, and **share** puts the
whole thing in a link - the commands, not the structure, so replaying restores the full timeline. A
backend arrives only when accounts or collaboration require one.

## Contributing

The plugin contract is the extension point. A new algorithm should need no changes to `core`,
`renderer`, or `apps/web` - if it does, the contract is wrong and that is the bug worth fixing.

Engine changes need tests. Two kinds carry the weight: golden-file snapshots of event logs, and
property tests that check a structure against a naive reference model over random operation
sequences.

## License

Not yet chosen.
