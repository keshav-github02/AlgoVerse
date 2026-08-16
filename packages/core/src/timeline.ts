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
  /**
   * Carries everything needed to draw the node. The log has to be sufficient
   * on its own - if the picture needed to ask the plugin for anything, replay
   * would not be a faithful reconstruction.
   */
  | {
      readonly kind: 'NodeAllocated';
      readonly node: NodeId;
      readonly value: number;
      /** For a node holding several keys at once, such as a B-tree node. */
      readonly values?: readonly number[];
      readonly label: string;
      readonly role: string;
      /** Omit when the node sits at different depths in different versions. */
      readonly depth?: number;
      readonly slot: string;
      readonly origin: number;
      /**
       * Which set this node belongs to, where the plugin has one - a chain, a
       * component, a partition. Distinct from `origin`, which says *when* a
       * node was allocated; a group says *what it is part of*. Drawn as
       * colour, because a partition you cannot see is not a partition you can
       * reason about.
       */
      readonly group?: number;
    }
  | { readonly kind: 'NodeDeleted'; readonly node: NodeId }
  /** `to: null` clears the slot. Slots are plugin-defined names, not positions. */
  | {
      readonly kind: 'PointerSet';
      readonly from: NodeId;
      readonly slot: string;
      readonly to: NodeId | null;
      /**
       * `link` for a pointer that is not part of the hierarchy. Kept in the
       * log rather than derived when drawing, because a pointer the picture
       * shows and the log does not carry is a pointer replay cannot rebuild.
       */
      readonly pointer?: 'child' | 'link';
      /** What the edge is worth, where that means something. */
      readonly weight?: number;
      /**
       * Whether the pointer runs one way only. A tree edge does not need this:
       * position says which end is the parent. An edge between two vertices
       * side by side has no such cue, so it has to be drawn.
       */
      readonly directed?: boolean;
    }
  | { readonly kind: 'NodeReused'; readonly node: NodeId; readonly by: NodeId }
  | { readonly kind: 'NodeVisited'; readonly node: NodeId }
  /** Replaces the current entry points. */
  | { readonly kind: 'RootsSet'; readonly roots: readonly NodeId[] }
  /**
   * Appends to the version history. Only persistent structures emit this.
   *
   * `roots` is a list because a version is a set of entry points, not one node.
   * A Fenwick forest has several whenever its size is not a power of two.
   */
  | { readonly kind: 'VersionCommitted'; readonly version: number; readonly roots: readonly NodeId[] };

export interface ScenePointer {
  readonly to: NodeId;
  readonly kind: 'child' | 'link';
  readonly weight?: number;
  readonly directed?: boolean;
}

export interface SceneNode {
  readonly value: number;
  readonly values?: readonly number[];
  readonly label: string;
  readonly role: string;
  readonly depth?: number;
  readonly slot: string;
  readonly origin: number;
  readonly group?: number;
  /**
   * Everything this node points at, keyed by slot name.
   *
   * One map rather than one per property. Children and links began as separate
   * maps, and adding a weight would have made a third keyed the same way -
   * which is the point at which the shape is wrong rather than merely growing.
   */
  readonly pointers: ReadonlyMap<string, ScenePointer>;
}

export interface SceneState {
  readonly nodes: ReadonlyMap<NodeId, SceneNode>;
  readonly reuseCount: ReadonlyMap<NodeId, number>;
  /** Times each node was touched by a traversal - the measured cost of an operation. */
  readonly visits: ReadonlyMap<NodeId, number>;
  /** Where a renderer starts walking. Replaced wholesale, not accumulated. */
  readonly roots: readonly NodeId[];
  /** Committed versions, in order, each with its own entry points. */
  readonly versions: readonly (readonly NodeId[])[];
}

export const EMPTY_SCENE: SceneState = {
  nodes: new Map(),
  reuseCount: new Map(),
  visits: new Map(),
  roots: [],
  versions: [],
};

/** Pure. Same (state, event) always yields the same next state. */
export function reduce(s: SceneState, e: SimEvent): SceneState {
  switch (e.kind) {
    case 'NodeAllocated': {
      const nodes = new Map(s.nodes);
      nodes.set(e.node, {
        value: e.value, label: e.label, role: e.role,
        slot: e.slot, origin: e.origin,
        ...(e.values === undefined ? {} : { values: e.values }),
        ...(e.depth === undefined ? {} : { depth: e.depth }),
        ...(e.group === undefined ? {} : { group: e.group }),
        pointers: new Map(),
      });
      return { ...s, nodes };
    }
    case 'NodeDeleted': {
      if (!s.nodes.has(e.node)) return s;
      const nodes = new Map(s.nodes);
      nodes.delete(e.node);
      return { ...s, nodes };
    }
    case 'PointerSet': {
      const parent = s.nodes.get(e.from);
      if (parent === undefined) return s;
      const pointers = new Map(parent.pointers);
      if (e.to === null) {
        pointers.delete(e.slot);
      } else {
        pointers.set(e.slot, {
          to: e.to,
          kind: e.pointer ?? 'child',
          ...(e.weight === undefined ? {} : { weight: e.weight }),
          ...(e.directed === undefined ? {} : { directed: e.directed }),
        });
      }
      const nodes = new Map(s.nodes);
      nodes.set(e.from, { ...parent, pointers });
      return { ...s, nodes };
    }
    case 'NodeReused': {
      const reuseCount = new Map(s.reuseCount);
      reuseCount.set(e.node, (reuseCount.get(e.node) ?? 0) + 1);
      return { ...s, reuseCount };
    }
    case 'NodeVisited': {
      const visits = new Map(s.visits);
      visits.set(e.node, (visits.get(e.node) ?? 0) + 1);
      return { ...s, visits };
    }
    case 'RootsSet':
      return { ...s, roots: [...e.roots] };
    case 'VersionCommitted':
      return { ...s, versions: [...s.versions, [...e.roots]] };
    default: {
      const never: never = e;
      throw new Error(`unhandled event: ${JSON.stringify(never)}`);
    }
  }
}

/** Snapshot every Nth step, so scrubbing replays at most this many events. */
export const KEYFRAME_INTERVAL = 8;

/** Where one operation ends, so playback can step coarsely as well as finely. */
export interface Mark {
  readonly index: number;
  readonly label: string;
}

export class Timeline {
  readonly #log: SimEvent[] = [];
  readonly #keyframes = new Map<number, SceneState>([[0, EMPTY_SCENE]]);
  readonly #marks: Mark[] = [];
  #cursor: SceneState = EMPTY_SCENE;

  /** One call per operation. `label` is what the console typed. */
  append(events: readonly SimEvent[], label?: string): void {
    for (const e of events) {
      this.#log.push(e);
      this.#cursor = reduce(this.#cursor, e);
      if (this.#log.length % KEYFRAME_INTERVAL === 0) {
        this.#keyframes.set(this.#log.length, this.#cursor);
      }
    }
    if (label !== undefined && events.length > 0) {
      this.#marks.push({ index: this.#log.length, label });
    }
  }

  get length(): number {
    return this.#log.length;
  }

  get marks(): readonly Mark[] {
    return this.#marks;
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
    for (let i = base; i < n; i += 1) s = reduce(s, this.#log[i] as SimEvent);
    return s;
  }
}

/** Canonical string form, for comparing two states for equality. */
export function fingerprint(s: SceneState): string {
  const nodes = [...s.nodes.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, n]) => {
      const pointers = [...n.pointers.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([slot, p]) => `${slot}${p.kind === 'link' ? '~' : ''}>${p.to}${p.weight === undefined ? '' : `@${p.weight}`}`)
        .join(',');
      return `${id}=${n.value}${n.label}@${n.slot}#${n.origin}` +
        `{${pointers}}x${s.reuseCount.get(id) ?? 0}v${s.visits.get(id) ?? 0}`;
    });
  const history = s.versions.map((v) => v.join('+')).join(',');
  return `r[${s.roots.join(',')}] h[${history}] ${nodes.join(' ')}`;
}
