import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type JSX } from 'react';
import { usage, type NodeId } from '@algoverse/core';
import { PLUGINS, Session, describeEvent } from './engine.ts';
import { useUi } from './store.ts';
import { Scene } from './components/Scene.tsx';
import { Console } from './components/Console.tsx';
import { Inspector, Stats } from './components/Inspector.tsx';
import { DiffPanel } from './components/Diff.tsx';
import { computeDiff } from './diff.ts';

const BTN = 'rounded border border-[var(--line)] bg-[var(--bg)] px-2 py-1 font-mono text-[11px] ' +
  'text-[var(--text)] hover:border-[var(--faint)] focus-visible:outline focus-visible:outline-2 ' +
  'focus-visible:outline-[var(--accent)] disabled:opacity-35';

function Panel({ title, children, className = '' }: {
  readonly title: string;
  readonly children: React.ReactNode;
  readonly className?: string;
}): JSX.Element {
  return (
    <section className={`flex min-h-0 flex-col rounded-lg border border-[var(--line)] bg-[var(--panel)] ${className}`}>
      <h2 className="border-b border-[var(--line)] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--faint)]">
        {title}
      </h2>
      <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
    </section>
  );
}

export function App(): JSX.Element {
  const {
    pluginId, setPlugin, selected, select, showLabels, toggleLabels,
    mode, setMode, diffA, diffB, setDiff,
  } = useUi();
  const [epoch, setEpoch] = useState(0);

  const plugin = PLUGINS.find((p) => p.meta.id === pluginId) ?? (PLUGINS[0] as typeof PLUGINS[number]);
  // A new Session per plugin (and per reset); the engine object itself is the
  // source of truth, so React only ever holds a reference to it.
  const session = useMemo(() => new Session(plugin), [plugin, epoch]);

  useSyncExternalStore(session.subscribe, session.getVersion, session.getVersion);

  const { playback } = session;

  // The animation loop lives here, not inside Playback: the engine is told how
  // much time passed, it never reads a clock itself.
  useEffect(() => {
    if (!playback.playing) return;
    let frame = 0;
    let previous = performance.now();
    const step = (now: number): void => {
      playback.tick(now - previous);
      previous = now;
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playback, playback.playing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === ' ') { e.preventDefault(); playback.toggle(); }
      if (e.key === 'ArrowRight') { e.preventDefault(); (e.shiftKey ? playback.nextMark() : playback.next()); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); (e.shiftKey ? playback.prevMark() : playback.prev()); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playback]);

  const view = session.view();
  const onSelect = useCallback((id: NodeId | null) => select(id), [select]);

  const versions = view.state.versions;
  const canDiff = versions.length >= 2;
  const diff = canDiff && mode === 'diff'
    ? computeDiff(view.state, session.layoutHint, diffA, Math.min(diffB, versions.length - 1))
    : null;

  return (
    <div className="grid h-screen grid-rows-[auto_minmax(0,1fr)] gap-2 bg-[var(--bg)] p-2 text-[var(--text)]">
      <header className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2">
        <strong className="text-sm font-semibold">AlgoVerse</strong>
        <span className="font-mono text-[11px] text-[var(--faint)]">{plugin.meta.name}</span>
        <span className="flex-1" />
        <button className={BTN} onClick={() => playback.first()} aria-label="First step">|&lt;</button>
        <button className={BTN} onClick={() => playback.prevMark()} aria-label="Previous operation">&laquo;</button>
        <button className={BTN} onClick={() => playback.prev()} aria-label="Previous step">&lsaquo;</button>
        <button className={`${BTN} min-w-[52px]`} onClick={() => playback.toggle()}>
          {playback.playing ? 'pause' : 'play'}
        </button>
        <button className={BTN} onClick={() => playback.next()} aria-label="Next step">&rsaquo;</button>
        <button className={BTN} onClick={() => playback.nextMark()} aria-label="Next operation">&raquo;</button>
        <button className={BTN} onClick={() => playback.last()} aria-label="Last step">&gt;|</button>
        <input
          type="range" min={0} max={Math.max(1, playback.length)} value={playback.step}
          onChange={(e) => playback.seek(Number(e.target.value))}
          aria-label="Step" className="min-w-[120px] flex-1 accent-[var(--accent)]"
        />
        <span className="w-[86px] text-right font-mono text-[11px] tabular-nums text-[var(--dim)]">
          {playback.step}/{playback.length}
        </span>
        <select
          value={playback.speed}
          onChange={(e) => playback.setSpeed(Number(e.target.value))}
          aria-label="Speed"
          className="rounded border border-[var(--line)] bg-[var(--bg)] px-1 py-1 font-mono text-[11px]"
        >
          {[0.5, 1, 2, 4, 8].map((s) => <option key={s} value={s}>{s}x</option>)}
        </select>
      </header>

      <div className="grid min-h-0 grid-cols-[190px_minmax(0,1fr)_260px] gap-2">
        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-2">
          <Panel title="Structures">
            <ul className="flex flex-col gap-1">
              {PLUGINS.map((p) => (
                <li key={p.meta.id}>
                  <button
                    onClick={() => setPlugin(p.meta.id)}
                    className={`w-full rounded px-2 py-1 text-left text-xs ${
                      p.meta.id === pluginId
                        ? 'bg-[var(--bg)] font-medium text-[var(--text)]'
                        : 'text-[var(--dim)] hover:bg-[var(--bg)]'}`}
                  >
                    {p.meta.name}
                    <span className="block text-[10px] text-[var(--faint)]">{p.meta.category}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title="Commands">
            <ul className="flex flex-col gap-2 font-mono text-[10.5px]">
              {plugin.commands.map((c) => (
                <li key={c.name}>
                  <div className="text-[var(--text)]">{usage(c)}</div>
                  <div className="text-[var(--faint)]">{c.summary}</div>
                  {c.complexity !== undefined && (
                    <div className="text-[var(--accent)]">{c.complexity}</div>
                  )}
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_210px] gap-2">
          <section className="flex min-h-0 flex-col rounded-lg border border-[var(--line)] bg-[var(--panel)]">
            <div className="flex items-center justify-between border-b border-[var(--line)] px-3 py-1.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--faint)]">Canvas</span>
              <span className="font-mono text-[10.5px] text-[var(--dim)]">
                {mode === 'diff' && diff !== null
                  ? `v${diffA} vs v${Math.min(diffB, versions.length - 1)} — ${diff.diff.shared.length} shared`
                  : describeEvent(session.currentEvent())}
              </span>
              <div className="flex items-center gap-3">
                {canDiff && (
                  <label className="flex items-center gap-1.5 font-mono text-[10px] text-[var(--faint)]">
                    <input
                      type="checkbox" checked={mode === 'diff'}
                      onChange={() => setMode(mode === 'diff' ? 'live' : 'diff')}
                    />compare
                  </label>
                )}
                <label className="flex items-center gap-1.5 font-mono text-[10px] text-[var(--faint)]">
                  <input type="checkbox" checked={showLabels} onChange={toggleLabels} />labels
                </label>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              <Scene
                scene={view.scene} visited={diff === null ? view.visited : []} selected={selected}
                showLabels={showLabels} onSelect={onSelect}
                {...(diff === null ? {} : { emphasis: diff.emphasis })}
              />
            </div>
          </section>
          <section className="flex min-h-0 flex-col rounded-lg border border-[var(--line)] bg-[var(--panel)]">
            <div className="flex items-center justify-between border-b border-[var(--line)] px-3 py-1.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--faint)]">Console</span>
              <button className={BTN} onClick={() => { select(null); setEpoch((e) => e + 1); }}>reset</button>
            </div>
            <div className="min-h-0 flex-1">
              <Console session={session} onRun={(line) => session.run(line)} />
            </div>
          </section>
        </div>

        <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-2">
          <Panel title={mode === 'diff' ? 'Compare versions' : 'Inspector'}>
            {mode === 'diff' && canDiff ? (
              <DiffPanel
                versions={versions} a={diffA} b={Math.min(diffB, versions.length - 1)}
                onChange={setDiff} result={diff}
              />
            ) : (
              <Inspector state={view.state} selected={selected} />
            )}
          </Panel>
          <Panel title="Statistics">
            <Stats state={view.state} stats={session.stats} />
          </Panel>
        </div>
      </div>
    </div>
  );
}
