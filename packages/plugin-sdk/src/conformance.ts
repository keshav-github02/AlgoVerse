/**
 * The conformance kit. Every plugin runs it.
 *
 * These checks are generic - the kit is handed a plugin and a script of
 * command strings, and derives everything else. It never names a command.
 */

import {
  Timeline, createRng, parseCommand, sceneToStructure,
  type CommandSpec, type NodeId, type SimEvent,
} from '@algoverse/core';
import type { AlgorithmPlugin, PluginInstance, StructureGraph } from './contract.ts';

export interface ConformanceResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  /** True when the plugin has nothing for this check to examine. Not a pass. */
  readonly skipped?: boolean;
}

interface RunOutcome {
  readonly events: readonly SimEvent[];
  readonly failedLine: string | null;
  readonly threw: string | null;
}

function runScript(
  inst: PluginInstance,
  commands: readonly CommandSpec[],
  script: readonly string[],
): RunOutcome {
  const events: SimEvent[] = [];
  for (const line of script) {
    const parsed = parseCommand(line, commands);
    if (!parsed.ok) return { events, failedLine: `${line} -> ${parsed.error.code}`, threw: null };
    try {
      const r = inst.execute(parsed.command);
      events.push(...r.events);
      if (!r.ok) return { events, failedLine: `${line} -> ${r.error.code}`, threw: null };
    } catch (e) {
      return { events, failedLine: line, threw: e instanceof Error ? e.message : String(e) };
    }
  }
  return { events, failedLine: null, threw: null };
}

/**
 * The event log must fully describe the structure. If a plugin mutates state
 * without emitting an event, replay diverges from reality and time travel is
 * silently broken - this is what catches it.
 */
function logDescribesStructure(events: readonly SimEvent[], structure: StructureGraph): string | null {
  const tl = new Timeline();
  tl.append(events);
  const derived = sceneToStructure(tl.stateAt(tl.length), structure.layout);

  if (derived.nodes.length !== structure.nodes.length) {
    return `log yields ${derived.nodes.length} nodes, structure reports ${structure.nodes.length}`;
  }

  const byId = new Map(derived.nodes.map((n) => [n.id, n]));
  for (const n of structure.nodes) {
    const d = byId.get(n.id);
    if (d === undefined) return `node ${String(n.id)} missing from replayed log`;
    // Every drawable field, not just the obvious two: a slot or origin that
    // disagrees puts the node in the wrong place or the wrong colour.
    for (const field of ['label', 'value', 'role', 'depth', 'slot', 'origin'] as const) {
      if (d[field] !== n[field]) {
        return `node ${String(n.id)} ${field}: log says ${String(d[field])}, structure says ${String(n[field])}`;
      }
    }
  }

  const key = (e: { from: NodeId; to: NodeId; slot: string; reused: boolean }): string =>
    `${e.from}-${e.slot}->${e.to}${e.reused ? '*' : ''}`;
  const fromLog = new Set(derived.edges.map(key));
  const fromPlugin = new Set(structure.edges.map(key));
  if (fromLog.size !== fromPlugin.size) {
    return `log yields ${fromLog.size} edges, structure reports ${fromPlugin.size}`;
  }
  for (const k of fromPlugin) {
    if (!fromLog.has(k)) return `edge ${k} is in the structure but not the log`;
  }

  if (String(derived.roots) !== String(structure.roots)) {
    return `roots differ: log [${derived.roots.join(',')}] vs structure [${structure.roots.join(',')}]`;
  }
  return null;
}

function synthesize(spec: CommandSpec, versionText: string): string {
  return [
    spec.name,
    ...spec.params.map((p) =>
      p.kind === 'version' ? versionText : p.kind === 'int' ? '0' : '[1 2 3]'),
  ].join(' ');
}

export function runConformance(
  plugin: AlgorithmPlugin,
  script: readonly string[],
): readonly ConformanceResult[] {
  const out: ConformanceResult[] = [];
  const add = (name: string, ok: boolean, detail = ''): void => {
    out.push({ name, ok, detail });
  };
  const skip = (name: string, detail: string): void => {
    out.push({ name, ok: true, detail, skipped: true });
  };
  const fresh = (): PluginInstance => plugin.createInstance({ rng: createRng(1) });

  // 1. Metadata
  const m = plugin.meta;
  add('meta is complete',
    m.id.length > 0 && m.name.length > 0 && m.category.length > 0 && m.summary.length > 0, m.id);

  // 2. Command specs are well formed
  const names = plugin.commands.map((c) => c.name);
  add('command names are unique', new Set(names).size === names.length, `${names.length} commands`);
  add('command names are lowercase', names.every((n) => n === n.toLowerCase() && n.length > 0));
  add('declares at least one command', plugin.commands.length > 0);
  add('param names are unique per command',
    plugin.commands.every((c) => new Set(c.params.map((p) => p.name)).size === c.params.length));

  // 3. The script runs
  const inst = fresh();
  const run = runScript(inst, plugin.commands, script);
  add('script executes without error', run.failedLine === null && run.threw === null,
    run.threw !== null ? `threw: ${run.threw}` : (run.failedLine ?? `${script.length} commands`));
  add('operations emit events', run.events.length > 0, `${run.events.length} events`);

  // 4. Events are plain data
  const cycled = JSON.stringify(JSON.parse(JSON.stringify(run.events)));
  add('events survive a JSON round trip', cycled === JSON.stringify(run.events));

  // 5. The log fully describes the structure
  const mismatch = logDescribesStructure(run.events, inst.getStructure());
  add('event log describes the structure', mismatch === null, mismatch ?? 'log replay matches');

  // 6. Determinism
  const again = runScript(fresh(), plugin.commands, script);
  add('same script emits an identical log',
    JSON.stringify(again.events) === JSON.stringify(run.events));

  // 7. Serialisation
  const state = inst.serialize();
  add('serialised state is versioned and attributed',
    Number.isInteger(state.schemaVersion) && state.schemaVersion > 0 && state.pluginId === m.id,
    `schemaVersion ${state.schemaVersion}`);
  add('serialised state survives a JSON round trip',
    JSON.stringify(JSON.parse(JSON.stringify(state))) === JSON.stringify(state));

  // 8. Reset
  const resettable = fresh();
  runScript(resettable, plugin.commands, script);
  resettable.reset();
  const after = resettable.getStructure();
  add('reset clears the structure', after.nodes.length === 0 && after.roots.length === 0,
    `${after.nodes.length} nodes remain`);

  // 9. Bad semantics are returned, never thrown
  const versioned = plugin.commands.filter((c) => c.params.some((p) => p.kind === 'version'));
  if (versioned.length === 0) {
    // Reporting this as a pass would be a lie: nothing was exercised.
    skip('missing versions produce an error, not a throw', 'no versioned commands to probe');
    return out;
  }
  let returnedCleanly = true;
  let note = `${versioned.length} commands probed`;
  for (const spec of versioned) {
    const probe = parseCommand(synthesize(spec, 'v999'), plugin.commands);
    if (!probe.ok) { returnedCleanly = false; note = `could not parse probe for ${spec.name}`; break; }
    try {
      const r = fresh().execute(probe.command);
      if (r.ok) { returnedCleanly = false; note = `${spec.name} accepted version 999`; break; }
    } catch (e) {
      returnedCleanly = false;
      note = `${spec.name} threw: ${e instanceof Error ? e.message : String(e)}`;
      break;
    }
  }
  add('missing versions produce an error, not a throw', returnedCleanly, note);

  return out;
}
