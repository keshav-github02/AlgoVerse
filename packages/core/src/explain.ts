/**
 * Generic event descriptions.
 *
 * This is the fallback: it says *what* an event did, in terms of the event
 * model alone. Saying *why* needs algorithm knowledge, so plugins supply their
 * own explainer and this is what shows through where they decline.
 */

import type { SimEvent } from './timeline.ts';

export function describeEvent(e: SimEvent | undefined): string {
  if (e === undefined) return 'ready';
  switch (e.kind) {
    case 'NodeAllocated': return `allocate ${e.label} = ${e.value}`;
    case 'NodeUpdated': {
      const parts = [
        e.label === undefined ? null : `reads ${e.label}`,
        e.value === undefined ? null : `holds ${e.value}`,
        e.role === undefined ? null : `counts as ${e.role}`,
      ].filter((part) => part !== null);
      return parts.length === 0
        ? `node ${e.node} restated`
        : `node ${e.node} now ${parts.join(', ')}`;
    }
    case 'NodeDeleted': return `free node ${e.node}`;
    case 'PointerSet': return e.to === null
      ? `clear ${e.slot} of node ${e.from}`
      : `point ${e.slot} of node ${e.from} at node ${e.to}`;
    case 'NodeReused': return `reuse node ${e.node} under node ${e.by}`;
    case 'NodeVisited': return `visit node ${e.node}`;
    case 'RootsSet': return `entry points: ${e.roots.length === 0 ? 'none' : e.roots.join(', ')}`;
    case 'VersionCommitted': return `commit v${e.version}`;
    default: {
      const never: never = e;
      throw new Error(`undescribed event: ${JSON.stringify(never)}`);
    }
  }
}
