/**
 * Memory inspector and statistics.
 *
 * Every field is read from the replayed scene at the current step, so scrubbing
 * backwards shows what the node was, not what it ended up as.
 */

import type { JSX } from 'react';
import type { NodeId, SceneState } from '@algoverse/core';
import type { Statistics } from '@algoverse/plugin-sdk';

const address = (id: number): string => `0x${(0x4100 + id * 24).toString(16).toUpperCase()}`;

function Row({ k, v, accent }: { k: string; v: string; accent?: boolean }): JSX.Element {
  return (
    <>
      <dt className="text-[var(--dim)]">{k}</dt>
      <dd className={`text-right font-mono tabular-nums break-all ${accent === true ? 'font-semibold' : ''}`}>
        {v}
      </dd>
    </>
  );
}

export function Inspector({ state, selected }: {
  readonly state: SceneState;
  readonly selected: NodeId | null;
}): JSX.Element {
  const node = selected === null ? undefined : state.nodes.get(selected);
  if (selected === null || node === undefined) {
    return <p className="text-xs italic text-[var(--faint)]">Select a node to inspect it.</p>;
  }

  const parents: NodeId[] = [];
  for (const [id, n] of state.nodes) {
    for (const p of n.pointers.values()) if (p.to === selected) parents.push(id);
  }
  const children = [...node.pointers.entries()];

  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 text-xs">
      <Row k="ID" v={`#${selected}`} />
      <Row k="Address" v={address(selected)} />
      <Row k="Label" v={node.label} />
      <Row k="Value" v={String(node.value)} accent />
      <Row k="Role" v={node.role} />
      <Row k="Depth" v={String(node.depth)} />
      <Row k="Slot" v={node.slot} />
      <Row k="Origin" v={String(node.origin)} />
      <Row k="Children" v={children.length === 0 ? '-' : children.map(([s, c]) => `${s}:#${c}`).join(' ')} />
      <Row k="Parents" v={parents.length === 0 ? 'root' : parents.map((p) => `#${p}`).join(' ')} />
      <Row k="Ref count" v={String(parents.length)} />
      <Row k="Reused" v={String(state.reuseCount.get(selected) ?? 0)} />
      <Row k="Visits" v={String(state.visits.get(selected) ?? 0)} />
    </dl>
  );
}

export function Stats({ state, stats }: {
  readonly state: SceneState;
  readonly stats: Statistics;
}): JSX.Element {
  // Deliberately no "memory saved" figure. Computing it needs to know what a
  // full copy would have cost, which only the plugin knows - a generic panel
  // guessing at it would print a confident wrong number.
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 text-xs">
      <Row k="Live nodes" v={String(state.nodes.size)} accent />
      <Row k="Allocated" v={String(stats.nodesAllocated)} />
      <Row k="Reused pointers" v={String(stats.nodesReused)} />
      <Row k="Node visits" v={String(stats.nodeVisits)} />
      <Row k="Versions" v={String(state.versions.length)} />
      <Row k="Writes" v={String(stats.updates)} />
      <Row k="Reads" v={String(stats.queries)} />
      <Row k="Height" v={String(stats.height)} />
    </dl>
  );
}
