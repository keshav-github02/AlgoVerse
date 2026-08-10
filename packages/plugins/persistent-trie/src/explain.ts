/**
 * Why each event happened, in trie terms.
 *
 * The idea worth explaining is that a node is a prefix, not a letter: the
 * sharing between words and the sharing between versions are the same
 * mechanism seen from two directions.
 */

import { getWord, type NodeId, type SceneState, type SimEvent } from '@algoverse/core';
import type { ExplainContext, Explainer } from '@algoverse/plugin-sdk';

/** Slots are written `p:<prefix>` by this plugin, so it can read them back. */
function prefixOf(state: SceneState, id: NodeId): string | null {
  const slot = state.nodes.get(id)?.slot;
  return slot === undefined || !slot.startsWith('p:') ? null : slot.slice(2);
}

const name = (prefix: string): string => (prefix === '' ? 'the root' : `"${prefix}"`);

function wordArg(ctx: ExplainContext): string | null {
  if (ctx.command === null) return null;
  for (const param of ['word', 'prefix']) {
    try {
      return getWord(ctx.command, param);
    } catch {
      // The command has no such parameter; try the next.
    }
  }
  return null;
}

export const explainTrie: Explainer = (event: SimEvent, ctx: ExplainContext): string | null => {
  const command = ctx.command?.name ?? null;
  const target = wordArg(ctx);

  switch (event.kind) {
    case 'NodeAllocated': {
      const prefix = prefixOf(ctx.after, event.node) ?? '';
      if (prefix === '') {
        return `The root stands for the empty prefix and now covers ${event.value} word` +
          `${event.value === 1 ? '' : 's'}.`;
      }
      if (command === 'build') {
        return `${name(prefix)} is a prefix node holding ${event.value} word` +
          `${event.value === 1 ? '' : 's'}. Every word starting with these letters passes through it.`;
      }
      return target !== null && prefix === target
        ? `${name(prefix)} is where the new word ends, so this node is marked as a word rather ` +
          `than only a prefix.`
        : `${name(prefix)} is copied because "${target ?? 'the word'}" runs through it. Only this ` +
          `one path is duplicated, however many branches hang off it.`;
    }

    case 'NodeVisited': {
      const prefix = prefixOf(ctx.after, event.node) ?? '';
      if (command === 'compare') return `${name(prefix)} is the same node in both versions.`;
      if (command === 'contains' || command === 'count') {
        return prefix === ''
          ? `Starting at the root, which every word shares.`
          : `Following the letters to ${name(prefix)}.`;
      }
      return `${name(prefix)} already exists, so it is walked before being copied.`;
    }

    case 'NodeReused': {
      const child = prefixOf(ctx.after, event.node);
      const parent = prefixOf(ctx.after, event.by);
      return `${child === null ? 'That branch' : name(child)} contains no part of ` +
        `"${target ?? 'the word'}", so the copy of ${parent === null ? 'its parent' : name(parent)} ` +
        `points at the existing node. A trie node can have twenty-six children; only one is ever copied.`;
    }

    case 'VersionCommitted': {
      const fresh = [...ctx.after.nodes.values()].filter((n) => n.origin === event.version).length;
      return event.version === 0
        ? `Version 0 is complete with ${ctx.after.nodes.size} nodes - far fewer than the total ` +
          `letters, because the words share their prefixes.`
        : `Version ${event.version} is complete. It allocated ${fresh} nodes, one per letter of ` +
          `the new word, and shares everything else with v${event.version - 1}.`;
    }

    case 'PointerSet': {
      if (event.to === null) return null;
      const child = ctx.after.nodes.get(event.to);
      const parent = ctx.after.nodes.get(event.from);
      if (child === undefined || parent === undefined) return null;
      return child.origin < parent.origin
        ? `The copy keeps v${child.origin}'s "${event.slot}" branch whole.`
        : `The copy links to its "${event.slot}" branch, rebuilt alongside it.`;
    }

    case 'RootsSet':
    case 'NodeDeleted':
      return null;

    default:
      return null;
  }
};
