/**
 * Measured cost against the declared curve.
 *
 * The x axis is spaced by log2(n), so a logarithmic cost draws as a straight
 * line and a linear one bends sharply upward. On a linear axis both look like
 * gentle curves and the distinction - which is the entire point - is left to
 * the reader to infer from curvature.
 */

import { useState, type JSX } from 'react';
import { chartGeometry, type ComplexityReport } from '../complexity.ts';

const W = 720;
const H = 340;
const PAD = { top: 46, right: 26, bottom: 46, left: 56 };

interface Props {
  readonly report: ComplexityReport | null;
  readonly pluginName: string;
}

export function Complexity({ report, pluginName }: Props): JSX.Element {
  const [hover, setHover] = useState<number | null>(null);

  if (report === null) {
    return (
      <div className="flex h-full items-center justify-center text-xs italic text-[var(--faint)]">
        This structure does not describe how to measure it.
      </div>
    );
  }

  const { samples, declaredFit, bestFit, declaredGrowth } = report;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const { ticks, xOf, yOf, measured, predicted } = chartGeometry(report, {
    width: W, height: H, ...PAD,
  });

  const path = (points: readonly { x: number; y: number }[]): string =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  const active = hover === null ? null : samples[hover];

  return (
    <div className="flex h-full flex-col gap-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
        aria-label={`${pluginName}: measured cost of ${report.command} against its declared complexity`}>
        {/* Grid and y axis */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} y1={yOf(t)} x2={W - PAD.right} y2={yOf(t)}
              stroke="var(--line)" strokeWidth={1} />
            <text x={PAD.left - 10} y={yOf(t) + 3.5} textAnchor="end"
              className="fill-[var(--faint)] font-mono text-[10px] tabular-nums">{t}</text>
          </g>
        ))}

        {/* x axis */}
        {samples.map((s, i) => (
          <text key={s.n} x={xOf(i)} y={H - PAD.bottom + 18} textAnchor="middle"
            className="fill-[var(--faint)] font-mono text-[10px] tabular-nums">{s.n}</text>
        ))}
        <text x={PAD.left + plotW / 2} y={H - 10} textAnchor="middle"
          className="fill-[var(--dim)] text-[11px]">elements (n), doubling</text>
        <text x={14} y={PAD.top + plotH / 2} textAnchor="middle"
          transform={`rotate(-90 14 ${PAD.top + plotH / 2})`}
          className="fill-[var(--dim)] text-[11px]">nodes touched</text>

        {/* Declared curve, dashed so identity survives without colour */}
        {declaredFit !== null && (
          <path d={path(predicted)} fill="none" stroke="var(--chart-declared)"
            strokeWidth={2} strokeDasharray="6 4" strokeLinecap="round" />
        )}

        {/* Measured */}
        <path d={path(measured)} fill="none" stroke="var(--chart-measured)"
          strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {samples.map((s, i) => (
          <circle key={s.n} cx={measured[i]?.x} cy={measured[i]?.y} r={hover === i ? 6 : 4.5}
            fill="var(--chart-measured)" stroke="var(--panel)" strokeWidth={2} />
        ))}

        {/* Legend - always present, because there are two series */}
        <g>
          <line x1={PAD.left} y1={20} x2={PAD.left + 22} y2={20}
            stroke="var(--chart-measured)" strokeWidth={2} strokeLinecap="round" />
          <circle cx={PAD.left + 11} cy={20} r={4.5} fill="var(--chart-measured)"
            stroke="var(--panel)" strokeWidth={2} />
          <text x={PAD.left + 30} y={24} className="fill-[var(--dim)] text-[11px]">measured</text>
          <line x1={PAD.left + 108} y1={20} x2={PAD.left + 130} y2={20}
            stroke="var(--chart-declared)" strokeWidth={2} strokeDasharray="6 4" strokeLinecap="round" />
          <text x={PAD.left + 138} y={24} className="fill-[var(--dim)] text-[11px]">
            {report.declared ?? 'declared'}{declaredFit === null ? '' : ` × ${declaredFit.constant.toFixed(2)}`}
          </text>
        </g>

        {/* Hover targets, wider than the marks */}
        {samples.map((s, i) => (
          <rect key={s.n} x={xOf(i) - plotW / (samples.length * 2)} y={PAD.top}
            width={plotW / samples.length} height={plotH} fill="transparent"
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
        ))}
        {active !== undefined && active !== null && hover !== null && (
          <g transform={`translate(${xOf(hover) > W / 2 ? xOf(hover) - 132 : xOf(hover) + 12}, ${PAD.top + 8})`}>
            <rect width={120} height={declaredFit === null ? 34 : 50} rx={5}
              fill="var(--panel)" stroke="var(--line)" />
            <text x={10} y={16} className="fill-[var(--text)] font-mono text-[10.5px]">n = {active.n}</text>
            <text x={10} y={30} className="fill-[var(--dim)] font-mono text-[10.5px]">
              measured {active.cost.toFixed(1)}
            </text>
            {declaredFit !== null && (
              <text x={10} y={44} className="fill-[var(--dim)] font-mono text-[10.5px]">
                curve {(declaredFit.predicted[hover] ?? 0).toFixed(1)}
              </text>
            )}
          </g>
        )}
      </svg>

      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-t border-[var(--line)] pt-3 text-xs">
        <span className="text-[var(--dim)]">
          <code className="font-mono text-[var(--text)]">{report.command}</code> declares{' '}
          <code className="font-mono text-[var(--text)]">{report.declared ?? 'nothing'}</code>
        </span>
        {declaredFit !== null && (
          <span className="text-[var(--dim)]">
            fit R² <span className="font-mono tabular-nums text-[var(--text)]">
              {declaredFit.rSquared.toFixed(4)}</span>
          </span>
        )}
        <span className="text-[var(--dim)]">
          measurements look like{' '}
          <code className="font-mono text-[var(--text)]">O({bestFit.growth.label})</code>
        </span>
        <span className={report.agrees ? 'text-[var(--good)]' : 'text-[var(--bad)]'}>
          {declaredGrowth === null
            ? 'no declared curve to check against'
            : report.agrees ? 'agrees with the declaration' : 'disagrees with the declaration'}
        </span>
      </div>

      {/* The numbers, so the chart is not the only way to read this */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-[11px] tabular-nums">
          <thead>
            <tr className="text-[var(--faint)]">
              <th scope="row" className="py-1 pr-3 text-left font-normal">n</th>
              {samples.map((s) => <td key={s.n} className="px-2 py-1 text-right">{s.n}</td>)}
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-[var(--line)]">
              <th scope="row" className="py-1 pr-3 text-left font-normal text-[var(--dim)]">measured</th>
              {samples.map((s) => (
                <td key={s.n} className="px-2 py-1 text-right text-[var(--text)]">{s.cost.toFixed(1)}</td>
              ))}
            </tr>
            {declaredFit !== null && (
              <tr>
                <th scope="row" className="py-1 pr-3 text-left font-normal text-[var(--dim)]">curve</th>
                {declaredFit.predicted.map((p, i) => (
                  <td key={i} className="px-2 py-1 text-right text-[var(--dim)]">{p.toFixed(1)}</td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
