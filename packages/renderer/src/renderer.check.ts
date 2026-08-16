/**
 * Renderer checks. Run directly:
 *
 *     node packages/renderer/src/renderer.check.ts
 */

import { layout, type NodeId, type StructureEdge, type StructureGraph, type StructureNode } from '@algoverse/core';
import { SCENE_STYLES, escapeXml, renderScene } from './svg.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

function graph(nodeCount: number, label = 'n'): StructureGraph {
  const nodes: StructureNode[] = [];
  const edges: StructureEdge[] = [];
  for (let i = 0; i < nodeCount; i += 1) {
    nodes.push({
      id: i as NodeId, label: `${label}${i}`, value: i * 3,
      role: i === 0 ? 'internal' : 'leaf', depth: i === 0 ? 0 : 1,
      slot: `s${i}`, origin: i % 3,
    });
    if (i > 0) edges.push({ from: 0 as NodeId, to: i as NodeId, slot: `c${i}`, reused: i % 2 === 0 });
  }
  return { layout: 'tree', nodes, edges, roots: [0 as NodeId] };
}

const scene = layout(graph(6));
const svg = renderScene(scene, { title: 'test scene' });

/* ── Well-formedness ───────────────────────────────────────────────── */

console.log('\noutput');

check('is a single svg element', svg.startsWith('<svg ') && svg.endsWith('</svg>'));
check('declares the svg namespace', svg.includes('xmlns="http://www.w3.org/2000/svg"'));
check('carries a viewBox matching the scene bounds',
  svg.includes(`viewBox="0 0 ${Math.round(scene.width * 100) / 100} ${Math.round(scene.height * 100) / 100}"`),
  `${Math.round(scene.width)} x ${Math.round(scene.height)}`);
// The trailing [ "] matters: "av-node" must not also match the "av-nodes" wrapper.
const countNodes = (s: string): number => (s.match(/class="av-node[ "]/g) ?? []).length;
const countEdges = (s: string): number => (s.match(/class="av-edge[ "]/g) ?? []).length;
check('draws one group per node', countNodes(svg) === scene.nodes.length,
  `${countNodes(svg)} of ${scene.nodes.length}`);
check('draws one path per edge', countEdges(svg) === scene.edges.length,
  `${countEdges(svg)} of ${scene.edges.length}`);
check('contains no NaN or undefined', !/NaN|undefined/.test(svg));
check('tags are balanced', (svg.match(/<g /g) ?? []).length === (svg.match(/<\/g>/g) ?? []).length);
check('is deterministic', renderScene(layout(graph(6)), { title: 'test scene' }) === svg);
check('an empty scene still renders', (() => {
  const empty = renderScene(layout({ layout: 'tree', nodes: [], edges: [], roots: [] }));
  return empty.startsWith('<svg ') && empty.endsWith('</svg>') && !/NaN/.test(empty);
})());

/* ── Escaping ──────────────────────────────────────────────────────── */

console.log('\nescaping');

check('escapes the five XML characters',
  escapeXml(`<&>"'`) === '&lt;&amp;&gt;&quot;&#39;', escapeXml(`<&>"'`));
check('escapes labels coming from a plugin', (() => {
  const nasty = renderScene(layout({
    layout: 'tree',
    nodes: [{ id: 0 as NodeId, label: '</text><script>x</script>', value: 1,
      role: 'leaf', depth: 0, slot: 'a', origin: 0 }],
    edges: [], roots: [0 as NodeId],
  }));
  return !nasty.includes('<script>') && nasty.includes('&lt;/text&gt;');
})());
check('range labels survive intact',
  renderScene(layout({
    layout: 'tree',
    nodes: [{ id: 0 as NodeId, label: '[0,8)', value: 31, role: 'internal', depth: 0, slot: 'a', origin: 0 }],
    edges: [], roots: [0 as NodeId],
  })).includes('[0,8)'));

/* ── Options ───────────────────────────────────────────────────────── */

console.log('\noptions');

const marked = renderScene(scene, { highlight: [0 as NodeId], dim: [1 as NodeId] });
check('highlight adds a class', marked.includes('av-node av-highlight'));
check('dim adds a class', marked.includes('av-node av-dim'));
check('labels can be turned off',
  !renderScene(scene, { showLabels: false }).includes('av-label'));
check('reused edges are marked', svg.includes('av-edge av-reused'),
  `${(svg.match(/av-reused/g) ?? []).length} reused`);
check('origin drives the palette slot, not the value',
  svg.includes('var(--av-c0)') && svg.includes('var(--av-c1)') && svg.includes('var(--av-c2)'));

/* ── Identity, so a consumer can animate ───────────────────────────── */

console.log('\nstable identity');

/*
 * Everything an animation has to toggle needs a name that outlives the frame
 * it appears in. Swapping a freshly drawn picture per step cannot animate:
 * the element that leaves and the element that arrives are different elements,
 * so the browser has nothing to transition between.
 */
check('every node carries its id', (() => {
  const ids = [...svg.matchAll(/data-node="(\d+)"/g)].map((m) => m[1]);
  return ids.length === scene.nodes.length && new Set(ids).size === ids.length;
})(), `${scene.nodes.length} nodes, all distinct`);

check('every edge carries a key naming both of its ends', (() => {
  const keys = [...svg.matchAll(/class="av-edge[^"]*" data-edge="([^"]+)"/g)].map((m) => m[1]);
  const want = scene.edges.map((e) => `${e.from}:${e.slot}:${e.to}`);
  return keys.length === want.length && keys.every((k, i) => k === want[i]);
})(), `${scene.edges.length} edges`);

check('the corner tick is always drawn, so highlight is only a class', (() => {
  // Emitting it only when highlighted meant highlighting required re-rendering
  // the scene. As a class it is a toggle, which is what a pointer needs too.
  const plain = (renderScene(scene).match(/av-tick/g) ?? []).length;
  const lit = (renderScene(scene, { highlight: [0 as NodeId] }).match(/av-tick/g) ?? []).length;
  return plain === scene.nodes.length && lit === plain;
})());

check('off fades a node and everything attached to it', (() => {
  const faded = renderScene(scene, { off: [1 as NodeId] });
  const touching = scene.edges.filter((e) => e.from === 1 || e.to === 1).length;
  const nodesOff = (faded.match(/class="av-node av-off"/g) ?? []).length;
  const edgesOff = (faded.match(/class="av-edge[^"]*av-off"/g) ?? []).length;
  return nodesOff === 1 && edgesOff === touching && touching > 0;
})());

check('off is not dim: they are different classes', (() => {
  const a = renderScene(scene, { off: [0 as NodeId] });
  const b = renderScene(scene, { dim: [0 as NodeId] });
  return a.includes('av-off') && !a.includes('av-dim')
    && b.includes('av-dim') && !b.includes('av-off');
})(), 'dim is still part of the picture; off is not there');

check('motion is dropped when the reader asks for it',
  SCENE_STYLES.includes('prefers-reduced-motion'));

/* ── The renderer knows nothing about algorithms ───────────────────── */

console.log('\nvocabulary');

const source = renderScene(scene, { title: 'x' });
for (const word of ['version', 'segment', 'tree', 'stack', 'query', 'update']) {
  check(`output contains no "${word}"`, !new RegExp(word, 'i').test(source));
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
