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
  readonly scene: PositionedScene;
  readonly visited: readonly NodeId[];
  readonly selected: NodeId | null;
  readonly showLabels: boolean;
  readonly emphasis?: ReadonlyMap<NodeId, Emphasis>;
  readonly onSelect: (id: NodeId | null) => void;
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
    const className = id !== null && id === selected
      ? `${String(el.attrs['className'] ?? '')} av-selected`
      : (el.attrs['className'] as string | undefined);
    return (
      <g
        {...base}
        className={className}
        key={key}
        {...(id === null ? {} : {
          style: { cursor: 'pointer' },
          onClick: (e: MouseEvent<SVGGElement>) => {
            e.stopPropagation();
            onSelect(id === selected ? null : id);
          },
        })}
      >
        {el.children.map((c, i) => toReact(c, `${key}.${i}`, selected, onSelect))}
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

export function Scene({ scene, visited, selected, showLabels, emphasis, onSelect }: Props): JSX.Element {
  if (scene.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs italic text-[var(--faint)]">
        Nothing built yet — run a command below.
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
        ...(emphasis === undefined ? {} : { emphasis }),
      }).map((el, i) => (
        <Fragment key={i}>{toReact(el, String(i), selected, onSelect)}</Fragment>
      ))}
    </svg>
  );
}
