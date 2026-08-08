/**
 * Version comparison.
 *
 * Appears whenever the replayed scene has two or more versions - driven by the
 * data, not by knowing that some plugin has a `compare` command. A structure
 * without history never shows it.
 */

import type { JSX } from 'react';
import type { NodeId } from '@algoverse/core';
import type { DiffResult } from '../diff.ts';

function Swatch({ className, label, count }: {
  readonly className: string;
  readonly label: string;
  readonly count: number;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <svg width="22" height="15" aria-hidden="true" className="shrink-0">
        <rect x="1.5" y="1.5" width="19" height="12" rx="3"
          fill="var(--av-node-bg)" stroke="var(--av-c0)" className={className} />
      </svg>
      <span className="text-[var(--dim)]">{label}</span>
      <span className="ml-auto font-mono tabular-nums">{count}</span>
    </div>
  );
}

export function DiffPanel({ versions, a, b, onChange, result }: {
  readonly versions: readonly NodeId[];
  readonly a: number;
  readonly b: number;
  readonly onChange: (a: number, b: number) => void;
  readonly result: DiffResult | null;
}): JSX.Element {
  const options = versions.map((_, i) => i);
  const pick = (value: number, onPick: (n: number) => void, label: string): JSX.Element => (
    <select
      value={value}
      onChange={(e) => onPick(Number(e.target.value))}
      aria-label={label}
      className="rounded border border-[var(--line)] bg-[var(--bg)] px-1 py-0.5 font-mono text-[11px]"
    >
      {options.map((i) => <option key={i} value={i}>v{i}</option>)}
    </select>
  );

  return (
    <div className="flex flex-col gap-2.5 text-xs">
      <div className="flex items-center gap-2">
        {pick(a, (n) => onChange(n, b), 'Compare from')}
        <span className="text-[var(--faint)]">against</span>
        {pick(b, (n) => onChange(a, n), 'Compare to')}
      </div>

      {result === null ? (
        <p className="italic text-[var(--faint)]">Pick two versions.</p>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <Swatch className="av-legend-primary" label="in both" count={result.diff.shared.length} />
            <Swatch className="av-legend-secondary" label={`only v${a}`} count={result.diff.onlyA.length} />
            <Swatch className="av-legend-secondary" label={`only v${b}`} count={result.diff.onlyB.length} />
          </div>
          <div className="border-t border-[var(--line)] pt-2">
            <div className="font-mono text-2xl font-semibold tabular-nums text-[var(--accent)]">
              {Math.round(result.diff.sharedRatio * 100)}%
            </div>
            <div className="text-[11px] text-[var(--dim)]">
              of v{b} was reused from v{a}, not rebuilt
            </div>
          </div>
        </>
      )}
    </div>
  );
}
