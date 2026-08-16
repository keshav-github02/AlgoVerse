/**
 * Renders replayed engine output to a page you can scrub.
 *
 *     node packages/renderer/src/demo.ts
 *     start demo\index.html
 *
 * Nothing here is part of the product. It drives the real engine - parse,
 * execute, file events, replay, lay out, render - and writes the result to
 * disk so the pipeline can be inspected before there is an application shell.
 *
 * Every frame is drawn from `sceneToStructure(playback.scene())`, never from
 * the plugin. What you scrub through is a reconstruction.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Playback, Timeline, createRng, describeEvent, layout, parseCommand, sceneToStructure,
  type LayoutHint, type NodeId, type ParsedCommand, type SimEvent,
  type StructureEdge, type StructureNode,
} from '@algoverse/core';
import { SCENE_STYLES, escapeXml, renderScene } from './svg.ts';
import { persistentSegmentTree } from '@algoverse/plugin-persistent-segment-tree';
import { persistentBit } from '@algoverse/plugin-persistent-bit';
import { fenwickRange } from '@algoverse/plugin-fenwick-range';
import { persistentTreap } from '@algoverse/plugin-persistent-treap';
import { persistentTrie } from '@algoverse/plugin-persistent-trie';
import { persistentBst } from '@algoverse/plugin-persistent-bst';
import { persistentAvl } from '@algoverse/plugin-persistent-avl';
import { persistentBtree } from '@algoverse/plugin-persistent-btree';
import { persistentRbt } from '@algoverse/plugin-persistent-rbt';
import { persistentSplay } from '@algoverse/plugin-persistent-splay';
import { persistentBplus } from '@algoverse/plugin-persistent-bplus';
import { directedGraph } from '@algoverse/plugin-directed-graph';
import { graph } from '@algoverse/plugin-graph';
import { eulerTour } from '@algoverse/plugin-euler-tour';
import { hld } from '@algoverse/plugin-hld';
import { liChao } from '@algoverse/plugin-li-chao';
import { shortestPath } from '@algoverse/plugin-shortest-path';
import { stack } from '@algoverse/plugin-stack';

/**
 * One step is not a picture, it is a membership: which nodes and edges are
 * there, and which have been visited. The picture is drawn once.
 */
interface Step {
  readonly nodes: readonly number[];
  readonly edges: readonly string[];
  readonly visits: readonly number[];
  readonly note: string;
}

interface Panel {
  readonly heading: string;
  readonly caption: string;
  readonly session: readonly { readonly line: string; readonly out: string }[];
  readonly svg: string;
  readonly steps: readonly Step[];
  readonly marks: readonly { readonly index: number; readonly label: string }[];
}

function drive(
  plugin: typeof persistentSegmentTree,
  script: readonly string[],
  hint: LayoutHint,
): Panel {
  const inst = plugin.createInstance({ rng: createRng(1) });
  const timeline = new Timeline();
  const session: { line: string; out: string }[] = [];
  const all: SimEvent[] = [];
  const commands: ParsedCommand[] = [];

  for (const line of script) {
    const parsed = parseCommand(line, plugin.commands);
    if (!parsed.ok) {
      session.push({ line, out: `${parsed.error.code}: ${parsed.error.message}` });
      continue;
    }
    const r = inst.execute(parsed.command);
    session.push({ line, out: r.ok ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}` });
    timeline.append(r.events, line);
    if (r.events.length > 0) commands.push(parsed.command);
    all.push(...r.events);
  }

  const playback = new Playback(timeline);
  /*
   * An edge is identified by where it starts, which slot it is, *and* where it
   * points. Leaving the target out looks like the identity of a pointer and is
   * not the identity of a line: a slot that is retargeted would then have one
   * element standing for two different edges, drawn to whichever target the
   * union happened to end on.
   */
  const keyOf = (e: { readonly from: NodeId; readonly slot: string; readonly to: NodeId }): string =>
    `${e.from}:${e.slot}:${e.to}`;

  /**
   * Layout is computed once, over everything that exists at any step, and
   * reused for every one of them. Laying out each step independently would
   * make surviving nodes jump sideways whenever a neighbour appeared, which
   * reads as chaos rather than as an algorithm running.
   *
   * The union is walked, not taken from the final state. A pointer that is
   * cleared on the way - the stack clears the popped node's `below` before it
   * goes - is absent at the end, so the end is not a superset of the middle.
   */
  const unionNodes = new Map<NodeId, StructureNode>();
  const unionEdges = new Map<string, StructureEdge>();
  const unionRoots = new Set<NodeId>();
  const retargeted = new Set<string>();
  for (let step = 0; step <= timeline.length; step += 1) {
    playback.seek(step);
    const live = sceneToStructure(playback.scene(), hint);
    for (const n of live.nodes) if (!unionNodes.has(n.id)) unionNodes.set(n.id, n);
    for (const r of live.roots) unionRoots.add(r);
    for (const e of live.edges) {
      const seen = unionEdges.get(keyOf(e));
      // One slot pointing at two different nodes over time would need two
      // elements to draw, not one. Nothing does it yet; say so if it starts.
      if (seen !== undefined && seen.to !== e.to) retargeted.add(keyOf(e));
      unionEdges.set(keyOf(e), e);
    }
  }
  if (retargeted.size > 0) {
    console.log(`  WARN ${plugin.meta.name}: ${retargeted.size} slots are retargeted, so one ` +
      `element has to stand for two edges`);
  }

  const stable = layout({
    layout: hint,
    nodes: [...unionNodes.values()],
    edges: [...unionEdges.values()],
    roots: [...unionRoots],
  });

  /** The plugin's own words where it has them, the generic ones where it does not. */
  const explainAt = (step: number): string => {
    const event = timeline.eventAt(step - 1);
    if (event === undefined) return 'ready';
    const which = timeline.marks.findIndex((m) => step <= m.index);
    const command = which === -1 ? null : commands[which] ?? null;
    return plugin.explain?.(event, { after: playback.scene(), command, step })
      ?? describeEvent(event);
  };

  /*
   * Every element is drawn once, over the whole timeline, and each step says
   * which of them are present. Emitting a separate picture per step and
   * swapping them is a flipbook: nothing can move, because the element that
   * leaves and the element that arrives are different elements. Given one
   * element with a lasting identity, appearing and leaving become a class
   * toggle, and CSS does the rest.
   */
  const drawable = new Set(stable.edges.map(keyOf));

  const steps: Step[] = [];
  const undrawable = new Set<string>();
  for (let step = 0; step <= timeline.length; step += 1) {
    playback.seek(step);
    const live = sceneToStructure(playback.scene(), hint);
    const present = new Set<NodeId>(live.nodes.map((n) => n.id));
    const keys = live.edges.map(keyOf);
    // An edge the union never knew about could never be drawn, at any step.
    for (const k of keys) if (!drawable.has(k)) undrawable.add(k);
    steps.push({
      nodes: [...present],
      edges: keys.filter((k) => drawable.has(k)),
      visits: [...playback.scene().visits.keys()].filter((id) => present.has(id)),
      note: `${String(step).padStart(2, '0')}/${timeline.length}  ${explainAt(step)}`,
    });
  }
  if (undrawable.size > 0) {
    console.log(`  WARN ${plugin.meta.name}: ${undrawable.size} edges exist at some step but are ` +
      `not in the union layout, so they can never be drawn`);
  }

  const opening = steps[steps.length - 1] as Step;
  const shown = new Set<number>(opening.nodes);
  const svg = renderScene(stable, {
    title: `${plugin.meta.name}, every node the run ever allocates`,
    highlight: opening.visits as readonly NodeId[],
    // The page opens on the last step, so anything gone by then starts faded.
    off: stable.nodes.map((n) => n.node.id).filter((id) => !shown.has(id)),
  });

  const final = sceneToStructure(playback.scene(), hint);
  return {
    heading: plugin.meta.name,
    caption: `${timeline.length} events · ${final.nodes.length} live nodes · ` +
      `${final.edges.filter((e) => e.reused).length} pointers into reused memory · ` +
      `layout "${hint}" · ${Math.round(stable.width)}x${Math.round(stable.height)}px`,
    session,
    svg,
    steps,
    marks: timeline.marks.map((m) => ({ index: m.index, label: m.label })),
  };
}

const panels: readonly Panel[] = [
  drive(persistentSegmentTree,
    ['build [3 1 4 1 5 9 2 6]', 'update v0 3 10', 'apply v1 1 6 4', 'query v2 2 5', 'kth v2 20'], 'dag'),
  drive(persistentBit, ['build [3 1 4 1 5 9 2 6]', 'add v0 3 5', 'range v1 2 6', 'kth v1 20'], 'dag'),
  drive(fenwickRange, ['build [1 1 1 1 1 1 1 1]', 'apply v0 3 5 10', 'range v1 3 5'], 'dag'),
  drive(persistentTreap, ['build [5 2 8 1 9]', 'insert v0 6', 'erase v1 2'], 'dag'),
  drive(persistentTrie, ['build [cat car card dog]', 'insert v0 care'], 'dag'),
  drive(persistentBst, ['build [1 2 3 4 5 6]', 'find v0 6'], 'dag'),
  drive(persistentAvl, ['build [1 2 3]', 'insert v2 4', 'insert v3 5'], 'dag'),
  drive(persistentRbt, ['build [1 2 3 4 5]', 'insert v0 6', 'erase v1 3'], 'dag'),
  drive(persistentBtree, ['build [1 2 3]', 'insert v0 4', 'insert v1 5'], 'dag'),
  drive(persistentSplay, ['build [1 2 3 4 5]', 'access v0 1', 'access v1 3'], 'dag'),
  drive(persistentBplus, ['build [1 2 3 4 5 6 7 8]', 'range v0 3 7'], 'dag'),
  drive(graph, ['build [1 2 1 3 2 4 2 5 3 6]', 'bfs 1'], 'force'),
  drive(directedGraph, ['build [1 2 2 3 3 1 3 4 4 5]', 'scc'], 'force'),
  drive(shortestPath, ['build [1 2 4 2 3 1 1 3 9 3 4 2]', 'path 1 4'], 'force'),
  drive(hld, ['build [1 2 1 3 2 4 2 5 3 6 5 7]', 'path 7 6'], 'dag'),
  drive(eulerTour, ['build [1 2 1 3 2 4 2 5]', 'cut 1 2', 'link 3 4'], 'dag'),
  drive(liChao, ['build 0 15', 'add v0 2 0', 'add v1 -1 20', 'add v2 0 8', 'query v3 12'], 'dag'),
  drive(stack, ['push 3', 'push 7', 'push 1', 'pop', 'push 9'], 'linear'),
];

const panelHtml = panels.map((p, i) => `  <section data-panel="${i}">
    <h2>${escapeXml(p.heading)}</h2>
    <p class="caption">${escapeXml(p.caption)}</p>
    <div class="session">${p.session.map((s) =>
      `<div class="cmd">&gt; ${escapeXml(s.line)}</div><div class="res">  ${escapeXml(s.out)}</div>`).join('')}</div>
    <div class="controls">
      <button data-act="first" aria-label="First step">|&lt;</button>
      <button data-act="prevMark" aria-label="Previous operation">&laquo;</button>
      <button data-act="prev" aria-label="Previous step">&lsaquo;</button>
      <button data-act="play" aria-label="Play or pause">play</button>
      <button data-act="next" aria-label="Next step">&rsaquo;</button>
      <button data-act="nextMark" aria-label="Next operation">&raquo;</button>
      <button data-act="last" aria-label="Last step">&gt;|</button>
      <input type="range" min="0" max="${p.steps.length - 1}" value="${p.steps.length - 1}"
             aria-label="Step" />
      <span class="note"></span>
    </div>
    <div class="stage">${p.svg}</div>
  </section>`).join('\n');

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AlgoVerse - replayed engine output</title>
<style>
:root {
  --bg:#f1f4f7; --panel:#fff; --line:#d3dbe3; --text:#171f27; --dim:#596775; --faint:#8695a3;
  --av-node-bg:#fff; --av-text:#171f27; --av-faint:#8695a3;
  --av-c0:#2c63c9; --av-c1:#9c6612; --av-c2:#8b3aa3; --av-c3:#177a52; --av-c4:#b1442e; --av-c5:#3d6a80;
  --av-mono: ui-monospace, "Cascadia Mono", Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg:#0e1216; --panel:#151b21; --line:#26313b; --text:#dbe3eb; --dim:#8494a3; --faint:#63707c;
    --av-node-bg:#1a222a; --av-text:#dbe3eb; --av-faint:#63707c;
    --av-c0:#5b93f0; --av-c1:#e3a94a; --av-c2:#c878dc; --av-c3:#4bc38c; --av-c4:#e8795e; --av-c5:#7fa8c4;
  }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); padding:28px 24px 48px;
  font:14px/1.5 system-ui, "Segoe UI", sans-serif; }
main { max-width:1200px; margin:0 auto; display:flex; flex-direction:column; gap:22px; }
h1 { margin:0; font-size:21px; font-weight:600; letter-spacing:-.015em; }
.sub { margin:0; color:var(--dim); max-width:72ch; }
section { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
h2 { margin:0 0 4px; font-size:15px; font-weight:600; }
.caption { margin:0 0 12px; color:var(--faint); font-size:12px; font-family:var(--av-mono); }
.session { margin:0 0 14px; padding:10px 12px; background:var(--bg); border-radius:6px;
  font-family:var(--av-mono); font-size:12px; overflow-x:auto; }
.session div { white-space:pre; }
.session .res { color:var(--dim); padding-bottom:5px; }
.controls { display:flex; align-items:center; gap:6px; margin-bottom:12px; flex-wrap:wrap; }
.controls button { font:12px var(--av-mono); background:var(--bg); color:var(--text);
  border:1px solid var(--line); border-radius:5px; padding:4px 9px; cursor:pointer; min-width:30px; }
.controls button:hover { border-color:var(--faint); }
.controls button:focus-visible { outline:2px solid var(--av-c0); outline-offset:1px; }
.controls input[type=range] { flex:1 1 200px; min-width:140px; accent-color:var(--av-c0); }
.controls .note { font:11.5px var(--av-mono); color:var(--dim); min-width:26ch; }
.stage { overflow-x:auto; }
.stage svg { display:block; width:100%; height:auto; }
${SCENE_STYLES}
</style>
</head>
<body>
<main>
  <h1>AlgoVerse - replayed engine output</h1>
  <p class="sub">Every frame below is reconstructed from the event log, not read out of the plugin.
  Scrub and you are folding events through the reducer. Colour is provenance &mdash; which
  generation allocated a node. Dashed pointers reach into reused memory. Layout is computed once
  over every node that ever exists, so nodes do not jump as the structure grows.</p>
${panelHtml}
</main>
<script>
const NOTES = ${JSON.stringify(panels.map((p) => p.steps.map((f) => f.note)))};
const STEPS = ${JSON.stringify(panels.map((p) => p.steps.map((f) => [f.nodes, f.edges, f.visits])))};
const MARKS = ${JSON.stringify(panels.map((p) => p.marks.map((m) => m.index)))};
/* Slower than the old flipbook on purpose: a step that lasts less time than the
   150ms transition cuts its own motion short, and the page reads as a stutter. */
const RATE = 200;
document.querySelectorAll('section[data-panel]').forEach((section) => {
  const i = Number(section.dataset.panel);
  const range = section.querySelector('input[type=range]');
  const note = section.querySelector('.note');
  const playBtn = section.querySelector('[data-act=play]');
  const nodeEls = [...section.querySelectorAll('[data-node]')];
  const edgeEls = [...section.querySelectorAll('[data-edge]')];
  const last = STEPS[i].length - 1;
  let timer = null;

  const show = (step) => {
    const s = Math.max(0, Math.min(step, last));
    range.value = String(s);
    // Membership in, classes out. Every element keeps its identity across the
    // whole timeline, so the browser has something to transition between.
    const [nodes, edges, visits] = STEPS[i][s];
    const on = new Set(nodes);
    const drawn = new Set(edges);
    const seen = new Set(visits);
    for (const el of nodeEls) {
      const id = Number(el.dataset.node);
      el.classList.toggle('av-off', !on.has(id));
      el.classList.toggle('av-highlight', seen.has(id));
    }
    for (const el of edgeEls) el.classList.toggle('av-off', !drawn.has(el.dataset.edge));
    note.textContent = NOTES[i][s];
  };
  const stop = () => { clearInterval(timer); timer = null; playBtn.textContent = 'play'; };
  const start = () => {
    if (Number(range.value) >= last) show(0);
    playBtn.textContent = 'pause';
    timer = setInterval(() => {
      const next = Number(range.value) + 1;
      if (next > last) { stop(); return; }
      show(next);
    }, RATE);
  };

  section.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    const cur = Number(range.value);
    const act = b.dataset.act;
    if (act !== 'play') stop();
    if (act === 'first') show(0);
    else if (act === 'last') show(last);
    else if (act === 'prev') show(cur - 1);
    else if (act === 'next') show(cur + 1);
    else if (act === 'nextMark') show(MARKS[i].find((m) => m > cur) ?? last);
    else if (act === 'prevMark') show([...MARKS[i]].reverse().find((m) => m < cur) ?? 0);
    else if (timer) stop(); else start();
  }));
  range.addEventListener('input', () => { stop(); show(Number(range.value)); });
  show(last);
});
</script>
</body>
</html>
`;

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../../../demo/index.html');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page, 'utf8');
console.log(`wrote ${out}`);
for (const p of panels) console.log(`  ${p.heading}: ${p.steps.length} steps · ${p.caption}`);
