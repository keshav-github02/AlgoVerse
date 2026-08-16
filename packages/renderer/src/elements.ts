/**
 * The drawing, as data.
 *
 * Building an element tree rather than a string means the same drawing code
 * serves a React tree and a file on disk. Without it the two would drift, or
 * React would have to trust raw markup.
 *
 * Attribute names are written the way React wants them (`className`,
 * `textAnchor`); the serialiser converts to SVG spelling.
 */

import type { NodeId, PositionedScene } from '@algoverse/core';

export type AttrValue = string | number;
export interface Attrs { readonly [key: string]: AttrValue }

export type SceneElement =
  | { readonly tag: 'path' | 'rect'; readonly attrs: Attrs }
  | { readonly tag: 'text'; readonly attrs: Attrs; readonly text: string }
  | { readonly tag: 'g'; readonly attrs: Attrs; readonly children: readonly SceneElement[] };

/**
 * Relative weight of a node in the current view. The caller decides what the
 * levels mean - the renderer only knows one reads louder than the next.
 */
export type Emphasis = 'primary' | 'secondary' | 'muted';

export interface RenderOptions {
  /** Nodes drawn with an emphasis ring and a corner tick. */
  readonly highlight?: readonly NodeId[];
  /** Nodes pushed into the background. */
  readonly dim?: readonly NodeId[];
  /** Per-node weighting. Absent nodes are drawn normally. */
  readonly emphasis?: ReadonlyMap<NodeId, Emphasis>;
  /** Show the small label under each value. */
  readonly showLabels?: boolean;
  /** Accessible description of the whole picture. */
  readonly title?: string;
}

const WEIGHT: Record<Emphasis, number> = { primary: 2, secondary: 1, muted: 0 };

/** An edge is only as loud as its quieter end. */
function edgeEmphasis(a: Emphasis | undefined, b: Emphasis | undefined): Emphasis | undefined {
  if (a === undefined || b === undefined) return undefined;
  return WEIGHT[a] <= WEIGHT[b] ? a : b;
}

const PALETTE_SIZE = 6;

/** Trims float noise so output is stable and diffable. */
const n2 = (v: number): number => Math.round(v * 100) / 100;

export function sceneElements(
  scene: PositionedScene,
  options: RenderOptions = {},
): readonly SceneElement[] {
  const highlight = new Set(options.highlight ?? []);
  const dim = new Set(options.dim ?? []);
  const showLabels = options.showLabels ?? true;
  const hue = (origin: number): string => `var(--av-c${origin % PALETTE_SIZE})`;

  const originOf = new Map<NodeId, number>();
  for (const p of scene.nodes) originOf.set(p.node.id, p.node.origin);

  const emphasis = options.emphasis;
  const weights: SceneElement[] = [];
  const edges: SceneElement[] = scene.edges.map((e) => {
    const dy = e.y2 - e.y1;
    const d = Math.abs(dy) < 1
      ? `M${n2(e.x1)},${n2(e.y1)} L${n2(e.x2)},${n2(e.y2)}`
      : `M${n2(e.x1)},${n2(e.y1)} C${n2(e.x1)},${n2(e.y1 + dy * 0.45)} ` +
        `${n2(e.x2)},${n2(e.y2 - dy * 0.45)} ${n2(e.x2)},${n2(e.y2)}`;
    const em = emphasis === undefined
      ? undefined
      : edgeEmphasis(emphasis.get(e.from), emphasis.get(e.to));
    return {
      tag: 'path',
      attrs: {
        className: [
          'av-edge',
          e.reused ? 'av-reused' : '',
          e.kind === 'link' ? 'av-link' : '',
          em === undefined ? '' : `av-em-${em}`,
        ].filter((c) => c !== '').join(' '),
        // Colour by the child's origin: a pointer into older memory reads older.
        stroke: hue(originOf.get(e.to) ?? 0),
        d,
      },
    };
  });

  // Weights ride above the edges so a line never crosses its own number.
  for (const e of scene.edges) {
    if (e.weight === undefined) continue;
    weights.push({
      tag: 'text',
      attrs: {
        className: 'av-weight',
        x: n2((e.x1 + e.x2) / 2),
        y: n2((e.y1 + e.y2) / 2),
        textAnchor: 'middle',
        dy: '0.32em',
      },
      text: String(e.weight),
    });
  }

  const nodes: SceneElement[] = scene.nodes.map((p) => {
    const { node } = p;
    const x = p.x - p.width / 2;
    const y = p.y - p.height / 2;
    const colour = hue(node.origin);
    const classes = ['av-node'];
    if (highlight.has(node.id)) classes.push('av-highlight');
    if (dim.has(node.id)) classes.push('av-dim');
    const em = emphasis?.get(node.id);
    if (em !== undefined) classes.push(`av-em-${em}`);

    const children: SceneElement[] = [
      {
        tag: 'rect',
        attrs: {
          x: n2(x), y: n2(y), width: n2(p.width), height: n2(p.height),
          rx: 5, stroke: colour,
        },
      },
      {
        tag: 'text',
        attrs: { className: 'av-value', x: n2(p.x), y: n2(y + p.height * 0.48), textAnchor: 'middle' },
        // A node may hold several keys; layout has already made room for them.
        text: node.values === undefined ? String(node.value) : node.values.join(' '),
      },
    ];
    if (showLabels) {
      children.push({
        tag: 'text',
        attrs: { className: 'av-label', x: n2(p.x), y: n2(y + p.height * 0.78), textAnchor: 'middle' },
        text: node.label,
      });
    }
    if (highlight.has(node.id)) {
      children.push({
        tag: 'path',
        attrs: {
          className: 'av-tick',
          fill: colour,
          d: `M${n2(x + p.width - 11)},${n2(y)} L${n2(x + p.width)},${n2(y)} ` +
             `L${n2(x + p.width)},${n2(y + 11)} Z`,
        },
      });
    }

    return {
      tag: 'g',
      attrs: {
        className: classes.join(' '),
        'data-node': node.id,
        role: 'listitem',
        'aria-label': `${node.role} ${node.label}, ` +
          `${node.values === undefined ? `value ${node.value}` : `keys ${node.values.join(', ')}`}` +
          (node.origin > 0 ? `, from generation ${node.origin}` : ''),
      },
      children,
    };
  });

  return [
    { tag: 'g', attrs: { className: 'av-edges' }, children: edges },
    { tag: 'g', attrs: { className: 'av-weights' }, children: weights },
    { tag: 'g', attrs: { className: 'av-nodes' }, children: nodes },
  ];
}
