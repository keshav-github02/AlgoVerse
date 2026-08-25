/**
 * Maps the renderer's element tree to React.
 *
 * The renderer hands over data, so nothing here trusts raw markup and no
 * drawing logic is duplicated between the app and the generated demo page.
 */

import { Fragment, type JSX, type MouseEvent, type SVGProps } from 'react';
import type { NodeId, PositionedScene } from '@algoverse/core';
import { sceneElements, type Emphasis, type SceneElement } from '@algoverse/renderer';

interface Props {
  /** Every node that ever exists, not only the ones in this step. */
  readonly scene: PositionedScene;
  /** The ones not in this step, drawn faded rather than removed. */
  readonly off?: readonly NodeId[];
  readonly visited: readonly NodeId[];
  readonly selected: NodeId | null;
  readonly showLabels: boolean;
  readonly emphasis?: ReadonlyMap<NodeId, Emphasis>;
  readonly onSelect: (id: NodeId | null) => void;
}

/**
 * What React should call an element, so that the same thing keeps the same
 * element between steps.
 *
 * Keying by position in the list is the default and it is wrong here: the list
 * is rebuilt on every step, so element seven can be a different node from one
 * frame to the next. React then reuses the DOM node for something else, and a
 * CSS transition either does not run or runs on the wrong thing. The renderer
 * already stamps `data-node` and `data-edge` for exactly this - the generated
 * demo page finds its elements by them - so identity is available and only
 * needs using.
 */
function identityOf(el: SceneElement, fallback: string): string {
  const node = el.attrs['data-node'];
  if (node !== undefined) return `n${String(node)}`;
  const edge = el.attrs['data-edge'];
  if (edge !== undefined) return `e${String(edge)}:${el.tag}`;
  return fallback;
}

/** Attribute bags are validated by the renderer, not by JSX's prop types. */
const asProps = <T,>(attrs: SceneElement['attrs']): SVGProps<T> =>
  attrs as unknown as SVGProps<T>;

function toReact(
  el: SceneElement,
  key: string,
  selected: NodeId | null,
  onSelect: (id: NodeId | null) => void,
): JSX.Element {
  if (el.tag === 'g') {
    const raw = el.attrs['data-node'];
    const id = typeof raw === 'number' ? (raw as NodeId) : null;
    const base = asProps<SVGGElement>(el.attrs);
    const classes = String(el.attrs['className'] ?? '');
    const className = id !== null && id === selected ? `${classes} av-selected` : classes;
    // A node that is not part of this step is hidden by the stylesheet, so it
    // should not be read out either.
    const gone = classes.includes('av-off');
    return (
      <g
        {...base}
        className={className}
        key={key}
        {...(gone ? { 'aria-hidden': true } : {})}
        {...(id === null || gone ? {} : {
          style: { cursor: 'pointer' },
          onClick: (e: MouseEvent<SVGGElement>) => {
            e.stopPropagation();
            onSelect(id === selected ? null : id);
          },
        })}
      >
        {el.children.map((c, i) => toReact(c, `${key}.${identityOf(c, String(i))}`, selected, onSelect))}
      </g>
    );
  }
  if (el.tag === 'text') {
    return <text {...asProps<SVGTextElement>(el.attrs)} key={key}>{el.text}</text>;
  }
  if (el.tag === 'rect') {
    return <rect {...asProps<SVGRectElement>(el.attrs)} key={key} />;
  }
  return <path {...asProps<SVGPathElement>(el.attrs)} key={key} />;
}

export function Scene({
  scene, off, visited, selected, showLabels, emphasis, onSelect,
}: Props): JSX.Element {
  if (scene.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs italic text-[var(--faint)]">
        Nothing built yet - run a command below.
      </div>
    );
  }
  return (
    <svg
      viewBox={`0 0 ${scene.width} ${scene.height}`}
      role="list"
      aria-label="structure"
      className="block h-auto w-full min-w-[520px]"
      onClick={() => onSelect(null)}
    >
      {sceneElements(scene, {
        highlight: visited,
        showLabels,
        ...(off === undefined ? {} : { off }),
        ...(emphasis === undefined ? {} : { emphasis }),
      }).map((el, i) => {
        // The four top-level groups - edges, arrows, weights, nodes - are
        // always in this order, so their index is a stable identity.
        const key = String(el.attrs['className'] ?? i);
        return <Fragment key={key}>{toReact(el, key, selected, onSelect)}</Fragment>;
      })}
    </svg>
  );
}
