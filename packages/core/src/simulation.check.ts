/**
 * Save-format checks. Run directly:
 *
 *     node packages/core/src/simulation.check.ts
 */

import {
  SIMULATION_SCHEMA, decodeSimulation, digestOf, encodeSimulation, type SimulationFile,
} from './simulation.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const sample: SimulationFile = {
  schemaVersion: SIMULATION_SCHEMA,
  pluginId: 'persistent-segment-tree',
  seed: 1,
  commands: ['build [3 1 4 1 5 9 2 6]', 'update v0 3 10', 'update v1 6 7', 'query v1 2 5'],
  digest: digestOf({ schemaVersion: 1, pluginId: 'persistent-segment-tree', data: {} }),
};

/* ── Round trip ────────────────────────────────────────────────────── */

console.log('\nround trip');

const encoded = encodeSimulation(sample);
const back = decodeSimulation(encoded);
check('a file survives encoding', back.ok && JSON.stringify(back.file) === JSON.stringify(sample),
  `${encoded.length} characters`);
check('the encoding is URL-safe', !/[+/=]/.test(encoded));
check('encoding is deterministic', encodeSimulation(sample) === encoded);
check('an empty script round-trips', (() => {
  const empty: SimulationFile = { ...sample, commands: [], digest: null };
  const r = decodeSimulation(encodeSimulation(empty));
  return r.ok && r.file.commands.length === 0 && r.file.digest === null;
})());
check('non-ASCII survives', (() => {
  const odd: SimulationFile = { ...sample, commands: ['build [1 2 3] - π'] };
  const r = decodeSimulation(encodeSimulation(odd));
  return r.ok && r.file.commands[0] === 'build [1 2 3] - π';
})());

/* ── Size ──────────────────────────────────────────────────────────── */

console.log('\nsize');

const long: SimulationFile = {
  ...sample,
  commands: ['build [3 1 4 1 5 9 2 6]', ...Array.from({ length: 50 }, (_, i) => `update v${i} ${i % 8} ${i}`)],
};
const longLink = encodeSimulation(long);
check('a 51-command session fits comfortably in a URL', longLink.length < 4000,
  `${longLink.length} characters - browsers handle about 8000`);

/* ── Rejection ─────────────────────────────────────────────────────── */

console.log('\nrejection');

const cases: readonly { readonly label: string; readonly input: string; readonly code: string }[] = [
  { label: 'gibberish', input: '!!!not base64!!!', code: 'PARSE_ERROR' },
  { label: 'valid base64 that is not JSON', input: encodeURIComponent('') + 'aGVsbG8', code: 'PARSE_ERROR' },
  { label: 'an empty string', input: '', code: 'PARSE_ERROR' },
];
for (const c of cases) {
  const r = decodeSimulation(c.input);
  check(`rejects ${c.label}`, !r.ok && r.error.code === c.code,
    r.ok ? 'accepted' : r.error.code);
}

const b64 = (o: unknown): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

check('rejects a file from a newer format', (() => {
  const r = decodeSimulation(b64({ v: SIMULATION_SCHEMA + 1, p: 'x', s: 1, c: [] }));
  return !r.ok && r.error.code === 'INCOMPATIBLE_SAVE';
})(), (() => {
  const r = decodeSimulation(b64({ v: SIMULATION_SCHEMA + 1, p: 'x', s: 1, c: [] }));
  return r.ok ? '' : r.error.message;
})());

check('rejects missing fields', (() => {
  const r = decodeSimulation(b64({ v: 1, p: 'x' }));
  return !r.ok && r.error.code === 'PARSE_ERROR';
})());
check('rejects a commands array holding non-strings', (() => {
  const r = decodeSimulation(b64({ v: 1, p: 'x', s: 1, c: ['ok', 42] }));
  return !r.ok;
})());
check('every rejection carries a hint', (() => {
  for (const bad of ['!!!', b64({ v: 99, p: 'x', s: 1, c: [] }), b64({ v: 1 })]) {
    const r = decodeSimulation(bad);
    if (r.ok || r.error.hint === undefined) return false;
  }
  return true;
})());

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
