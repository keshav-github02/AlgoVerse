/**
 * Renderer: positioned scene in, SVG out.
 *
 * Knows nodes, edges, labels, roles and a camera. It has never heard of
 * versions, segment trees or stacks. `origin` is just an integer it maps to a
 * palette slot; `reused` is just a flag it draws as a dashed stroke.
 *
 * Output is a string rather than DOM, so the same function serves a browser,
 * a test, and a file on disk.
 */

import type { NodeId, PositionedScene } from '@algoverse/core';

export interface RenderOptions {
  /** Nodes drawn at full strength with an emphasis ring. */
  readonly highlight?: readonly NodeId[];
  /** Nodes pushed into the background. */
  readonly dim?: readonly NodeId[];
  /** Show the small label under each value. */
  readonly showLabels?: boolean;
  /** Accessible description of the whole picture. */
  readonly title?: string;
}

const PALETTE_SIZE = 6;

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

/** Trims float noise so output is stable and diffable. */
const n2 = (v: number): string => (Math.round(v * 100) / 100).toString();

export const SCENE_STYLES = `
.av-edge { fill: none; stroke-linecap: round; stroke-width: 1.5; opacity: .55; }
.av-edge.av-reused { stroke-width: 2.1; stroke-dasharray: 4 3.5; opacity: .95; }
.av-node rect { stroke-width: 1.25; fill: var(--av-node-bg, #fff); }
.av-node .av-value { font: 600 16px var(--av-mono, ui-monospace, Consolas, monospace);
  font-variant-numeric: tabular-nums; fill: var(--av-text, #171f27); }
.av-node .av-label { font: 9.5px var(--av-mono, ui-monospace, Consolas, monospace);
  fill: var(--av-faint, #8695a3); }
.av-node.av-highlight rect { stroke-width: 3; }
.av-node.av-dim { opacity: .12; }
.av-tick { stroke: none; }
`.trim();

/**
 * The SVG element only. Embed it in a page, or wrap it with `SCENE_STYLES`
 * and a palette to get something standalone.
 */
export function renderScene(scene: PositionedScene, options: RenderOptions = {}): string {
  const highlight = new Set(options.highlight ?? []);
  const dim = new Set(options.dim ?? []);
  const showLabels = options.showLabels ?? true;
  const hue = (origin: number): string => `var(--av-c${origin % PALETTE_SIZE})`;

  const originOf = new Map<NodeId, number>();
  for (const p of scene.nodes) originOf.set(p.node.id, p.node.origin);

  const edges = scene.edges.map((e) => {
    const dy = e.y2 - e.y1;
    const d = Math.abs(dy) < 1
      ? `M${n2(e.x1)},${n2(e.y1)} L${n2(e.x2)},${n2(e.y2)}`
      : `M${n2(e.x1)},${n2(e.y1)} C${n2(e.x1)},${n2(e.y1 + dy * 0.45)} ` +
        `${n2(e.x2)},${n2(e.y2 - dy * 0.45)} ${n2(e.x2)},${n2(e.y2)}`;
    const cls = e.reused ? 'av-edge av-reused' : 'av-edge';
    // Colour by the child's origin: an edge into older memory reads as older.
    const stroke = hue(originOf.get(e.to) ?? 0);
    return `<path class="${cls}" stroke="${stroke}" d="${d}" />`;
  });

  const nodes = scene.nodes.map((p) => {
    const { node } = p;
    const x = p.x - p.width / 2;
    const y = p.y - p.height / 2;
    const classes = ['av-node'];
    if (highlight.has(node.id)) classes.push('av-highlight');
    if (dim.has(node.id)) classes.push('av-dim');
    const colour = hue(node.origin);
    const label = escapeXml(node.label);
    const aria = escapeXml(
      `${node.role} ${node.label}, value ${node.value}` +
      (node.origin > 0 ? `, from generation ${node.origin}` : ''));

    const parts = [
      `<rect x="${n2(x)}" y="${n2(y)}" width="${n2(p.width)}" height="${n2(p.height)}" ` +
        `rx="5" stroke="${colour}" />`,
      `<text class="av-value" x="${n2(p.x)}" y="${n2(y + p.height * 0.48)}" ` +
        `text-anchor="middle">${escapeXml(String(node.value))}</text>`,
    ];
    if (showLabels) {
      parts.push(
        `<text class="av-label" x="${n2(p.x)}" y="${n2(y + p.height * 0.78)}" ` +
        `text-anchor="middle">${label}</text>`);
    }
    if (highlight.has(node.id)) {
      parts.push(
        `<path class="av-tick" fill="${colour}" d="M${n2(x + p.width - 11)},${n2(y)} ` +
        `L${n2(x + p.width)},${n2(y)} L${n2(x + p.width)},${n2(y + 11)} Z" />`);
    }
    return `<g class="${classes.join(' ')}" role="listitem" aria-label="${aria}">${parts.join('')}</g>`;
  });

  const title = options.title === undefined ? '' : `<title>${escapeXml(options.title)}</title>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n2(scene.width)} ${n2(scene.height)}" `,
    `role="list" aria-label="${escapeXml(options.title ?? 'structure')}">`,
    title,
    `<g class="av-edges">${edges.join('')}</g>`,
    `<g class="av-nodes">${nodes.join('')}</g>`,
    '</svg>',
  ].join('');
}
