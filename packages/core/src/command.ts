/**
 * Command parsing.
 *
 * The parser is handed `CommandSpec[]` and derives everything from it —
 * grammar, arity, argument types, usage strings, help text, completions.
 * It contains no command names. If a command name appears anywhere in this
 * file, the abstraction has leaked.
 *
 * Errors are returned, never thrown, and carry the character range that
 * caused them so a console can underline it.
 */

export type ParamKind = 'int' | 'version' | 'int-list';

export interface ParamSpec {
  readonly name: string;
  readonly kind: ParamKind;
}

export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly params: readonly ParamSpec[];
  readonly complexity?: string;
}

/**
 * The first four codes are the parser's. The rest belong to a plugin at
 * execution time — the parser validates that `v3` is shaped like a version
 * reference, never that version 3 exists.
 */
export type ErrorCode =
  | 'PARSE_ERROR'
  | 'UNKNOWN_COMMAND'
  | 'BAD_ARITY'
  | 'BAD_ARGUMENT'
  | 'UNKNOWN_VERSION'
  | 'INDEX_OUT_OF_RANGE'
  | 'INVALID_RANGE'
  /** The structure is not in a state where this operation makes sense. */
  | 'PRECONDITION_FAILED';

export interface OperationError {
  readonly code: ErrorCode;
  readonly message: string;
  /** Half-open character range into the input, for underlining. */
  readonly span?: readonly [number, number];
  readonly hint?: string;
}

export type ArgValue =
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'version'; readonly index: number }
  | { readonly kind: 'int-list'; readonly values: readonly number[] };

export interface ParsedCommand {
  readonly name: string;
  readonly args: ReadonlyMap<string, ArgValue>;
  readonly raw: string;
}

export type ParseResult =
  | { readonly ok: true; readonly command: ParsedCommand }
  | { readonly ok: false; readonly error: OperationError };

/* ── Presentation, derived from specs ──────────────────────────────── */

export function paramSyntax(p: ParamSpec): string {
  return p.kind === 'int-list' ? `[${p.name}...]` : `<${p.name}>`;
}

export function usage(spec: CommandSpec): string {
  return [spec.name, ...spec.params.map(paramSyntax)].join(' ');
}

export function help(specs: readonly CommandSpec[]): readonly string[] {
  const width = Math.max(0, ...specs.map((s) => usage(s).length));
  return specs.map((s) => {
    const tail = s.complexity === undefined ? s.summary : `${s.summary}  (${s.complexity})`;
    return `${usage(s).padEnd(width)}  ${tail}`;
  });
}

export interface Completion {
  readonly candidates: readonly string[];
  readonly hint: string | null;
}

export function complete(input: string, specs: readonly CommandSpec[]): Completion {
  const tokens = tokenize(input);
  const head = tokens[0];
  const typingName = head === undefined || (tokens.length === 1 && head.end === input.length);
  if (typingName) {
    const prefix = (head?.text ?? '').toLowerCase();
    return { candidates: specs.map((s) => s.name).filter((n) => n.startsWith(prefix)), hint: null };
  }
  const spec = specs.find((s) => s.name === head.text.toLowerCase());
  return { candidates: [], hint: spec === undefined ? null : usage(spec) };
}

/* ── Tokenizer ─────────────────────────────────────────────────────── */

interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const BREAK = /[\s,[\]]/;

function tokenize(input: string): readonly Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '[' || ch === ']') {
      out.push({ text: ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    let j = i;
    while (j < input.length && !BREAK.test(input[j] as string)) j += 1;
    out.push({ text: input.slice(i, j), start: i, end: j });
    i = j;
  }
  return out;
}

/* ── Parser ────────────────────────────────────────────────────────── */

const INT = /^[+-]?\d+$/;
const VERSION = /^v(\d+)$/i;

function fail(
  code: ErrorCode,
  message: string,
  span?: readonly [number, number],
  hint?: string,
): OperationError {
  return {
    code,
    message,
    ...(span === undefined ? {} : { span }),
    ...(hint === undefined ? {} : { hint }),
  };
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j] as number;
      row[j] = Math.min(above + 1, (row[j - 1] as number) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = above;
    }
  }
  return row[b.length] as number;
}

type Consumed =
  | { readonly ok: true; readonly value: ArgValue; readonly next: number }
  | { readonly ok: false; readonly error: OperationError };

function consume(
  spec: CommandSpec,
  p: ParamSpec,
  tokens: readonly Token[],
  i: number,
  input: string,
): Consumed {
  const hint = usage(spec);
  const eof: readonly [number, number] = [input.length, input.length];
  const token = tokens[i];

  if (token === undefined || token.text === ']') {
    const names = spec.params.map((q) => q.name).join(', ');
    return {
      ok: false,
      error: fail(
        'BAD_ARITY',
        `${spec.name} needs ${spec.params.length} argument${spec.params.length === 1 ? '' : 's'} (${names}); "${p.name}" is missing.`,
        token === undefined ? eof : [token.start, token.end],
        hint,
      ),
    };
  }

  switch (p.kind) {
    case 'int': {
      if (!INT.test(token.text)) {
        return {
          ok: false,
          error: fail('BAD_ARGUMENT', `"${token.text}" is not a whole number.`, [token.start, token.end], hint),
        };
      }
      return { ok: true, value: { kind: 'int', value: Number(token.text) }, next: i + 1 };
    }
    case 'version': {
      const m = VERSION.exec(token.text);
      if (m === null) {
        return {
          ok: false,
          error: fail(
            'BAD_ARGUMENT',
            `"${token.text}" is not a version reference. Versions look like v0, v1, v2.`,
            [token.start, token.end],
            hint,
          ),
        };
      }
      return { ok: true, value: { kind: 'version', index: Number(m[1]) }, next: i + 1 };
    }
    case 'int-list': {
      if (token.text !== '[') {
        return {
          ok: false,
          error: fail(
            'BAD_ARGUMENT',
            `${p.name} must be a bracketed list, like [1 2 3].`,
            [token.start, token.end],
            hint,
          ),
        };
      }
      const values: number[] = [];
      let j = i + 1;
      for (;;) {
        const t = tokens[j];
        if (t === undefined) {
          return {
            ok: false,
            error: fail('PARSE_ERROR', 'Unclosed "[" — the list needs a closing "]".', [token.start, token.end], hint),
          };
        }
        if (t.text === ']') {
          j += 1;
          break;
        }
        if (!INT.test(t.text)) {
          return {
            ok: false,
            error: fail('BAD_ARGUMENT', `"${t.text}" is not a whole number.`, [t.start, t.end], hint),
          };
        }
        values.push(Number(t.text));
        j += 1;
      }
      if (values.length === 0) {
        return {
          ok: false,
          error: fail('BAD_ARGUMENT', `${p.name} cannot be empty.`, [token.start, token.end], hint),
        };
      }
      return { ok: true, value: { kind: 'int-list', values }, next: j };
    }
    default: {
      const never: never = p.kind;
      throw new Error(`unhandled param kind: ${String(never)}`);
    }
  }
}

export function parseCommand(input: string, specs: readonly CommandSpec[]): ParseResult {
  const tokens = tokenize(input);
  const head = tokens[0];

  if (head === undefined) {
    return {
      ok: false,
      error: fail('PARSE_ERROR', 'Enter a command.', undefined, `available: ${specs.map((s) => s.name).join(', ')}`),
    };
  }

  const name = head.text.toLowerCase();
  const spec = specs.find((s) => s.name === name);
  if (spec === undefined) {
    const near = specs
      .map((s) => ({ name: s.name, d: editDistance(name, s.name) }))
      .filter((c) => c.d <= Math.max(2, Math.floor(c.name.length / 3)) || c.name.startsWith(name))
      .sort((a, b) => a.d - b.d)
      .map((c) => c.name);
    return {
      ok: false,
      error: fail(
        'UNKNOWN_COMMAND',
        `Unknown command "${head.text}".`,
        [head.start, head.end],
        near.length > 0 ? `did you mean: ${near.join(', ')}` : `available: ${specs.map((s) => s.name).join(', ')}`,
      ),
    };
  }

  const args = new Map<string, ArgValue>();
  let i = 1;
  for (const p of spec.params) {
    const r = consume(spec, p, tokens, i, input);
    if (!r.ok) return { ok: false, error: r.error };
    args.set(p.name, r.value);
    i = r.next;
  }

  const extra = tokens[i];
  if (extra !== undefined) {
    return {
      ok: false,
      error: fail(
        'BAD_ARITY',
        `${spec.name} takes ${spec.params.length} argument${spec.params.length === 1 ? '' : 's'}; "${extra.text}" is extra.`,
        [extra.start, tokens[tokens.length - 1]?.end ?? extra.end],
        usage(spec),
      ),
    };
  }

  return { ok: true, command: { name: spec.name, args, raw: input } };
}

/* ── Typed accessors, so plugins do not re-check shapes ────────────── */

export function getInt(cmd: ParsedCommand, param: string): number {
  const v = cmd.args.get(param);
  if (v?.kind !== 'int') throw new Error(`${cmd.name}: "${param}" is not an int`);
  return v.value;
}

export function getVersion(cmd: ParsedCommand, param: string): number {
  const v = cmd.args.get(param);
  if (v?.kind !== 'version') throw new Error(`${cmd.name}: "${param}" is not a version`);
  return v.index;
}

export function getIntList(cmd: ParsedCommand, param: string): readonly number[] {
  const v = cmd.args.get(param);
  if (v?.kind !== 'int-list') throw new Error(`${cmd.name}: "${param}" is not an int-list`);
  return v.values;
}
