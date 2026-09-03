import React, { useEffect, useState, useMemo, useRef } from 'react';
import { 
  Activity, Bell, Server, Settings, History, TrendingUp, TrendingDown, AlertCircle, RefreshCw, Power, RotateCw, Play,
  Bot, Brain, Cloud, Terminal, Wrench, Zap, Mic, Scan, Search, Database, Cpu, HardDrive, Network, Shield, Key, Link, ExternalLink, BookOpen, GraduationCap, MessageSquare, AudioLines, Rocket, GitBranch,
  Clock, Calendar, CalendarDays, CalendarClock, ChevronLeft, ChevronRight, ChevronDown
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { ProviderSettingsModal } from './SettingsView';
import { GlobalSettingsModal } from './GlobalSettingsModal';

import claudeLogo from './assets/providers/claude.svg?raw';
import grokLogo from './assets/providers/grok.svg?raw';
import mistralLogo from './assets/providers/mistral.svg?raw';
import ollamaLogo from './assets/providers/ollama.svg?raw';
import cloudflareLogo from './assets/providers/cloudflare.svg?raw';
import groqLogo from './assets/providers/groq.svg?raw';
import firecrawlLogo from './assets/providers/firecrawl.svg?raw';
import opencodeGoLogo from './assets/providers/opencode-go.svg?raw';
import tavilyLogo from './assets/providers/tavily.svg?raw';
import openrouterLogo from './assets/providers/openrouter.svg?raw';

const SCOPE_LABEL: Record<string, string> = { poll: 'Since poll', '12h': 'Last 12h', '24h': 'Last 24h' };

// Bar/accent color by window POSITION, not by provider or metric identity: a
// provider's only window is always yellow; a provider's second window is always
// blue. Anything beyond a 2nd window keeps its own daemon-assigned color (not
// covered by this rule). Colors are Okabe-Ito (colorblind-safe, matches the rest
// of the palette already used suite-wide).
const POSITION_YELLOW = '#F0E442';
const POSITION_BLUE = '#56B4E9';
function windowColor(index: number, fallback: string | undefined): string {
  if (index === 0) return POSITION_YELLOW;
  if (index === 1) return POSITION_BLUE;
  return fallback || '#6b7280';
}

// Which compact card / sidebar branch a provider belongs to. Fully user-configurable
// (GlobalSettingsModal) — the daemon's `category:'support'` tag is only the fallback
// default for a provider that's never been explicitly assigned. 'none' = today's full
// rich per-provider card, and the sidebar's plain "Providers" branch.
export type CardGroup = 'daily' | 'weekly' | 'monthly' | 'support' | 'none';
export const GROUP_ORDER: CardGroup[] = ['daily', 'weekly', 'monthly', 'support', 'none'];
export const GROUP_LABEL: Record<CardGroup, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  support: 'Support Services',
  none: 'Providers',
};

// One-time seed written to localStorage the first time the app loads (see App()'s
// cardGroup state below) — after that, Daniel's own choices in Settings are what persist.
const DEFAULT_CARD_GROUPS: Record<string, CardGroup> = {
  cloudflare: 'daily', grok: 'daily', groq: 'daily', llm7: 'daily', openrouter: 'daily',
  claude: 'weekly', ollama: 'weekly', 'opencode-go': 'weekly',
  hyper: 'monthly', abacus: 'monthly', mistral: 'monthly', cohere: 'monthly',
};

// A provider's group: explicit choice (cardGroup[provider]) wins; otherwise fall back to
// the daemon's category tag (support vs everything else gets a full card).
export function resolveGroup(p: any, cardGroup: Record<string, CardGroup>): CardGroup {
  return cardGroup[p.provider] ?? (p.category === 'support' ? 'support' : 'none');
}

// Provider -> brand logo mapping (currentColor SVGs, rendered inline so they inherit the same
// className tint as the lucide fallback below -- an <img src> wouldn't pick up currentColor).
const PROVIDER_LOGOS: Record<string, string> = {
  claude: claudeLogo,
  grok: grokLogo,
  mistral: mistralLogo,
  ollama: ollamaLogo,
  cloudflare: cloudflareLogo,
  groq: groqLogo,
  firecrawl: firecrawlLogo,
  'opencode-go': opencodeGoLogo,
  tavily: tavilyLogo,
  openrouter: openrouterLogo,
};

// Provider -> icon mapping for visual identification (fallback for providers with no brand logo above)
export function ProviderIcon({ provider, className = '', size = 16 }: { provider: string; className?: string; size?: number }) {
  const logo = PROVIDER_LOGOS[provider];
  if (logo) {
    const sized = logo.replace(/width="[^"]*"/, `width="${size}"`).replace(/height="[^"]*"/, `height="${size}"`);
    return (
      <span
        className={className}
        style={{ display: 'inline-flex', lineHeight: 0 }}
        dangerouslySetInnerHTML={{ __html: sized }}
      />
    );
  }
  const icons: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
    ollama: Server,
    claude: Bot,
    grok: Brain,
    mistral: Bot,
    'opencode-go': Terminal,
    cloudflare: Cloud,
    deepgram: Mic,
    groq: Zap,
    firecrawl: Scan,
    llm7: Cpu,
    abacus: TrendingUp,
    hyper: Wrench,
    serpapi: Search,
    context7: BookOpen,
    consensus: GraduationCap,
    cohere: MessageSquare,
    elevenlabs: AudioLines,
    runpod: Rocket,
    github: GitBranch,
  };
  const Icon = icons[provider] || icons[provider.split('-')[0]] || Server;
  return <Icon size={size} className={className} />;
}

// Window type -> icon mapping
function WindowIcon({ window }: { window: any }) {
  const id = window.id?.toLowerCase() || '';
  const label = window.label?.toLowerCase() || '';
  const unit = window.unit?.toLowerCase() || '';
  
  if (id.includes('token') || label.includes('token') || unit.includes('token')) return <Database size={14} className="text-neutral-400" />;
  if (id.includes('request') || label.includes('request')) return <Cpu size={14} className="text-neutral-400" />;
  if (id.includes('cost') || label.includes('cost') || unit.includes('$')) return <Zap size={14} className="text-neutral-400" />;
  if (id.includes('minute') || label.includes('minute') || unit.includes('min')) return <Clock size={14} className="text-neutral-400" />;
  if (id.includes('day') || label.includes('daily')) return <Calendar size={14} className="text-neutral-400" />;
  if (id.includes('month') || label.includes('monthly')) return <Calendar size={14} className="text-neutral-400" />;
  if (id.includes('week') || label.includes('weekly')) return <Calendar size={14} className="text-neutral-400" />;
  if (id.includes('session') || label.includes('session')) return <Activity size={14} className="text-neutral-400" />;
  if (id.includes('vibe') || label.includes('vibe')) return <Brain size={14} className="text-neutral-400" />;
  if (id.includes('primary') || label.includes('primary')) return <Server size={14} className="text-neutral-400" />;
  return <Database size={14} className="text-neutral-400" />;
}

// Pinned bar across every page — surfaces the single biggest %-point mover
// per time scope (poll/12h/24h) across ALL providers, so a big jump doesn't
// go unnoticed just because you're looking at a different provider's tab.
function HeadlineBar({ onJump, hidden, showDepletion }: { onJump: (provider: string) => void; hidden: Set<string>; showDepletion: boolean }) {
  const [headline, setHeadline] = useState<Record<string, any>>({});

  useEffect(() => {
    const fetchHeadline = async () => {
      try {
        const res = await fetch('/usage/headline');
        if (res.ok) setHeadline(await res.json());
      } catch (err) {
        console.error(err);
      }
    };
    fetchHeadline();
    const interval = setInterval(fetchHeadline, 30000);
    return () => clearInterval(interval);
  }, []);

  // Drop movers for providers the user hid — the daemon still ranks them, we
  // just don't surface them here.
  const entries = Object.entries(headline).filter(
    ([scope, mover]) => mover && !hidden.has(mover.provider) && (showDepletion || scope !== 'depleting'),
  );
  if (!entries.length) return null;

  return (
    <div className="w-full bg-neutral-900 border-b border-neutral-800 px-4 py-2 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs shrink-0">
      {entries.map(([scope, mover]) =>
        scope === 'depleting' ? (
          <button
            key={scope}
            onClick={() => onJump(mover.provider)}
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
            title={`${mover.provider_label} · ${mover.window_label}: ${mover.pct.toFixed(1)}% used, resets ${mover.resets_at ? formatDistanceToNow(new Date(mover.resets_at), { addSuffix: true }) : 'unknown'}`}
          >
            <span className="text-red-400 uppercase tracking-wider font-semibold">Depleting</span>
            <AlertCircle size={14} className="text-red-400 shrink-0" />
            <span className="text-neutral-200 font-medium">
              {mover.provider_label} {mover.window_label}
            </span>
            <span className="text-red-400">
              runs out {formatDistanceToNow(Date.now() + mover.eta_ms, { addSuffix: true })}
            </span>
          </button>
        ) : (
          <button
            key={scope}
            onClick={() => onJump(mover.provider)}
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
            title={`${mover.provider_label} · ${mover.window_label}: ${mover.from_pct.toFixed(1)}% → ${mover.to_pct.toFixed(1)}%`}
          >
            <span className="text-neutral-400 uppercase tracking-wider font-semibold">{SCOPE_LABEL[scope] || scope}</span>
            {mover.delta >= 0 ? (
              <TrendingUp size={14} className="text-red-400 shrink-0" />
            ) : (
              <TrendingDown size={14} className="text-emerald-400 shrink-0" />
            )}
            <span className="text-neutral-200 font-medium">
              {mover.provider_label} {mover.window_label}
            </span>
            <span className={mover.delta >= 0 ? 'text-red-400' : 'text-emerald-400'}>
              {mover.delta >= 0 ? '+' : ''}{mover.delta.toFixed(1)}pt
            </span>
          </button>
        )
      )}
    </div>
  );
}

// Landing board (no provider selected): every provider at a glance — most
// recently refreshed first ("new refreshes") plus its live window usage
// ("what is in use"). Feeds off the /usage/providers list, which now carries a
// trimmed windows summary, so no per-provider fetch. Click a card to drill in.
//
// One compact card per non-'none' group (Support Services + Daily/Weekly/Monthly,
// user-assigned via GlobalSettingsModal — see CardGroup/resolveGroup above). Grouped
// providers stay separate providers — own polling, own history, own detail page — they
// just don't each deserve a full plan card on the overview.
//
// Rows are compact by design: a name, the number, and a bar ONLY when there's a
// cap to be a fraction of. A prepaid balance like deepgram's $197.73 has no
// ceiling, so a bar there would be decoration pretending to be information.
//
// A provider's card membership (which ONE of Support/Daily/Weekly/Monthly it's filed
// under) is a placement choice, not a filter on its data — a multi-window provider
// (Claude: 5h+7d+monthly; Grok: weekly+monthly; Ollama: session+weekly; Opencode-go:
// 5h+weekly+monthly) shows ALL of its windows stacked in its row wherever it's filed,
// same as the full per-provider card does. Nothing gets dropped just because the
// provider only has one card slot.
function GroupedCard({ title, subtitle, icon, providers, onJump, layout = 'list' }: {
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  providers: any[];
  onJump: (p: string) => void;
  layout?: 'list' | 'grid';
}) {
  if (!providers.length) return null;

  // `used` means different things per provider: most support-service plugins already
  // invert it to "remaining" (used_is_remaining) before it gets here, so the plain
  // number already reads as "how much is left" (context7 "988 requests" = 988 left of
  // 1000). A provider that reports true consumed count instead (Consensus: used=0
  // messages sent) needs the opposite treatment — showing "0 messages" as-is reads as
  // "nothing available" when it actually means "everything's still available" (15/15).
  // So only THAT case (a real cap, no used_is_remaining flag) gets the remaining/cap
  // framing; everything else keeps the plain number it already had.
  // Compact notation (10K, 1M). The row/tile label already names the unit
  // ("Neurons", "Tokens") and an A/B fraction already implies what's left,
  // so neither is repeated in the value — before this trimmed to
  // "9.97K/10K neurons left" with the unit appearing twice in one row.
  const valueText = (w: any) => {
    if (w?.unit && typeof w.used === 'number') {
      if (!w.used_is_remaining && typeof w.cap === 'number') {
        const remaining = Math.max(0, w.cap - w.used);
        const n = remaining.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 2 });
        const c = w.cap.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 2 });
        return `${n} / ${c}`;
      }
      const n = w.used.toLocaleString(undefined, { maximumFractionDigits: 2 });
      return w.unit.toLowerCase() === 'usd' ? `$${n}` : n;
    }
    return typeof w?.pct === 'number' ? `${w.pct.toFixed(1)}%` : '—';
  };

  // List rows: each window is its own inline "label ... value" line (reset
  // countdown next to the label when known, bar below, full width) — label
  // always shown since these rows are wide enough to spare it.
  const listWindowLines = (p: any) =>
    p.windows?.length ? (
      <div className="flex flex-col gap-1">
        {p.windows.map((w: any, i: number) => {
          const hasBar = typeof w?.pct === 'number';
          const reset = resetText(w);
          // Exhausted = already at/over the wall. will_deplete is a forecast and
          // can't flag a bucket that got there before the projection could.
          const exhausted = hasBar && w.pct >= 100;
          return (
            <div key={w.id}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-1 min-w-0">
                  <span className="text-xs text-neutral-500 truncate" title={w.note || undefined}>{w.label || w.id}</span>
                  {exhausted && <AlertCircle size={12} className="text-red-400 shrink-0" />}
                  {reset && (
                    <span title={`resets in ${reset}`} className="flex items-center gap-0.5 text-[10px] font-medium text-neutral-400 shrink-0">
                      <Clock size={9} className="text-neutral-500" />
                      {reset}
                    </span>
                  )}
                </div>
                <span className={`text-sm font-medium shrink-0 tabular-nums ${exhausted ? 'text-red-400' : 'text-neutral-100'}`}>{valueText(w)}</span>
              </div>
              {hasBar && (
                <div className="h-1 w-full bg-neutral-800 rounded-full overflow-hidden mt-0.5">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.min(100, w.pct)}%`, backgroundColor: exhausted ? '#ef4444' : windowColor(i, w.color) }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    ) : (
      <div className="text-xs text-neutral-500">no data yet</div>
    );

  // Grid tiles: kept deliberately small — no bars (the number is the point at this
  // density), tight line-height, sized to its own content (items-start on the grid
  // container, see below — otherwise CSS Grid stretches every tile in a row to match
  // the tallest one). A single-window provider gets one big bold number; a
  // multi-window one (Consensus, Elevenlabs) gets a small label above each value
  // instead of squeezing both onto one line, which was truncating longer labels.
  // Reset countdown, when known, rides on the label line (single-window: next to
  // the value itself, since there's no separate label line to carry it).
  const gridWindowLines = (p: any) =>
    p.windows?.length ? (
      p.windows.length === 1 ? (
        (() => {
          const w = p.windows[0];
          const reset = resetText(w);
          return (
            <div className="flex flex-col">
              {/* Tiny label line (same style as multi-window tiles below) —
                  valueText no longer repeats the unit, so this names it. */}
              <span className="text-[10px] text-neutral-500 leading-tight truncate">{w.label || w.id}</span>
              <div className="flex items-baseline gap-1.5 flex-wrap">
                <span className="text-base font-bold text-neutral-100 tabular-nums leading-tight">{valueText(w)}</span>
                {reset && (
                  <span title={`resets in ${reset}`} className="flex items-center gap-0.5 text-[10px] font-medium text-neutral-500 shrink-0">
                    <Clock size={9} />
                    {reset}
                  </span>
                )}
              </div>
            </div>
          );
        })()
      ) : (
        <div className="flex flex-col gap-1">
          {p.windows.map((w: any) => {
            const reset = resetText(w);
            return (
              <div key={w.id}>
                <div className="flex items-center gap-1 text-[10px] text-neutral-500 leading-tight">
                  <span className="truncate">{w.label || w.id}</span>
                  {reset && (
                    <span title={`resets in ${reset}`} className="flex items-center gap-0.5 shrink-0">
                      <Clock size={9} />
                      {reset}
                    </span>
                  )}
                </div>
                <span className="text-sm font-semibold text-neutral-100 tabular-nums leading-tight">{valueText(w)}</span>
              </div>
            );
          })}
        </div>
      )
    ) : (
      <span className="text-xs text-neutral-500">no data yet</span>
    );

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        {icon}
        <h3 className="font-medium text-neutral-100">{title}</h3>
        {subtitle && <span className="text-xs text-neutral-500">{subtitle}</span>}
      </div>

      {layout === 'grid' ? (
        // CSS multi-column, not grid: a grid row's track height is set by its
        // tallest cell even with items-start on the cells themselves (items-start
        // only stops the cell content from stretching to fill that height — the
        // empty space is still reserved), so a 3-window tile like Consensus left a
        // dead gap under its shorter same-row neighbors (Context7, Deepgram).
        // Columns lay out independently per column instead, so each tile stacks
        // directly under the previous one in its own column — no shared row height.
        <div className="columns-[120px] gap-2">
          {providers.map((p) => (
            <button
              key={p.provider}
              onClick={() => onJump(p.provider)}
              className="block w-full text-left p-2 mb-2 rounded-lg border border-neutral-800 bg-neutral-950/40 hover:border-neutral-700 transition-colors break-inside-avoid"
            >
              <div className="flex items-center gap-1.5 mb-1 min-w-0">
                <ProviderIcon
                  provider={p.provider}
                  size={13}
                  className={`shrink-0 ${p.status === 'ok' && !p.stale ? 'text-emerald-400' : p.status === 'ok' ? 'text-amber-400' : p.status ? 'text-red-500' : 'text-neutral-400'}`}
                />
                <span className="capitalize text-xs text-neutral-400 truncate">{p.provider}</span>
              </div>
              {p.status === 'ok' ? gridWindowLines(p) : <span className="text-sm font-medium text-red-400">{p.status}</span>}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-neutral-800">
          {providers.map((p) => (
            <button
              key={p.provider}
              onClick={() => onJump(p.provider)}
              className="text-left py-2.5 first:pt-0 last:pb-0 hover:opacity-80 transition-opacity"
            >
              <div className="flex items-center gap-2 min-w-0">
                <ProviderIcon
                  provider={p.provider}
                  size={14}
                  className={`shrink-0 ${p.status === 'ok' && !p.stale ? 'text-emerald-400' : p.status === 'ok' ? 'text-amber-400' : p.status ? 'text-red-500' : 'text-neutral-400'}`}
                />
                <span className="capitalize text-sm text-neutral-300 truncate">{p.provider}</span>
                {p.status !== 'ok' && (
                  <span className="text-sm font-medium text-red-400 ml-auto shrink-0">{p.status}</span>
                )}
              </div>
              {p.status === 'ok' && <div className="mt-1 pl-3.5">{listWindowLines(p)}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// V3 Overview redesign — kept as a sibling of OverviewBoard (not an in-place
// edit) so V2 stays pixel-identical and selectable via the header toggle
// while this is being dogfooded. See PLAN-overview-v3 in the repo for the
// full rationale (raw-number-vs-pct fix, activity bar, reset countdown,
// content-driven grid, per-card depleting badge instead of a global bar).

// For a capacity-style resource (unit + used present — Cloudflare neurons,
// Firecrawl credits), the number that's actually useful at a glance is what's
// LEFT, not what's consumed — a plain "%" reads as "how full" when what you
// want to know is "how much runway." `used_is_remaining` (set by a provider
// whose own `used` field already holds a remaining balance, e.g. Firecrawl)
// distinguishes that from the more common `used` = "consumed against cap"
// (e.g. Cloudflare), since the two need opposite math to get to "remaining."
// Everything (raw count AND %) stays visible — nothing hidden, just reframed
// around what's left instead of what's gone.
function primaryMetric(w: any): { primary: string; secondary: string | null; label: string } {
  const label = w.label || w.id;
  const hasCapacity = w.unit && typeof w.used === 'number';

  if (!hasCapacity) {
    const primary = typeof w.pct === 'number' ? `${w.pct.toFixed(1)}%` : '—';
    return { primary, secondary: null, label };
  }

  const remainingCount = w.used_is_remaining
    ? w.used
    : typeof w.cap === 'number' ? Math.max(0, w.cap - w.used) : null;

  // % is already the bar's job (see ActivityBar below) — the primary number
  // is just the raw count so the two aren't saying the same thing twice.
  const countStr = remainingCount != null
    ? remainingCount.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : null;
  const remainingPct = typeof w.pct === 'number' ? Math.max(0, 100 - w.pct) : null;
  const pctStr = remainingPct != null ? `${remainingPct.toFixed(1)}%` : null;

  // Unit dropped from both lines — the fixed-width window label above each
  // row already says "neurons"/"tokens"; repeating it in the number was noise.
  // Bar direction (= consumed side) carries the "left vs used" framing, so no
  // "left" suffix either.
  const primary = countStr != null ? countStr : pctStr != null ? pctStr : '—';

  const usedStr = w.used.toLocaleString(undefined, { maximumFractionDigits: 2 });
  let secondary: string | null = null;
  if (w.id === 'credits' && w.unit === 'credits' && typeof w.cycles_remaining === 'number') {
    secondary = `${w.cycles_remaining} cycle${w.cycles_remaining === 1 ? '' : 's'} banked`;
  } else if (typeof w.cap === 'number') {
    secondary = `${usedStr} / ${w.cap.toLocaleString()} used`;
  } else {
    secondary = `${usedStr} used`;
  }
  return { primary, secondary, label };
}

// Delta color for the activity sliver below — RED everywhere, regardless of
// the provider's own bar color, so scanning down the whole board for "what's
// actively being used right now" is just "look for red."
const ACTIVITY_DELTA_COLOR = '#ef4444';

// Two-tone activity bar — always fills in the consumed direction (matches
// how Cloudflare/Firecrawl's own dashboards read a usage gauge: fuller =
// closer to the limit), independent of whatever the primary number next to
// it says ("323 left" vs "61.0%" — the bar answers "how close to the wall,"
// the number answers whatever's most useful to know). Solid (provider color)
// = where we were an hour ago (or since the window's last reset — see
// runner.js's findActivityBase); the red segment on top of that = what's
// happened since — this hour's real activity, in one consistent color across
// every card. Falls back to a flat single-tone bar when there's no history
// yet at all (brand new provider).
function ActivityBar({ pct, pct1hAgo, color }: { pct: number | null; pct1hAgo: number | null; color: string }) {
  const clamp = (n: number) => Math.min(Math.max(n, 0), 100);
  const cur = clamp(pct || 0);
  const fill = color || '#10b981';
  if (typeof pct1hAgo === 'number') {
    const solid = Math.min(clamp(pct1hAgo), cur); // where we were 1h ago (or since reset)
    return (
      <div className="h-1.5 w-full bg-neutral-800 rounded-full overflow-hidden relative">
        <div className="h-full absolute inset-y-0 left-0" style={{ width: `${solid}%`, backgroundColor: fill }} />
        {cur > solid && (
          <div className="h-full absolute inset-y-0" style={{ left: `${solid}%`, width: `${cur - solid}%`, backgroundColor: ACTIVITY_DELTA_COLOR }} />
        )}
      </div>
    );
  }
  return (
    <div className="h-1.5 w-full bg-neutral-800 rounded-full overflow-hidden">
      <div className="h-full" style={{ width: `${cur}%`, backgroundColor: fill }} />
    </div>
  );
}

// Reset-countdown formatter — deliberately separate from fmtUptime (which
// DaemonPanel uses for "up Xh Ym" and always shows two units). This one's
// granularity is driven purely by how far off the target is, not by the
// window's own scale (5h vs monthly): >=1 day out shows just the day count,
// 1h-1d shows hours+minutes, and under an hour switches to a live-ticking
// mm:ss so the final stretch actually reads as a countdown.
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

// Usage-window reset countdown, not the daemon's poll-interval countdown (that's
// "next refresh in Xs" elsewhere — about when the daemon next hits the provider's
// API, not when the usage window itself resets). Null resets_at (openrouter/
// deepgram always, firecrawl mid-rollover) means there's genuinely no clock to
// show — omit rather than inventing placeholder text.
function resetText(w: any): string | null {
  if (!w.resets_at) return null;
  const ms = new Date(w.resets_at).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return fmtCountdown(ms);
}

// Must match App()'s setInterval(fetchProviders, 30000) — this is purely a
// display of that same client-side refetch cycle, not a second timer.
const BOARD_REFRESH_S = 30;

function OverviewBoardV3({ providers, cardGroup, onJump, showDepletion, fetchedAt }: { providers: any[]; cardGroup: Record<string, CardGroup>; onJump: (p: string) => void; showDepletion: boolean; fetchedAt: number | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (!providers.length) {
    return <div className="flex items-center justify-center h-full text-neutral-400">No providers configured</div>;
  }

  // A provider that's erroring (auth_expired etc.) or stale has nothing current
  // to show — it stays in the sidebar (still flagged there in red) but drops out
  // of the Overview board entirely rather than taking up card space with dead data.
  const okProviders = providers.filter((p) => p.status === 'ok' && !p.stale);

  // Providers collapse into one shared compact card per group instead of taking a full
  // grid cell each — group is user-assigned (GlobalSettingsModal), see resolveGroup above.
  // 'none' (unassigned / explicitly "Full card") keeps today's rich per-provider card.
  const byGroup = (g: CardGroup) =>
    okProviders.filter((p) => resolveGroup(p, cardGroup) === g).sort((a, b) => a.provider.localeCompare(b.provider));
  const support = byGroup('support');
  const daily = byGroup('daily');
  const weekly = byGroup('weekly');
  const monthly = byGroup('monthly');
  const sorted = byGroup('none');


  // One indicator for the whole board instead of a "1 minute ago" on every
  // card (they were all saying the same thing, and a plain wall clock here
  // was just duplicating the OS's own clock). This is more useful: a
  // countdown to when the board's own data actually refreshes next — ticks
  // off the same 1s interval already driving the reset countdowns above.
  const secondsSinceFetch = fetchedAt != null ? Math.floor((Date.now() - fetchedAt) / 1000) : null;
  const nextRefreshS = secondsSinceFetch != null ? Math.max(0, BOARD_REFRESH_S - secondsSinceFetch) : null;

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-2">
          <Activity size={18} className="text-emerald-400" />
          <h2 className="text-lg font-semibold text-neutral-100">Overview</h2>
        </div>
        <span title="Time until this board's data refreshes" className="flex items-center gap-1.5 text-xs text-neutral-400">
          <RefreshCw size={13} className="text-neutral-500" />
          {nextRefreshS != null ? `${nextRefreshS}s` : ''}
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(360px,1fr))] gap-4">
        {/* Grouped providers share one grid cell per group rather than taking one each. */}
        <GroupedCard title="Support Services" subtitle="metered APIs" icon={<Wrench size={16} className="text-neutral-400" />} providers={support} onJump={onJump} layout="grid" />
        <GroupedCard title="Daily" icon={<Clock size={16} className="text-neutral-400" />} providers={daily} onJump={onJump} />
        <GroupedCard title="Weekly" icon={<CalendarDays size={16} className="text-neutral-400" />} providers={weekly} onJump={onJump} />
        <GroupedCard title="Monthly" icon={<CalendarClock size={16} className="text-neutral-400" />} providers={monthly} onJump={onJump} />
        {sorted.map((p) => (
          <button
            key={p.provider}
            onClick={() => onJump(p.provider)}
            className="text-left bg-neutral-900 border border-neutral-800 rounded-xl p-5 hover:border-neutral-700 transition-colors"
          >
            <div className="flex items-center gap-2 mb-3">
              <span className={`w-2 h-2 rounded-full shrink-0 ${p.status === 'ok' && !p.stale ? 'bg-emerald-500' : p.status === 'ok' ? 'bg-amber-500' : 'bg-red-500'}`} />
              <ProviderIcon provider={p.provider} size={18} className="text-emerald-400" />
              <span className="capitalize font-medium text-neutral-100">{p.provider}</span>
            </div>
            {p.status !== 'ok' && (
              <div className="text-xs text-red-400 mb-2">{p.status}{p.stale ? ' (stale)' : ''}</div>
            )}
            {p.windows?.length ? (
              <div className="flex flex-col gap-3">
                {p.windows.map((w: any, i: number) => {
                  const { primary, secondary, label } = primaryMetric(w);
                  const reset = resetText(w);
                  // Exhausted = at/over cap right now. Distinct from will_deplete
                  // (a forecast): a bucket that's ALREADY gone must not render as
                  // a quiet normal row — red bar + the same alert icon.
                  const exhausted = typeof w.pct === 'number' && w.pct >= 100;
                  const depleting = showDepletion && (w.will_deplete || exhausted);
                  return (
                    <div key={w.id}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <WindowIcon window={w} />
                          {/* Fixed-width label so "resets in" starts at the same
                              x position on every row (and every card) — reads
                              as one aligned column instead of drifting with
                              each label's length. */}
                          <span className="text-neutral-400 w-24 shrink-0 truncate">{label}</span>
                          {reset && (
                            <span title={`resets in ${reset}`} className="flex items-center gap-1 text-[11px] font-medium text-neutral-300 shrink-0">
                              <Clock size={10} className="text-neutral-500" />
                              {reset}
                            </span>
                          )}
                          {depleting && (
                            <span title="Projected to run out before it resets" className="flex items-center shrink-0">
                              <AlertCircle size={12} className="text-red-400" />
                            </span>
                          )}
                        </div>
                        <span className={`shrink-0 ${depleting ? 'text-red-400 font-medium' : 'text-neutral-200'}`}>{primary}</span>
                      </div>
                      {/* Bar always fills in the consumed direction (matches
                          Cloudflare/Firecrawl's own dashboards, and reads as
                          a standard gauge — fuller = closer to the limit)
                          even though the primary NUMBER next to it says
                          "left" — those are two different, both-correct
                          views of the same pct: text answers "how much do I
                          have," bar answers "how close am I to the wall." */}
                      <ActivityBar pct={w.pct} pct1hAgo={w.pct_1h_ago} color={exhausted ? '#ef4444' : windowColor(i, w.color)} />
                      {secondary && (
                        <div className="text-[11px] text-neutral-400 mt-1">{secondary}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-xs text-neutral-400">no data yet</div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function fmtUptime(s: number) {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// Daemon status + lifecycle controls. Compact header form (upper-right).
// Talks only over /usage/health and /usage/admin/* — no coupling to daemon
// internals. Buttons appear only when the daemon reports control is enabled
// (config [control] allow_control). The daemon runs under the `usage-daemon`
// --user systemd unit (Restart=always), so a stop self-heals in ~5s and
// restart respawns directly. "Start" can't be served by a stopped daemon, so
// it surfaces the systemctl command instead.
function DaemonPanel() {
  const [health, setHealth] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (note) {
      if (noteTimer.current) clearTimeout(noteTimer.current);
      noteTimer.current = setTimeout(() => setNote(null), 10000);
    }
    return () => { if (noteTimer.current) clearTimeout(noteTimer.current); };
  }, [note]);

  const load = async () => {
    try {
      const r = await fetch('/usage/health');
      if (r.ok) { setHealth(await r.json()); return; }
    } catch { /* unreachable */ }
    setHealth(null);
  };
  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  const down = !health;
  const control = health?.control ?? {};
  // Only non-zero buckets are shown — "0 stale / 0 down" on every health line
  // was noise; the tooltip keeps the full breakdown.
  const providerCounts = down
    ? ''
    : [
        `${health.providers.ok} ok`,
        health.providers.stale ? `${health.providers.stale} stale` : '',
        health.providers.down ? `${health.providers.down} down` : '',
      ].filter(Boolean).join(' / ');

  const act = async (action: string) => {
    if (action === 'start') {
      setNote('run: systemctl --user start usage-daemon');
      return;
    }
    setBusy(action); setNote(null);
    try {
      const r = await fetch(`/usage/admin/${action}`, { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (action === 'restart') {
        setNote('restarting…');
        for (let i = 0; i < 20; i++) {
          await new Promise((res) => setTimeout(res, 1000));
          try { const h = await fetch('/usage/health'); if (h.ok) { setHealth(await h.json()); setNote('back up'); return; } } catch { /* still down */ }
        }
        setNote('did not come back — check: journalctl --user -u usage-daemon -n 50');
      } else if (action === 'stop') {
        setNote('stopping…');
        setTimeout(load, 1500);
      } else if (!r.ok) {
        setNote(body.hint || body.error || 'unavailable');
      }
    } catch {
      setNote('request failed');
    } finally {
      setBusy(null);
    }
  };

  const statusTitle = down
    ? 'Daemon unreachable — start via systemctl --user start usage-daemon'
    : `Daemon v${health.version} · up ${fmtUptime(health.uptime_s)} · ${providerCounts}${health.under_systemd ? '' : ' · not supervised'}`;

  return (
    <div className="flex items-center gap-2 text-xs min-w-0">
      <div className="flex items-center gap-1.5 min-w-0" title={statusTitle}>
        <span className={`w-2 h-2 rounded-full shrink-0 ${down ? 'bg-red-500' : 'bg-emerald-500'}`} />
        <span className="font-medium text-neutral-300 shrink-0">Daemon</span>
        {health && <span className="text-neutral-400 shrink-0">v{health.version}</span>}
        {!down && (
          <span className="text-neutral-500 truncate hidden lg:inline">
            up {fmtUptime(health.uptime_s)}{providerCounts ? ` · ${providerCounts}` : ''}
          </span>
        )}
        {!down && !health?.under_systemd && (
          <span className="text-amber-400 shrink-0 hidden sm:inline" title="Not supervised by systemd">⚠</span>
        )}
        {down && (
          <span className="text-red-400 truncate hidden sm:inline">unreachable</span>
        )}
      </div>
      <div className="flex gap-1 shrink-0">
        <button disabled={down || !control.restart || !!busy} onClick={() => act('restart')} title="Restart daemon"
          className="flex items-center gap-1 px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 transition-colors">
          <RotateCw size={12} className={busy === 'restart' ? 'animate-spin' : ''} />
          <span className="hidden sm:inline">Restart</span>
        </button>
        <button disabled={down || !control.stop || !!busy} onClick={() => act('stop')} title="Stop daemon"
          className="flex items-center gap-1 px-2 py-1 rounded bg-neutral-800 hover:bg-red-800/70 disabled:opacity-40 transition-colors">
          <Power size={12} />
          <span className="hidden sm:inline">Stop</span>
        </button>
        <button disabled={!!busy} onClick={() => act('start')} title="Start (shows the systemctl command to run)"
          className="flex items-center gap-1 px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 transition-colors">
          <Play size={12} />
          <span className="hidden sm:inline">Start</span>
        </button>
      </div>
      {note && (
        <div className="absolute top-full right-0 mt-1 z-20 px-2 py-1 rounded bg-neutral-900 border border-neutral-700 text-neutral-300 text-[11px] shadow-lg max-w-sm break-words">
          {note}
        </div>
      )}
    </div>
  );
}

// One sidebar provider row -- shared between the non-support and Support
// slices of the nav list so the split (App.tsx, sidebar <nav>) doesn't
// duplicate this JSX.
function ProviderRow({ p, sidebarCollapsed, selectedProvider, onSelect, setSettingsProvider, onForcePoll }: {
  p: any;
  sidebarCollapsed: boolean;
  selectedProvider: string | null;
  onSelect: (provider: string) => void;
  setSettingsProvider: (provider: string) => void;
  onForcePoll: (provider: string) => void;
}) {
  return (
    <div
      title={p.provider}
      className={`group flex-shrink-0 flex items-center justify-between gap-1 ${sidebarCollapsed ? 'md:justify-center md:px-1' : 'pl-3 pr-1'} py-1 text-sm rounded-lg transition-colors ${
        selectedProvider === p.provider
          ? 'bg-neutral-800 text-white font-medium'
          : 'text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200'
      }`}
    >
      <button onClick={() => onSelect(p.provider)} className="flex items-center gap-2 py-1 min-w-0">
        <ProviderIcon provider={p.provider} size={16} className={p.status === 'ok' && !p.stale ? 'text-emerald-400' : p.status === 'ok' ? 'text-amber-400' : p.status ? 'text-red-500' : 'text-neutral-400'} />
        <span className={`capitalize truncate ${sidebarCollapsed ? 'md:hidden' : ''}`}>{p.provider}</span>
      </button>
      <div className={`flex items-center gap-1 shrink-0 ${sidebarCollapsed ? 'md:hidden' : ''}`}>
        <button
          onClick={(e) => { e.stopPropagation(); onForcePoll(p.provider); }}
          className="p-1.5 rounded-md text-neutral-500 opacity-100 md:opacity-0 md:group-hover:opacity-100 hover:text-emerald-400 hover:bg-neutral-700/50 transition-colors"
          title={`Force refresh ${p.provider}`}
        >
          <RefreshCw size={14} />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); setSettingsProvider(p.provider); }}
          className="p-1.5 rounded-md text-neutral-500 opacity-100 md:opacity-0 md:group-hover:opacity-100 hover:text-neutral-200 hover:bg-neutral-700/50 transition-colors"
          title={`${p.provider} settings`}
        >
          <Settings size={14} />
        </button>
      </div>
    </div>
  );
}

export function App() {
  const [providers, setProviders] = useState<any[]>([]);
  const [providersFetchedAt, setProvidersFetchedAt] = useState<number | null>(null);
  // Selecting a provider swaps main content to its dashboard page directly
  // (no flyout/drawer) -- selectedProvider === null shows the Overview board.
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const jumpToProvider = (p: string) => setSelectedProvider(p);
  const [settingsProvider, setSettingsProvider] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Client-side visibility: hide a provider from the UI (sidebar, overview,
  // headline) WITHOUT touching the daemon — it keeps polling & recording. Just
  // a display preference, persisted in localStorage so it survives reloads.
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('hiddenProviders') || '[]'));
    } catch {
      return new Set();
    }
  });
  const toggleHidden = (name: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      localStorage.setItem('hiddenProviders', JSON.stringify([...next]));
      return next;
    });
  const visibleProviders = providers
    .filter((p) => !hidden.has(p.provider))
    .sort((a, b) => {
      const aSupport = a.category === 'support' ? 1 : 0;
      const bSupport = b.category === 'support' ? 1 : 0;
      if (aSupport !== bSupport) return aSupport - bSupport;
      return a.provider.localeCompare(b.provider);
    });

  // Which card (Overview) / sidebar branch each provider belongs to. Fully
  // user-configurable via the Settings gear (GlobalSettingsModal) — seeded once from
  // DEFAULT_CARD_GROUPS, then Daniel's own choices are the source of truth, persisted
  // like `hidden` above.
  const [cardGroup, setCardGroupState] = useState<Record<string, CardGroup>>(() => {
    try {
      const raw = localStorage.getItem('cardGroups');
      if (raw) return JSON.parse(raw);
    } catch { /* fall through to seed */ }
    try { localStorage.setItem('cardGroups', JSON.stringify(DEFAULT_CARD_GROUPS)); } catch {}
    return DEFAULT_CARD_GROUPS;
  });
  const setCardGroup = (provider: string, group: CardGroup) =>
    setCardGroupState((prev) => {
      const next = { ...prev, [provider]: group };
      try { localStorage.setItem('cardGroups', JSON.stringify(next)); } catch {}
      return next;
    });

  // Sidebar treeview: which group branches are collapsed. Independent of `hidden` —
  // collapsing a branch just tucks its rows away, the providers in it are still "on".
  const [collapsedBranches, setCollapsedBranches] = useState<Set<CardGroup>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('sidebarCollapsedBranches') || '[]'));
    } catch {
      return new Set();
    }
  });
  const toggleBranch = (group: CardGroup) =>
    setCollapsedBranches((prev) => {
      const next = new Set(prev);
      next.has(group) ? next.delete(group) : next.add(group);
      try { localStorage.setItem('sidebarCollapsedBranches', JSON.stringify([...next])); } catch {}
      return next;
    });

  // App-wide UI toggles (currently just depletion info), persisted as one
  // JSON blob so future settings don't each need their own localStorage key.
  const [globalSettings, setGlobalSettings] = useState<{ showDepletion: boolean }>(() => {
    try {
      return { showDepletion: false, ...JSON.parse(localStorage.getItem('globalSettings') || '{}') };
    } catch {
      return { showDepletion: false };
    }
  });
  const updateGlobalSettings = (next: { showDepletion: boolean }) => {
    setGlobalSettings(next);
    localStorage.setItem('globalSettings', JSON.stringify(next));
  };
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);

  // Sidebar collapse (desktop only — the mobile layout is already a
  // horizontal top nav, collapsing it wouldn't make sense there). Persisted
  // so it survives reloads.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('sidebarCollapsed') === '1';
    } catch {
      return false;
    }
  });
  const toggleSidebar = () =>
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem('sidebarCollapsed', next ? '1' : '0'); } catch {}
      return next;
    });

  // Overview page redesign (V3) lives side-by-side with the current layout
  // (V2) rather than replacing it, so the two can be A/B'd. Defaults to V2 —
  // nothing changes for existing usage until explicitly switched — and
  // persists across reloads.

  // Keyboard nav: Up/Down (or j/k) walk [Overview, ...visible providers].
  // Ignored while typing in a form field or with the settings modal open.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || settingsProvider) return;
      const down = e.key === 'ArrowDown' || e.key === 'j';
      const up = e.key === 'ArrowUp' || e.key === 'k';
      if (!down && !up) return;
      e.preventDefault();
      const order: (string | null)[] = [null, ...visibleProviders.map((p) => p.provider)];
      const i = order.indexOf(selectedProvider);
      const next = down ? Math.min(order.length - 1, (i < 0 ? -1 : i) + 1) : Math.max(0, (i < 0 ? 1 : i) - 1);
      setSelectedProvider(order[next]);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visibleProviders, selectedProvider, settingsProvider]);

  const fetchProviders = async () => {
    try {
      const res = await fetch('/usage/providers');
      if (!res.ok) throw new Error('Failed to fetch providers');
      const data = await res.json();
      setProviders(data);
      setProvidersFetchedAt(Date.now());
      // No auto-select: selectedProvider stays null on load so the landing view
      // is the cross-provider Overview board (recent refreshes + current usage).
      // The user drills into a provider by clicking; the "Overview" nav item and
      // the header title both return here (setSelectedProvider(null)).
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProviders();
    const interval = setInterval(fetchProviders, 30000);
    return () => clearInterval(interval);
  }, []);

  // Per-row force-refresh from the sidebar.
  const forcePollProvider = async (providerToPoll: string) => {
    try {
      const res = await fetch(`/usage/${providerToPoll}/refresh`, { method: 'POST' });
      if (res.ok) fetchProviders();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div
      className="min-h-[100dvh] text-neutral-100 flex flex-col"
      style={{
        backgroundImage: "linear-gradient(rgba(9,9,11,0.85), rgba(9,9,11,0.85)), url('/bubbalab-wallpaper.png')",
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundAttachment: 'fixed',
      }}
    >
      {/* Full-width top header — logo left, daemon controls + settings upper-right */}
      <header className="shrink-0 bg-neutral-900/95 border-b border-neutral-800 px-3 md:px-4 py-2.5 flex items-center justify-between gap-3">
        <button onClick={() => { setSelectedProvider(null); }} className="text-left flex items-center gap-3 min-w-0">
          <img src="/hoboguppy-logo2.svg" alt="" className="w-9 h-9 shrink-0" />
          <div className="min-w-0">
            <p className="text-cyan-400 text-xs font-extrabold hidden sm:block leading-tight" style={{ fontFamily: 'ui-rounded, "Segoe UI Rounded", system-ui, sans-serif' }}>bubbAlab</p>
            <h1 className="text-base md:text-lg font-bold leading-tight">Usage</h1>
          </div>
        </button>
        <div className="relative flex items-center gap-2 shrink-0">
          <DaemonPanel />
          <button
            onClick={() => setShowGlobalSettings(true)}
            className="p-1.5 rounded-md text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 transition-colors shrink-0"
            title="Settings"
          >
            <Settings size={16} />
          </button>
        </div>
      </header>

      <div className="flex-1 flex flex-col md:flex-row min-h-0">
      {/* Sidebar / Top Nav on Mobile */}
      <aside className={`w-full ${sidebarCollapsed ? 'md:w-16' : 'md:w-52'} bg-neutral-900 border-b md:border-b-0 md:border-r border-neutral-800 flex flex-col shrink-0 transition-[width] duration-150`}>
        <div className="hidden md:flex items-center justify-end px-2 py-1.5 border-b border-neutral-800">
          <button
            onClick={toggleSidebar}
            className="flex items-center justify-center p-1.5 rounded-md text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </div>

        <nav className="flex md:flex-col p-3 md:p-4 gap-2 overflow-x-auto md:overflow-y-auto custom-scrollbar flex-1">
          <button
            onClick={() => { setSelectedProvider(null); }}
            title="Overview"
            className={`flex-shrink-0 flex items-center gap-2 ${sidebarCollapsed ? 'md:justify-center md:px-2' : 'px-3'} py-2 text-sm rounded-lg transition-colors ${
              selectedProvider === null
                ? 'bg-neutral-800 text-white font-medium'
                : 'text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200'
            }`}
          >
            <Activity size={16} className={selectedProvider === null ? 'text-emerald-400' : ''} />
            <span className={sidebarCollapsed ? 'md:hidden' : ''}>Overview</span>
          </button>
          {providers.length === 0 && !loading && (
            <div className={`px-2 text-sm text-neutral-400 whitespace-nowrap ${sidebarCollapsed ? 'md:hidden' : ''}`}>No providers found</div>
          )}
          {GROUP_ORDER.map((group) => {
            const branchProviders = visibleProviders.filter((p) => resolveGroup(p, cardGroup) === group);
            if (!branchProviders.length) return null;
            const collapsed = collapsedBranches.has(group);
            return (
              <React.Fragment key={group}>
                <button
                  onClick={() => toggleBranch(group)}
                  className={`hidden md:flex flex-shrink-0 w-full items-center gap-1 text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2 mt-2 px-2 hover:text-neutral-200 transition-colors ${sidebarCollapsed ? 'md:hidden' : ''}`}
                  title={collapsed ? `Expand ${GROUP_LABEL[group]}` : `Collapse ${GROUP_LABEL[group]}`}
                >
                  <ChevronDown size={12} className={`transition-transform ${collapsed ? '-rotate-90' : ''}`} />
                  {GROUP_LABEL[group]}
                  <span className="text-neutral-600 normal-case font-normal">({branchProviders.length})</span>
                </button>
                {!collapsed && branchProviders.map((p) => (
                  <ProviderRow key={p.provider} p={p} sidebarCollapsed={sidebarCollapsed} selectedProvider={selectedProvider} onSelect={jumpToProvider} setSettingsProvider={setSettingsProvider} onForcePoll={forcePollProvider} />
                ))}
              </React.Fragment>
            );
          })}
        </nav>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto p-4 md:p-8 custom-scrollbar">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <RefreshCw className="animate-spin text-neutral-500" />
          </div>
        ) : error ? (
          <div className="p-4 bg-red-900/20 border border-red-500/50 rounded-xl text-red-400 flex items-center gap-3">
            <AlertCircle />
            <span>{error}</span>
          </div>
        ) : (
          <OverviewBoardV3 providers={visibleProviders} cardGroup={cardGroup} onJump={jumpToProvider} showDepletion={globalSettings.showDepletion} fetchedAt={providersFetchedAt} />
        )}
      </main>
      </div>
      {settingsProvider && (
        <ProviderSettingsModal
          provider={settingsProvider}
          providerMeta={providers.find((p) => p.provider === settingsProvider)}
          onClose={() => setSettingsProvider(null)}
          onRefresh={fetchProviders}
          hidden={hidden}
          onToggleHidden={toggleHidden}
        />
      )}
      {showGlobalSettings && (
        <GlobalSettingsModal
          settings={globalSettings}
          onChange={updateGlobalSettings}
          onClose={() => setShowGlobalSettings(false)}
          providers={providers}
          hidden={hidden}
          onToggleHidden={toggleHidden}
          cardGroup={cardGroup}
          onSetCardGroup={setCardGroup}
        />
      )}
    </div>
  );
}
