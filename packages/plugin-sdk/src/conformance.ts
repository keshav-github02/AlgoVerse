/**
 * The conformance kit. Every plugin runs it.
 *
 * These checks are generic — the kit is handed a plugin and a script of
 * command strings, and derives everything else. It never names a command.
 */

import {
  Timeline, createRng, parseCommand,
  type CommandSpec, type NodeId, type SimEvent,
} from '@algoverse/core';
import type { AlgorithmPlugin, PluginInstance, StructureGraph } from './contract.ts';

export interface ConformanceResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
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
 * silently broken — this is what catches it.
 */
function logDescribesStructure(events: readonly SimEvent[], structure: StructureGraph): string | null {
  const tl = new Timeline();
  tl.append(events);
  const scene = tl.stateAt(tl.length);

  const fromLog = [...scene.nodes.keys()].sort((a, b) => a - b);
  const fromPlugin = [...structure.nodes].map((n) => n.id).sort((a, b) => a - b);
  if (fromLog.length !== fromPlugin.length) {
    return `log has ${fromLog.length} nodes, structure reports ${fromPlugin.length}`;
  }
  for (let i = 0; i < fromLog.length; i += 1) {
    if (fromLog[i] !== fromPlugin[i]) return `node id sets differ at ${String(fromLog[i])}`;
  }

  for (const n of structure.nodes) {
    const s = scene.nodes.get(n.id);
    if (s === undefined) return `node ${String(n.id)} missing from replayed log`;
    if (s.value !== n.value) return `node ${String(n.id)} value ${s.value} in log, ${n.value} in structure`;
    if (s.label !== n.label) return `node ${String(n.id)} label "${s.label}" in log, "${n.label}" in structure`;
  }

  const childrenFromEdges = new Map<NodeId, Set<NodeId>>();
  for (const e of structure.edges) {
    const set = childrenFromEdges.get(e.from) ?? new Set<NodeId>();
    set.add(e.to);
    childrenFromEdges.set(e.from, set);
  }
  for (const [id, s] of scene.nodes) {
    const expected = new Set<NodeId>([s.left, s.right].filter((c): c is NodeId => c !== null));
    const actual = childrenFromEdges.get(id) ?? new Set<NodeId>();
    if (expected.size !== actual.size || [...expected].some((c) => !actual.has(c))) {
      return `node ${String(id)} children differ between log and structure`;
    }
  }

  if (String(scene.roots) !== String(structure.roots)) {
    return `roots differ: log [${scene.roots.join(',')}] vs structure [${structure.roots.join(',')}]`;
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
