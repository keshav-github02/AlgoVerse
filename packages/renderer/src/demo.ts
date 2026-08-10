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
  type LayoutHint, type NodeId, type ParsedCommand, type PositionedScene, type SimEvent,
} from '@algoverse/core';
import { SCENE_STYLES, escapeXml, renderScene } from './svg.ts';
import { persistentSegmentTree } from '@algoverse/plugin-persistent-segment-tree';
import { persistentBit } from '@algoverse/plugin-persistent-bit';
import { persistentTreap } from '@algoverse/plugin-persistent-treap';
import { persistentTrie } from '@algoverse/plugin-persistent-trie';
import { persistentBst } from '@algoverse/plugin-persistent-bst';
import { stack } from '@algoverse/plugin-stack';

interface Panel {
  readonly heading: string;
  readonly caption: string;
  readonly session: readonly { readonly line: string; readonly out: string }[];
  readonly frames: readonly { readonly svg: string; readonly note: string }[];
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

  /**
   * Layout is computed once, over every node that ever exists, and reused for
   * every frame. Laying out each frame independently would make surviving
   * nodes jump sideways whenever a neighbour appeared, which reads as chaos
   * rather than as an algorithm running.
   */
  const union = new Timeline();
  union.append(all.filter((e) => e.kind !== 'NodeDeleted'));
  const stable = layout(sceneToStructure(union.stateAt(union.length), hint));

  const playback = new Playback(timeline);

  /** The plugin's own words where it has them, the generic ones where it does not. */
  const explainAt = (step: number): string => {
    const event = timeline.eventAt(step - 1);
    if (event === undefined) return 'ready';
    const which = timeline.marks.findIndex((m) => step <= m.index);
    const command = which === -1 ? null : commands[which] ?? null;
    return plugin.explain?.(event, { after: playback.scene(), command, step })
      ?? describeEvent(event);
  };

  const frames: { svg: string; note: string }[] = [];
  for (let step = 0; step <= timeline.length; step += 1) {
    playback.seek(step);
    const live = sceneToStructure(playback.scene(), hint);
    const present = new Set<NodeId>(live.nodes.map((n) => n.id));
    const scene: PositionedScene = {
      nodes: stable.nodes.filter((n) => present.has(n.node.id)),
      edges: stable.edges.filter((e) => present.has(e.from) && present.has(e.to)),
      width: stable.width,
      height: stable.height,
    };
    const visited = [...playback.scene().visits.keys()].filter((id) => present.has(id));
    frames.push({
      svg: renderScene(scene, { title: `${plugin.meta.name} at step ${step}`, highlight: visited }),
      note: `${String(step).padStart(2, '0')}/${timeline.length}  ${explainAt(step)}`,
    });
  }

  const final = sceneToStructure(playback.scene(), hint);
  return {
    heading: plugin.meta.name,
    caption: `${timeline.length} events · ${final.nodes.length} live nodes · ` +
      `${final.edges.filter((e) => e.reused).length} pointers into reused memory · ` +
      `layout "${hint}" · ${Math.round(stable.width)}x${Math.round(stable.height)}px`,
    session,
    frames,
    marks: timeline.marks.map((m) => ({ index: m.index, label: m.label })),
  };
}

const panels: readonly Panel[] = [
  drive(persistentSegmentTree,
    ['build [3 1 4 1 5 9 2 6]', 'update v0 3 10', 'update v1 6 7', 'query v1 2 5'], 'dag'),
  drive(persistentBit, ['build [3 1 4 1 5 9 2 6]', 'add v0 3 5', 'prefix v1 5'], 'dag'),
  drive(persistentTreap, ['build [5 2 8 1 9]', 'insert v0 6', 'erase v1 2'], 'dag'),
  drive(persistentTrie, ['build [cat car card dog]', 'insert v0 care'], 'dag'),
  drive(persistentBst, ['build [1 2 3 4 5 6]', 'find v0 6'], 'dag'),
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
      <input type="range" min="0" max="${p.frames.length - 1}" value="${p.frames.length - 1}"
             aria-label="Step" />
      <span class="note"></span>
    </div>
    <div class="stage">${p.frames.map((f, s) =>
      `<div class="frame" data-step="${s}"${s === p.frames.length - 1 ? '' : ' hidden'}>${f.svg}</div>`).join('')}</div>
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
const NOTES = ${JSON.stringify(panels.map((p) => p.frames.map((f) => f.note)))};
const MARKS = ${JSON.stringify(panels.map((p) => p.marks.map((m) => m.index)))};
const RATE = 1000 / 12;
document.querySelectorAll('section[data-panel]').forEach((section) => {
  const i = Number(section.dataset.panel);
  const range = section.querySelector('input[type=range]');
  const note = section.querySelector('.note');
  const playBtn = section.querySelector('[data-act=play]');
  const frames = [...section.querySelectorAll('.frame')];
  const last = frames.length - 1;
  let timer = null;

  const show = (step) => {
    const s = Math.max(0, Math.min(step, last));
    range.value = String(s);
    frames.forEach((f, k) => { f.hidden = k !== s; });
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
for (const p of panels) console.log(`  ${p.heading}: ${p.frames.length} frames · ${p.caption}`);
