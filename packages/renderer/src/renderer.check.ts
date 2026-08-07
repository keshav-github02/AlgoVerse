/**
 * Renderer checks. Run directly:
 *
 *     node packages/renderer/src/renderer.check.ts
 */

import { layout, type NodeId, type StructureEdge, type StructureGraph, type StructureNode } from '@algoverse/core';
import { escapeXml, renderScene } from './svg.ts';

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

/* ── The renderer knows nothing about algorithms ───────────────────── */

console.log('\nvocabulary');

const source = renderScene(scene, { title: 'x' });
for (const word of ['version', 'segment', 'tree', 'stack', 'query', 'update']) {
  check(`output contains no "${word}"`, !new RegExp(word, 'i').test(source));
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
