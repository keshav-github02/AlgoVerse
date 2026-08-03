/**
 * Time travel.
 *
 * The event log is the only source of truth. Visual state at step N is
 * `fold(events[0..N])` through a pure reducer, so stepping backward is a
 * rewind-and-replay rather than an undo. Keyframes bound the replay cost.
 *
 * Nothing here knows what a segment tree is.
 */

export type NodeId = number & { readonly __brand: unique symbol };

export type SimEvent =
  | { readonly kind: 'NodeAllocated'; readonly node: NodeId; readonly value: number; readonly label: string }
  | { readonly kind: 'PointerSet'; readonly from: NodeId; readonly slot: 'left' | 'right'; readonly to: NodeId }
  | { readonly kind: 'NodeReused'; readonly node: NodeId; readonly by: NodeId }
  | { readonly kind: 'VersionCommitted'; readonly version: number; readonly root: NodeId };

export interface SceneNode {
  readonly value: number;
  readonly label: string;
  readonly left: NodeId | null;
  readonly right: NodeId | null;
}

export interface SceneState {
  readonly nodes: ReadonlyMap<NodeId, SceneNode>;
  readonly reuseCount: ReadonlyMap<NodeId, number>;
  readonly roots: readonly NodeId[];
}

export const EMPTY_SCENE: SceneState = {
  nodes: new Map(),
  reuseCount: new Map(),
  roots: [],
};

/** Pure. Same (state, event) always yields the same next state. */
export function reduce(s: SceneState, e: SimEvent): SceneState {
  switch (e.kind) {
    case 'NodeAllocated': {
      const nodes = new Map(s.nodes);
      nodes.set(e.node, { value: e.value, label: e.label, left: null, right: null });
      return { ...s, nodes };
    }
    case 'PointerSet': {
      const parent = s.nodes.get(e.from);
      if (parent === undefined) return s;
      const nodes = new Map(s.nodes);
      nodes.set(e.from, e.slot === 'left' ? { ...parent, left: e.to } : { ...parent, right: e.to });
      return { ...s, nodes };
    }
    case 'NodeReused': {
      const reuseCount = new Map(s.reuseCount);
      reuseCount.set(e.node, (reuseCount.get(e.node) ?? 0) + 1);
      return { ...s, reuseCount };
    }
    case 'VersionCommitted':
      return { ...s, roots: [...s.roots, e.root] };
    default: {
      const never: never = e;
      throw new Error(`unhandled event: ${JSON.stringify(never)}`);
    }
  }
}

/** Snapshot every Nth step, so scrubbing replays at most this many events. */
export const KEYFRAME_INTERVAL = 8;

export class Timeline {
  readonly #log: SimEvent[] = [];
  readonly #keyframes = new Map<number, SceneState>([[0, EMPTY_SCENE]]);
  #cursor: SceneState = EMPTY_SCENE;

  append(events: readonly SimEvent[]): void {
    for (const e of events) {
      this.#log.push(e);
      this.#cursor = reduce(this.#cursor, e);
      if (this.#log.length % KEYFRAME_INTERVAL === 0) {
        this.#keyframes.set(this.#log.length, this.#cursor);
      }
    }
  }

  get length(): number {
    return this.#log.length;
  }

  eventAt(step: number): SimEvent | undefined {
    return this.#log[step];
  }

  /** State after `step` events. Clamped, so callers cannot walk off either end. */
  stateAt(step: number): SceneState {
    const n = Math.max(0, Math.min(Math.trunc(step), this.#log.length));
    let base = 0;
    for (const k of this.#keyframes.keys()) {
      if (k <= n && k > base) base = k;
    }
    let s = this.#keyframes.get(base) as SceneState;
    for (let i = base; i < n; i++) s = reduce(s, this.#log[i] as SimEvent);
    return s;
  }
}

/** Canonical string form, for comparing two states for equality. */
export function fingerprint(s: SceneState): string {
  const nodes = [...s.nodes.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, n]) =>
      `${id}=${n.value}${n.label}:${n.left ?? '_'},${n.right ?? '_'}x${s.reuseCount.get(id) ?? 0}`);
  return `r[${s.roots.join(',')}] ${nodes.join(' ')}`;
}
