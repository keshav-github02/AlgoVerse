/**
 * The console.
 *
 * Its grammar, completions and help all come from the plugin's declared
 * commands. Nothing here knows what `update` means.
 */

import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { complete, help, usage } from '@algoverse/core';
import type { Session } from '../engine.ts';

interface Props {
  readonly session: Session;
  readonly onRun: (line: string) => void;
}

export function Console({ session, onRun }: Props): JSX.Element {
  const [input, setInput] = useState('');
  const [recall, setRecall] = useState<number | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const specs = session.plugin.commands;
  const entered = session.history.map((h) => h.line);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [session.history.length]);

  const hint = (() => {
    if (input.trim() === '') return `commands: ${specs.map((s) => s.name).join(', ')}`;
    const c = complete(input, specs);
    if (c.candidates.length > 0) return c.candidates.join('  ');
    return c.hint ?? '';
  })();

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      onRun(input);
      setInput('');
      setRecall(null);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const c = complete(input, specs);
      if (c.candidates.length === 1) setInput(`${c.candidates[0] as string} `);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (entered.length === 0) return;
      const next = recall === null ? entered.length - 1 : Math.max(0, recall - 1);
      setRecall(next);
      setInput(entered[next] as string);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (recall === null) return;
      const next = recall + 1;
      if (next >= entered.length) { setRecall(null); setInput(''); return; }
      setRecall(next);
      setInput(entered[next] as string);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div ref={logRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-xs">
        {session.history.length === 0 && (
          <div className="text-[var(--faint)]">
            {help(specs).map((line) => <div key={line}>{line}</div>)}
          </div>
        )}
        {session.history.map((h, i) => (
          <div key={i} className="pb-1.5">
            <div className="text-[var(--text)]">
              <span className="text-[var(--faint)]">&gt; </span>{h.line}
            </div>
            {h.ok ? (
              <div className="pl-2 text-[var(--dim)]">{h.text}</div>
            ) : (
              <div className="pl-2">
                {h.error?.span !== undefined && (
                  <div className="whitespace-pre text-[var(--bad)]">
                    {`${' '.repeat(h.error.span[0])}${'^'.repeat(Math.max(1, h.error.span[1] - h.error.span[0]))}`}
                  </div>
                )}
                <div className="text-[var(--bad)]">{h.error?.code}: {h.text}</div>
                {h.error?.hint !== undefined && (
                  <div className="text-[var(--faint)]">{h.error.hint}</div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="border-t border-[var(--line)]">
        <div className="truncate px-3 pt-1 font-mono text-[10.5px] text-[var(--faint)]">{hint}</div>
        <div className="flex items-center gap-2 px-3 pb-2">
          <span className="font-mono text-xs text-[var(--faint)]">&gt;</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            spellCheck={false}
            autoComplete="off"
            aria-label="Command"
            placeholder={usage(specs[0] as (typeof specs)[number])}
            className="w-full bg-transparent font-mono text-xs text-[var(--text)] outline-none
                       placeholder:text-[var(--faint)]"
          />
        </div>
      </div>
    </div>
  );
}
