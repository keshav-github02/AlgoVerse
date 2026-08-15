/**
 * Renderer: positioned scene in, SVG out.
 *
 * Knows nodes, edges, labels, roles and a camera. It has never heard of
 * versions, segment trees or stacks. `origin` is just an integer it maps to a
 * palette slot; `reused` is just a flag it draws as a dashed stroke.
 */

import type { PositionedScene } from '@algoverse/core';
import { sceneElements, type Attrs, type RenderOptions, type SceneElement } from './elements.ts';

export const SCENE_STYLES = `
.av-edge { fill: none; stroke-linecap: round; stroke-width: 1.5; opacity: .55; }
.av-edge.av-reused { stroke-width: 2.1; stroke-dasharray: 4 3.5; opacity: .95; }
/* A pointer that is not a tree edge: thinner, dotted, and it runs sideways. */
.av-edge.av-link { stroke-width: 1.25; stroke-dasharray: 1.5 3; opacity: .75; }
.av-node rect { stroke-width: 1.25; fill: var(--av-node-bg, #fff); }
.av-node .av-value { font: 600 16px var(--av-mono, ui-monospace, Consolas, monospace);
  font-variant-numeric: tabular-nums; fill: var(--av-text, #171f27); }
.av-node .av-label { font: 9.5px var(--av-mono, ui-monospace, Consolas, monospace);
  fill: var(--av-faint, #8695a3); }
.av-node.av-highlight rect { stroke-width: 3; }
.av-node.av-dim { opacity: .12; }
.av-node.av-selected rect { stroke-width: 3.25; }
.av-tick { stroke: none; }
/* Emphasis levels. Weight and dash carry the meaning as well as opacity, so
   the distinction survives for anyone who cannot separate the shades. */
.av-node.av-em-primary rect { stroke-width: 2.75; }
.av-node.av-em-secondary { opacity: .62; }
.av-node.av-em-secondary rect { stroke-dasharray: 3 2.5; }
.av-node.av-em-muted { opacity: .1; }
.av-edge.av-em-primary { opacity: 1; }
.av-edge.av-em-secondary { opacity: .38; }
.av-edge.av-em-muted { opacity: .06; }
`.trim();

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

/** React spelling to SVG spelling: className becomes class, camelCase becomes kebab. */
function attrName(key: string): string {
  if (key === 'className') return 'class';
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function serialize(el: SceneElement): string {
  const attrs = (a: Attrs): string =>
    Object.entries(a)
      .map(([k, v]) => ` ${attrName(k)}="${escapeXml(String(v))}"`)
      .join('');
  if (el.tag === 'g') {
    return `<g${attrs(el.attrs)}>${el.children.map(serialize).join('')}</g>`;
  }
  if (el.tag === 'text') {
    return `<text${attrs(el.attrs)}>${escapeXml(el.text)}</text>`;
  }
  return `<${el.tag}${attrs(el.attrs)} />`;
}

/**
 * The SVG element only. Embed it in a page, or wrap it with `SCENE_STYLES`
 * and a palette to get something standalone.
 */
export function renderScene(scene: PositionedScene, options: RenderOptions = {}): string {
  const label = escapeXml(options.title ?? 'structure');
  const title = options.title === undefined ? '' : `<title>${escapeXml(options.title)}</title>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.round(scene.width * 100) / 100} `,
    `${Math.round(scene.height * 100) / 100}" role="list" aria-label="${label}">`,
    title,
    sceneElements(scene, options).map(serialize).join(''),
    '</svg>',
  ].join('');
}
