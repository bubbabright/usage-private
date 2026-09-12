import React, { useEffect, useState } from 'react';
import { Activity, RefreshCw, AlertCircle, Clock, CalendarDays, CalendarClock, Wrench } from 'lucide-react';
import {
  resolveGroup, GROUP_ORDER, GROUP_LABEL, CardGroup,
} from './App';
import { ProviderPieMini, PieLegend } from './PieCharts';

// Mirror of App.resetText — countdown until a window resets.
function fmtCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(totalSec / 86400);
  if (d >= 1) return `${d}d`;
  const h = Math.floor(totalSec / 3600);
  if (h >= 1) {
    const m = Math.floor((totalSec % 3600) / 60);
    return `${h}h ${m}m`;
  }
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function resetText(w: any): string | null {
  if (!w.resets_at) return null;
  const ms = new Date(w.resets_at).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return fmtCountdown(ms);
}

// Status dot color matching the existing convention.
function statusDot(status: string, stale: boolean): string {
  if (status === 'ok' && !stale) return 'bg-emerald-500';
  if (status === 'ok') return 'bg-amber-500';
  return 'bg-red-500';
}

// Card group section header with icon.
function SectionHeader({ title, icon }: { title: string; icon: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      {icon}
      <h3 className="font-medium text-neutral-100">{title}</h3>
    </div>
  );
}

// Single provider card — donut chart replaces ActivityBar.
// Shows: provider header, pie chart, legend with values, reset countdowns.
// Providers with no numeric pct on any window (e.g. Deepgram's $ balance)
// get a plain balance display instead of a pie — there's no 100% to fill.
function PieProviderCard({ p, onJump }: { p: any; onJump: (provider: string) => void }) {
  const windows = p.windows || [];
  const hasWindows = windows.length > 0;
  const resetTexts = windows.map((w: any) => resetText(w));
  const hasPct = windows.some((w: any) => typeof w?.pct === 'number');

  // Format a window's value for display — balances ($/counts) or percentages.
  const valueLine = (w: any) => {
    if (typeof w?.pct === 'number') return `${w.pct.toFixed(1)}%`;
    if (w?.unit && typeof w?.used === 'number') {
      if (w.unit.toLowerCase() === 'usd') return `$${w.used.toLocaleString()}`;
      return `${w.used.toLocaleString()} ${w.unit}`;
    }
    return '—';
  };

  return (
    <button
      onClick={() => onJump(p.provider)}
      className="text-left bg-neutral-900 border border-neutral-800 rounded-xl p-5 hover:border-neutral-700 transition-colors"
    >
      <div className="flex items-center gap-2 mb-4">
        <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot(p.status, p.stale)}`} />
        <span className="capitalize font-medium text-neutral-100">{p.provider}</span>
        {p.status !== 'ok' && (
          <span className="text-xs text-red-400 ml-auto">{p.status}{p.stale ? ' (stale)' : ''}</span>
        )}
      </div>

      {!hasWindows && (
        <div className="text-xs text-neutral-400">no data yet</div>
      )}

      {hasWindows && hasPct && (
        <div className="flex flex-col items-center gap-3">
          <div className="flex flex-wrap justify-center gap-3">
            {windows.map((_w: any, i: number) => (
              <div key={i} className="flex flex-col items-center gap-1">
                <ProviderPieMini provider={p.provider} windows={[windows[i]]} size={100} />
                <span className="text-[10px] text-neutral-400 truncate max-w-[80px] text-center">
                  {windows[i].label || windows[i].id}
                </span>
                {resetTexts[i] && (
                  <span className="text-[9px] text-neutral-500 flex items-center gap-0.5">
                    <Clock size={8} /> {resetTexts[i]}
                  </span>
                )}
              </div>
            ))}
          </div>
          <PieLegend windows={windows} />
        </div>
      )}

      {hasWindows && !hasPct && (
        <div className="flex flex-col gap-1.5">
          {windows.map((w: any, i: number) => (
            <div key={i} className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-neutral-400 truncate text-xs">{w.label || w.id}</span>
                {resetTexts[i] && (
                  <span className="text-[9px] text-neutral-500 flex items-center gap-0.5 shrink-0">
                    <Clock size={8} /> {resetTexts[i]}
                  </span>
                )}
              </div>
              <span className="text-sm font-medium text-neutral-100 tabular-nums shrink-0">
                {valueLine(w)}
              </span>
            </div>
          ))}
        </div>
      )}
    </button>
  );
}

// Grouped providers share one card per group; mini pies inside.
function PieGroupedCard({ title, subtitle, icon, providers, onJump, layout = 'grid' }: {
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  providers: any[];
  onJump: (p: string) => void;
  layout?: 'list' | 'grid';
}) {
  if (!providers.length) return null;

  // Format a window's value for display — balances ($/counts) or percentages.
  const valueLine = (w: any) => {
    if (typeof w?.pct === 'number') return `${w.pct.toFixed(1)}%`;
    if (w?.unit && typeof w?.used === 'number') {
      if (w.unit.toLowerCase() === 'usd') return `$${w.used.toLocaleString()}`;
      return `${w.used.toLocaleString()} ${w.unit}`;
    }
    return '—';
  };

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
      <SectionHeader title={title} icon={icon} />
      {subtitle && <span className="text-xs text-neutral-500 block mb-3">{subtitle}</span>}

      {layout === 'grid' ? (
        <div className="columns-[140px] gap-2">
          {providers.map((p) => {
            const hasPct = (p.windows || []).some((w: any) => typeof w?.pct === 'number');
            return (
              <button
                key={p.provider}
                onClick={() => onJump(p.provider)}
                className="block w-full text-left p-3 mb-2 rounded-lg border border-neutral-800 bg-neutral-950/40 hover:border-neutral-700 transition-colors break-inside-avoid"
              >
                <div className="flex items-center gap-1.5 mb-2 min-w-0">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot(p.status, p.stale)}`} />
                  <span className="capitalize text-xs text-neutral-400 truncate">{p.provider}</span>
                </div>
                {hasPct ? (
                  <>
                    <div className="flex justify-center">
                      <ProviderPieMini provider={p.provider} windows={p.windows || []} size={90} />
                    </div>
                    <PieLegend windows={p.windows || []} />
                  </>
                ) : (
                  <div className="flex flex-col gap-1">
                    {(p.windows || []).map((w: any, i: number) => (
                      <div key={i} className="flex items-center justify-between text-xs">
                        <span className="text-neutral-400 truncate">{w.label || w.id}</span>
                        <span className="text-neutral-200 tabular-nums shrink-0">{valueLine(w)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-neutral-800">
          {providers.map((p) => {
            const hasPct = (p.windows || []).some((w: any) => typeof w?.pct === 'number');
            return (
              <button
                key={p.provider}
                onClick={() => onJump(p.provider)}
                className="text-left py-2.5 first:pt-0 last:pb-0 hover:opacity-80 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot(p.status, p.stale)}`} />
                  <span className="capitalize text-sm text-neutral-300 truncate">{p.provider}</span>
                  <span className="ml-auto text-[10px] text-neutral-500">{(p.windows || []).length} window(s)</span>
                </div>
                <div className="mt-1 pl-3.5 flex items-center gap-3">
                  {hasPct ? (
                    <>
                      <ProviderPieMini provider={p.provider} windows={p.windows || []} size={70} />
                      <PieLegend windows={p.windows || []} />
                    </>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {(p.windows || []).map((w: any, i: number) => (
                        <div key={i} className="flex items-center justify-between text-xs">
                          <span className="text-neutral-400 truncate">{w.label || w.id}</span>
                          <span className="text-neutral-200 tabular-nums shrink-0">{valueLine(w)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const BOARD_REFRESH_S = 30;

function OverviewBoardPie({ providers, cardGroup, onJump, fetchedAt }: {
  providers: any[];
  cardGroup: Record<string, CardGroup>;
  onJump: (p: string) => void;
  fetchedAt: number | null;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (!providers.length) {
    return <div className="flex items-center justify-center h-full text-neutral-400">No providers configured</div>;
  }

  const byGroup = (g: CardGroup) =>
    providers.filter((p) => resolveGroup(p, cardGroup) === g).sort((a, b) => a.provider.localeCompare(b.provider));
  const support = byGroup('support');
  const daily = byGroup('daily');
  const weekly = byGroup('weekly');
  const monthly = byGroup('monthly');
  const sorted = byGroup('none');

  const secondsSinceFetch = fetchedAt != null ? Math.floor((Date.now() - fetchedAt) / 1000) : null;
  const nextRefreshS = secondsSinceFetch != null ? Math.max(0, BOARD_REFRESH_S - secondsSinceFetch) : null;

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-2">
          <Activity size={18} className="text-emerald-400" />
          <h2 className="text-lg font-semibold text-neutral-100">Overview</h2>
          <span className="text-xs text-neutral-500">pie view</span>
        </div>
        <span title="Time until this board's data refreshes" className="flex items-center gap-1.5 text-xs text-neutral-400">
          <RefreshCw size={13} className="text-neutral-500" />
          {nextRefreshS != null ? `${nextRefreshS}s` : ''}
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(360px,1fr))] gap-4">
        <PieGroupedCard title="Support Services" subtitle="metered APIs" icon={<Wrench size={16} className="text-neutral-400" />} providers={support} onJump={onJump} layout="grid" />
        <PieGroupedCard title="Daily" icon={<CalendarDays size={16} className="text-neutral-400" />} providers={daily} onJump={onJump} />
        <PieGroupedCard title="Weekly" icon={<CalendarClock size={16} className="text-neutral-400" />} providers={weekly} onJump={onJump} />
        <PieGroupedCard title="Monthly" icon={<CalendarClock size={16} className="text-neutral-400" />} providers={monthly} onJump={onJump} />
        {sorted.map((p) => (
          <PieProviderCard key={p.provider} p={p} onJump={onJump} />
        ))}
      </div>
    </div>
  );
}

export { OverviewBoardPie };
