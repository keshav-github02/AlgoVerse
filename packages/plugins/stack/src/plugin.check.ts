/**
 * Conformance plus property tests for the stack.
 *
 *     node packages/plugins/stack/src/plugin.check.ts
 */

import { createRng, help, layout, parseCommand, type OperationError } from '@algoverse/core';
import { runConformance, type PluginInstance } from '@algoverse/plugin-sdk';
import { stack as plugin } from './plugin.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const fresh = (): PluginInstance => plugin.createInstance({ rng: createRng(1) });

function run(inst: PluginInstance, line: string): { value: unknown; error: OperationError | null } {
  const parsed = parseCommand(line, plugin.commands);
  if (!parsed.ok) return { value: null, error: parsed.error };
  const r = inst.execute(parsed.command);
  return r.ok ? { value: r.value, error: null } : { value: null, error: r.error };
}

/* ── 1. Conformance ────────────────────────────────────────────────── */

console.log('\nconformance');
for (const r of runConformance(plugin, ['push 3', 'push 7', 'peek', 'push 1', 'pop'])) {
  const tag = r.skipped === true ? 'skip' : r.ok ? 'pass' : 'FAIL';
  if (!r.ok) failures += 1;
  console.log(`  ${tag}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

/* ── 2. Behaviour ──────────────────────────────────────────────────── */

console.log('\nbehaviour');

const inst = fresh();
check('push reports its depth',
  (run(inst, 'push 5').value as { depth: number }).depth === 1);
run(inst, 'push 9');
check('peek reads the top without removing it',
  (run(inst, 'peek').value as { top: number }).top === 9
  && (run(inst, 'peek').value as { depth: number }).depth === 2);
check('pop returns last in, first out',
  (run(inst, 'pop').value as { popped: number }).popped === 9);
check('pop uncovers the value below',
  (run(inst, 'peek').value as { top: number }).top === 5);

const emptied = fresh();
check('pop on empty is an error, not a crash',
  run(emptied, 'pop').error?.code === 'PRECONDITION_FAILED',
  run(emptied, 'pop').error?.hint ?? '');
check('peek on empty is an error, not a crash',
  run(emptied, 'peek').error?.code === 'PRECONDITION_FAILED');
check('zero-parameter commands parse',
  parseCommand('pop', plugin.commands).ok);
check('extra arguments to a zero-parameter command are rejected',
  (() => { const r = parseCommand('pop 3', plugin.commands); return !r.ok && r.error.code === 'BAD_ARITY'; })());

/* ── 3. Nodes are actually deleted ─────────────────────────────────── */

console.log('\ndeletion');

const shrink = fresh();
for (const line of ['push 1', 'push 2', 'push 3']) run(shrink, line);
check('three pushes leave three nodes', shrink.getStructure().nodes.length === 3);
run(shrink, 'pop');
check('pop removes the node', shrink.getStructure().nodes.length === 2,
  `${shrink.getStructure().nodes.length} nodes`);
check('the new top becomes the only root',
  shrink.getStructure().roots.length === 1
  && shrink.getStructure().roots[0] === shrink.getStructure().nodes[1]?.id);
check('edges shrink with the structure', shrink.getStructure().edges.length === 1);
check('emptying completely leaves no roots',
  (() => { run(shrink, 'pop'); run(shrink, 'pop');
    const s = shrink.getStructure();
    return s.nodes.length === 0 && s.roots.length === 0 && s.edges.length === 0; })());

/* ── 3b. Layout consumes the real structure ────────────────────────── */

console.log('\nlayout');

const laid = fresh();
for (const line of ['push 1', 'push 2', 'push 3']) run(laid, line);
const struct = laid.getStructure();
const scene = layout(struct);
check('the stack lays out as a single column',
  new Set(scene.nodes.map((n) => n.x)).size === 1,
  `${Math.round(scene.width)} x ${Math.round(scene.height)} px`);
// Being on top is being the root, not a role — which cell is on top changes
// with every push, and a node's role is fixed when it is allocated.
check('the most recent push is drawn on top', (() => {
  const top = scene.nodes.find((n) => n.node.id === struct.roots[0]);
  return top !== undefined && top.node.value === 3 && scene.nodes.every((n) => n.y >= top.y);
})());
check('an emptied stack lays out cleanly', (() => {
  for (let i = 0; i < 3; i += 1) run(laid, 'pop');
  const s = layout(laid.getStructure());
  return s.nodes.length === 0 && s.edges.length === 0 && s.width > 0;
})());

/* ── 4. Property test against a real array ─────────────────────────── */

console.log('\nproperty test vs a plain array');

const rng = createRng(20_260_808);
let ops = 0;
let firstFailure = '';

for (let trial = 0; trial < 80 && firstFailure === ''; trial += 1) {
  const inst2 = fresh();
  const model: number[] = [];
  for (let i = 0; i < 25 && firstFailure === ''; i += 1) {
    const roll = rng.next();
    ops += 1;
    if (roll < 0.5) {
      const v = rng.nextInt(-50, 50);
      run(inst2, `push ${v}`);
      model.push(v);
    } else if (roll < 0.8) {
      const r = run(inst2, 'pop');
      const expected = model.pop();
      if (expected === undefined) {
        if (r.error?.code !== 'PRECONDITION_FAILED') firstFailure = 'pop on empty did not error';
      } else if (r.error !== null || (r.value as { popped: number }).popped !== expected) {
        firstFailure = `pop gave ${r.error?.code ?? (r.value as { popped: number }).popped}, expected ${expected}`;
      }
    } else {
      const r = run(inst2, 'peek');
      const expected = model[model.length - 1];
      if (expected === undefined) {
        if (r.error?.code !== 'PRECONDITION_FAILED') firstFailure = 'peek on empty did not error';
      } else if (r.error !== null || (r.value as { top: number }).top !== expected) {
        firstFailure = `peek gave ${r.error?.code ?? (r.value as { top: number }).top}, expected ${expected}`;
      }
    }
    const live = inst2.getStructure();
    if (firstFailure === '' && live.nodes.length !== model.length) {
      firstFailure = `structure has ${live.nodes.length} nodes, model has ${model.length}`;
    }
  }
}

check('stack matches a plain array', firstFailure === '',
  firstFailure === '' ? `80 trials, ${ops} operations` : firstFailure);

/* ── 5. Console session ────────────────────────────────────────────── */

console.log('\nconsole session:\n');
const session = fresh();
for (const line of ['push 4', 'push 8', 'peek', 'pop', 'pop', 'pop']) {
  const r = run(session, line);
  const out = r.error === null
    ? JSON.stringify(r.value)
    : `${r.error.code}: ${r.error.message}  (${r.error.hint ?? ''})`;
  console.log(`      > ${line}\n        ${out}`);
}

console.log('\ncommands, generated from the plugin:\n');
for (const line of help(plugin.commands)) console.log(`      ${line}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
