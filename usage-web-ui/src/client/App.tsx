import React, { useEffect, useState, useMemo, useRef } from 'react';
import { 
  Activity, Bell, Server, Settings, History, TrendingUp, TrendingDown, AlertCircle, RefreshCw, Power, RotateCw, Play,
  Bot, Brain, Cloud, Terminal, Wrench, Zap, Mic, Scan, Search, Database, Cpu, HardDrive, Network, Shield, Key, Link, ExternalLink, BookOpen, GraduationCap, MessageSquare, AudioLines, Rocket, GitBranch,
  Clock, Calendar, CalendarDays, CalendarClock
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

// Built-in "where do I look at this provider" pages, opened by double-clicking its card.
// Only ones known to be right; a provider with no entry and no user-set URL just does nothing.
// The user's own URL (Provider settings → Provider URL, stored in localStorage `providerUrls`) wins.
export const DEFAULT_PROVIDER_URLS: Record<string, string> = {
  claude: 'https://claude.ai/settings/usage',
  grok: 'https://grok.com',
  mistral: 'https://console.mistral.ai',
  ollama: 'https://ollama.com/settings',
  cloudflare: 'https://dash.cloudflare.com',
  groq: 'https://console.groq.com',
  firecrawl: 'https://www.firecrawl.dev/app',
  tavily: 'https://app.tavily.com',
  openrouter: 'https://openrouter.ai/settings/credits',
  deepgram: 'https://console.deepgram.com',
  serpapi: 'https://serpapi.com/dashboard',
  context7: 'https://context7.com',
  elevenlabs: 'https://elevenlabs.io/app',
  runpod: 'https://www.runpod.io/console',
  github: 'https://github.com',
  cohere: 'https://dashboard.cohere.com',
  consensus: 'https://consensus.app',
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
  
  if (id.includes('token') || label.includes('token') || unit.includes('token')) return <Database size={14} className="text-neutral-200" />;
  if (id.includes('request') || label.includes('request')) return <Cpu size={14} className="text-neutral-200" />;
  if (id.includes('cost') || label.includes('cost') || unit.includes('$')) return <Zap size={14} className="text-neutral-200" />;
  if (id.includes('minute') || label.includes('minute') || unit.includes('min')) return <Clock size={14} className="text-neutral-200" />;
  if (id.includes('day') || label.includes('daily')) return <Calendar size={14} className="text-neutral-200" />;
  if (id.includes('month') || label.includes('monthly')) return <Calendar size={14} className="text-neutral-200" />;
  if (id.includes('week') || label.includes('weekly')) return <Calendar size={14} className="text-neutral-200" />;
  if (id.includes('session') || label.includes('session')) return <Activity size={14} className="text-neutral-200" />;
  if (id.includes('vibe') || label.includes('vibe')) return <Brain size={14} className="text-neutral-200" />;
  if (id.includes('primary') || label.includes('primary')) return <Server size={14} className="text-neutral-200" />;
  return <Database size={14} className="text-neutral-200" />;
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
    <div className="w-full bg-neutral-900 border-b border-neutral-700 px-4 py-2 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm shrink-0">
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
            <span className="text-neutral-100 font-medium">
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
            <span className="text-neutral-200 uppercase tracking-wider font-semibold">{SCOPE_LABEL[scope] || scope}</span>
            {mover.delta >= 0 ? (
              <TrendingUp size={14} className="text-red-400 shrink-0" />
            ) : (
              <TrendingDown size={14} className="text-emerald-400 shrink-0" />
            )}
            <span className="text-neutral-100 font-medium">
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
/**
 * A shared card for a group of providers (Support Services, Daily, Weekly, Monthly).
 * Each provider gets its own row within the card, with the compact layout:
 *   - Provider icon + name
 *   - Primary value (with reset countdown if applicable)
 *   - ActivityBar (list mode) or value only (grid mode)
 *   - Secondary value (optional, e.g., remaining quota)
 *
 * Grouped providers remain independent — they have separate polling, history,
 * and detail views — they simply share UI space on the overview board.
 *
 * @param title    - Group title (e.g., "Support Services", "Daily")
 * @param subtitle - Optional subtitle (e.g., "metered APIs")
 * @param icon     - React component for the group icon
 * @param providers - Array of provider objects to display in this group
 * @param onRefresh  - Force-refresh one provider (card button)
 * @param onSettings - Open that provider's settings modal (card button)
 * @param layout   - Either 'list' (vertical rows with bars) or 'grid' (compact values only)
 */
// Per-provider refresh + settings buttons, shown on every Overview card
// (replaces the old sidebar row's buttons). Always visible on touch, hover-reveal
// on md+ when the parent carries the `group` class.
export function CardActions({ provider, onRefresh, onSettings, size = 14, className = '' }: {
  provider: string;
  onRefresh: (provider: string) => void;
  onSettings: (provider: string) => void;
  size?: number;
  className?: string;
}) {
  const btn = 'p-1 rounded-md text-neutral-300 opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 hover:bg-neutral-700/50 transition-colors';
  return (
    // stopPropagation: double-clicking a button must not also trigger the card's open-URL dblclick.
    <div className={`flex items-center shrink-0 ${className}`} onDoubleClick={(e) => e.stopPropagation()}>
      <button onClick={() => onRefresh(provider)} className={`${btn} hover:text-emerald-400`} title={`Force refresh ${provider}`}>
        <RefreshCw size={size} />
      </button>
      <button onClick={() => onSettings(provider)} className={`${btn} hover:text-neutral-100`} title={`${provider} settings`}>
        <Settings size={size} />
      </button>
    </div>
  );
}

// The one place a window's reset countdown is drawn: always the upper-right of its
// row/tile, same icon + weight everywhere. `reset` is the resetText() string or null.
function ResetBadge({ reset, className = '' }: { reset: string | null; className?: string }) {
  if (!reset) return null;
  return (
    <span title={`resets in ${reset}`} className={`flex items-center gap-0.5 text-sm font-medium tabular-nums text-neutral-200 shrink-0 ${className}`}>
      <Clock size={10} className="text-neutral-300" />
      {reset}
    </span>
  );
}

// A card's windows often reset together (Mistral: both 11d, Groq: every model). When they
// all show the same countdown, it's drawn ONCE in the card header above the buttons and the
// per-row badges are suppressed; when they differ (Claude 5h vs 7d) each row keeps its own.
function sharedReset(p: any): string | null {
  const set = new Set<string>();
  for (const w of p.windows || []) {
    const r = resetText(w);
    if (r) set.add(r);
  }
  return set.size === 1 ? [...set][0] : null;
}

function GroupedCard({ title, subtitle, icon, providers, onRefresh, onSettings, onOpen, layout = 'list', bare = false }: {
  onOpen: (p: string) => void;
  title?: string;
  subtitle?: string;
  icon?: React.ReactNode;
  bare?: boolean; // single-provider card: no group header, the provider row is the header
  providers: any[];
  onRefresh: (p: string) => void;
  onSettings: (p: string) => void;
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
            <div key={w.id} className="group/win relative">
              {/* Value lives in a hover flyout (out of flow) when there's a bar to read;
                  a window with no bar has nothing else to show, so its number stays inline. */}
              {hasBar && (
                <div className={`pointer-events-none absolute right-0 bottom-full mb-0.5 z-20 hidden group-hover/win:flex rounded-md border border-neutral-600 bg-neutral-950 px-2 py-1 text-sm font-medium tabular-nums shadow-lg shadow-black/40 ${exhausted ? 'text-red-400' : 'text-neutral-100'}`}>
                  {valueText(w)}
                </div>
              )}
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-1 min-w-0">
                  <span className="text-sm text-neutral-300 truncate" title={w.note || undefined}>{w.label || w.id}</span>
                  {exhausted && <AlertCircle size={12} className="text-red-400 shrink-0" />}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {!hasBar && <span className="text-base font-medium tabular-nums text-neutral-100">{valueText(w)}</span>}
                  <ResetBadge reset={sharedReset(p) ? null : reset} />
                </div>
              </div>
              {hasBar && (
                <div className="mt-0.5">
                  <ActivityBar pct={w.pct} pct1hAgo={w.pct_1h_ago} color={exhausted ? '#ef4444' : windowColor(i, w.color)} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    ) : (
      <div className="text-sm text-neutral-300">no data yet</div>
    );

  // Groq: the daemon emits 4 account-level 30d totals (ids cost/generated_tokens/
  // context_tokens/requests — dropped here) plus, per model, one requests window
  // (`daily_<slug>`) and one tokens window (`daily_tokens_<slug>`). Render one line
  // per model: name once, requests bar left, tokens bar right. All windows share the
  // same daily reset, so it's said once in the header instead of on every row.
  const groqLines = (p: any) => {
    const models: { slug: string; name: string; req?: any; tok?: any }[] = [];
    for (const w of p.windows || []) {
      const m = /^daily_(tokens_)?(.+)$/.exec(w.id || '');
      if (!m) continue;
      let row = models.find((r) => r.slug === m[2]);
      if (!row) {
        row = { slug: m[2], name: String(w.label || w.id).replace(/ daily( tokens)?$/, '') };
        models.push(row);
      }
      if (m[1]) row.tok = w; else row.req = w;
    }
    if (!models.length) return listWindowLines(p);
    const withReset = (p.windows || []).find((w: any) => /^daily_/.test(w.id || '') && w.resets_at);
    const reset = withReset ? resetText(withReset) : null;
    const cell = (w: any, color: string) => {
      if (!w) return <div />;
      const exhausted = typeof w.pct === 'number' && w.pct >= 100;
      return (
        <div>
          <ActivityBar pct={w.pct} pct1hAgo={w.pct_1h_ago} color={exhausted ? '#ef4444' : color} />
        </div>
      );
    };
    return (
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-x-4 text-sm uppercase tracking-wide text-neutral-300">
          <span>Requests</span>
          <span className="flex items-center justify-between">
            Tokens
          </span>
        </div>
        {models.map((r) => (
          <div key={r.slug} className="group/model relative">
            {/* Flyout: values live here, out of flow, so the rows stay one line each. */}
            <div className="pointer-events-none absolute right-0 bottom-full mb-0.5 z-20 hidden group-hover/model:flex items-center gap-3 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm tabular-nums shadow-lg shadow-black/40">
              {r.req && <span className={r.req.pct >= 100 ? 'text-red-400' : 'text-neutral-100'}><span className="text-neutral-300">req </span>{valueText(r.req)}</span>}
              {r.tok && <span className={r.tok.pct >= 100 ? 'text-red-400' : 'text-neutral-100'}><span className="text-neutral-300">tok </span>{valueText(r.tok)}</span>}
            </div>
            <div className="text-sm text-neutral-300 truncate">{r.name}</div>
            <div className="grid grid-cols-2 gap-x-4">
              {cell(r.req, windowColor(0, undefined))}
              {cell(r.tok, windowColor(1, undefined))}
            </div>
          </div>
        ))}
      </div>
    );
  };

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
      p.windows.length === 1 ? null : ( // single-window tile: its value rides the header line
        <div className="flex flex-col gap-0.5">
          {p.windows.map((w: any) => (
            <div key={w.id} className="flex items-baseline justify-between gap-2">
              <span className="text-sm text-neutral-300 truncate">{w.label || w.id}</span>
              <span className="text-base font-semibold text-neutral-100 tabular-nums shrink-0">{valueText(w)}</span>
            </div>
          ))}
        </div>
      )
    ) : (
      <span className="text-sm text-neutral-300">no data yet</span>
    );

  return (
    <div className="bg-neutral-900 border border-neutral-700 rounded-xl p-5 mb-4 break-inside-avoid">
      {!bare && (
        <div className="flex items-center gap-2 mb-4">
          {icon}
          <h3 className="font-medium text-neutral-100">{title}</h3>
          {subtitle && <span className="text-sm text-neutral-300">{subtitle}</span>}
        </div>
      )}

      {layout === 'grid' ? (
        // CSS multi-column, not grid: a grid row's track height is set by its
        // tallest cell even with items-start on the cells themselves (items-start
        // only stops the cell content from stretching to fill that height — the
        // empty space is still reserved), so a 3-window tile like Consensus left a
        // dead gap under its shorter same-row neighbors (Context7, Deepgram).
        // Columns lay out independently per column instead, so each tile stacks
        // directly under the previous one in its own column — no shared row height.
        <div className="columns-[190px] gap-2">
          {providers.map((p) => (
            <div
              key={p.provider}
              onDoubleClick={() => onOpen(p.provider)}
              className="group relative block w-full text-left p-2 mb-2 rounded-lg border border-neutral-700 bg-neutral-950/40 hover:border-neutral-700 transition-colors break-inside-avoid"
            >
              <div className={`flex items-center gap-1.5 min-w-0 ${p.windows?.length > 1 ? 'mb-1' : ''}`}>
                <ProviderIcon
                  provider={p.provider}
                  size={13}
                  className={`shrink-0 ${p.status === 'ok' && !p.stale ? 'text-emerald-400' : p.status === 'ok' ? 'text-amber-400' : p.status ? 'text-red-500' : 'text-neutral-200'}`}
                />
                <span className="capitalize text-sm text-neutral-200 truncate">{p.provider}</span>
                {p.windows?.length === 1 && (
                  // One window: "Deepgram ....... $196.99" on a single line; the unit label
                  // ("Balance", "Requests/mo") moves to the tooltip.
                  <span title={p.windows[0].label || p.windows[0].id} className="ml-auto text-lg font-bold text-neutral-100 tabular-nums shrink-0">{valueText(p.windows[0])}</span>
                )}
                <CardActions provider={p.provider} onRefresh={onRefresh} onSettings={onSettings} size={12} className="absolute -top-3 right-1 z-10 rounded-md border border-neutral-600 bg-neutral-950 shadow-md shadow-black/50 md:opacity-0 md:group-hover:opacity-100 transition-opacity" />
              </div>
              {gridWindowLines(p)}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-neutral-700">
          {providers.map((p) => (
            <div
              key={p.provider}
              onDoubleClick={() => onOpen(p.provider)}
              className="group text-left py-2.5 first:pt-0 last:pb-0"
            >
              <div className="flex items-center gap-2 min-w-0">
                <ProviderIcon
                  provider={p.provider}
                  size={14}
                  className={`shrink-0 ${p.status === 'ok' && !p.stale ? 'text-emerald-400' : p.status === 'ok' ? 'text-amber-400' : p.status ? 'text-red-500' : 'text-neutral-200'}`}
                />
                <span className="capitalize text-base text-neutral-200 truncate">{p.provider}</span>
                <div className="ml-auto flex flex-col items-end">
                  <ResetBadge reset={sharedReset(p)} className="mr-1" />
                  <CardActions provider={p.provider} onRefresh={onRefresh} onSettings={onSettings} size={13} />
                </div>
              </div>
              <div className="mt-1 pl-3.5">{p.provider === 'groq' ? groqLines(p) : listWindowLines(p)}</div>
            </div>
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
      <div className="h-1.5 w-full bg-neutral-700 rounded-full overflow-hidden relative">
        <div className="h-full absolute inset-y-0 left-0" style={{ width: `${solid}%`, backgroundColor: fill }} />
        {cur > solid && (
          <div className="h-full absolute inset-y-0" style={{ left: `${solid}%`, width: `${cur - solid}%`, backgroundColor: ACTIVITY_DELTA_COLOR }} />
        )}
      </div>
    );
  }
  return (
    <div className="h-1.5 w-full bg-neutral-700 rounded-full overflow-hidden">
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

/**
 * Bar-mode overview board. Groups providers by user-assigned group
 * (Support/Daily/Weekly/Monthly/'none'), renders each group in a
 * GroupedCard. The 'none' group gets full-width cards with ActivityBar;
 * grouped providers render compact rows inside their group card.
 *
 * @param providers   - Full provider list from daemon
 * @param cardGroup   - Map of provider id → CardGroup (user-assigned)
 * @param onRefresh   - Force-refresh one provider (card button)
 * @param onSettings  - Open a provider's settings modal (card button)
 * @param fetchedAt   - Timestamp of last data refresh (for "next refresh" countdown)
 */
function OverviewBoardV3({ providers, cardGroup, onRefresh, onSettings, onOpen, fetchedAt }: { providers: any[]; cardGroup: Record<string, CardGroup>; onRefresh: (p: string) => void; onSettings: (p: string) => void; onOpen: (p: string) => void; fetchedAt: number | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (!providers.length) {
    return <div className="flex items-center justify-center h-full text-neutral-200">No providers configured</div>;
  }

  // Providers collapse into one shared compact card per group instead of taking a full
  // grid cell each — group is user-assigned (GlobalSettingsModal), see resolveGroup above.
  // 'none' (unassigned / explicitly "Full card") keeps today's rich per-provider card.
  // Erroring (auth_expired etc.) or stale providers stay on the board — the daemon
  // keeps their last-known windows on error, so each card variant below renders
  // them greyed/red-flagged with that stale data instead of hiding them (they used
  // to be filtered out here entirely, which dropped a provider from the board the
  // moment its auth expired).
  const byGroup = (g: CardGroup) =>
    providers.filter((p) => resolveGroup(p, cardGroup) === g).sort((a, b) => a.provider.localeCompare(b.provider));
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
        <span title="Time until this board's data refreshes" className="flex items-center gap-1.5 text-sm text-neutral-200">
          <RefreshCw size={13} className="text-neutral-300" />
          {nextRefreshS != null ? `${nextRefreshS}s` : ''}
        </span>
      </div>
      {/* Masonry: CSS columns, not grid — a grid row stretches every card to the tallest
          one; columns let each card keep its own height and stack under the previous. */}
      <div className="columns-[360px] gap-4">
        {/* Grouped providers share one grid cell per group rather than taking one each. */}
        <GroupedCard title="Support Services" subtitle="metered APIs" icon={<Wrench size={16} className="text-neutral-200" />} providers={support} onRefresh={onRefresh} onSettings={onSettings} onOpen={onOpen} layout="grid" />
        {/* Only Support Services shares a card; every other provider gets its own
            (Daily/Weekly/Monthly assignment now just sets order, not a shared card). */}
        {[...daily, ...weekly, ...monthly].map((p) => (
          <GroupedCard key={p.provider} bare providers={[p]} onRefresh={onRefresh} onSettings={onSettings} onOpen={onOpen} />
        ))}
        {sorted.map((p) => (
          <div
            key={p.provider}
            onDoubleClick={() => onOpen(p.provider)}
            className="group text-left bg-neutral-900 border border-neutral-700 rounded-xl p-5 mb-4 break-inside-avoid hover:border-neutral-700 transition-colors"
          >
            <div className="flex items-center gap-2 mb-3">
              <span className={`w-2 h-2 rounded-full shrink-0 ${p.status === 'ok' && !p.stale ? 'bg-emerald-500' : p.status === 'ok' ? 'bg-amber-500' : 'bg-red-500'}`} />
              <ProviderIcon provider={p.provider} size={18} className="text-emerald-400" />
              <span className="capitalize font-medium text-neutral-100">{p.provider}</span>
              <div className="ml-auto flex flex-col items-end">
                <ResetBadge reset={sharedReset(p)} className="mr-1" />
                <CardActions provider={p.provider} onRefresh={onRefresh} onSettings={onSettings} />
              </div>
            </div>
            {p.status !== 'ok' && (
              <div className="text-sm text-red-400 mb-2">{p.status}{p.stale ? ' (stale)' : ''}</div>
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
                  const depleting = exhausted; // forecast ("will_deplete") display removed — didn't work
                  return (
                    <div key={w.id} className="group/win relative">
                      {/* Flyout: the value(s) live here, out of flow, so rows stay label + bar only. */}
                      <div className={`pointer-events-none absolute right-0 bottom-full mb-0.5 z-20 hidden group-hover/win:flex items-center gap-3 rounded-md border border-neutral-600 bg-neutral-950 px-2 py-1 text-sm tabular-nums shadow-lg shadow-black/40 ${depleting ? 'text-red-400' : 'text-neutral-100'}`}>
                        <span className="font-medium">{primary}</span>
                        {secondary && <span className="text-neutral-200">{secondary}</span>}
                      </div>
                      <div className="flex items-center justify-between text-sm mb-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <WindowIcon window={w} />
                          {/* Fixed-width label so "resets in" starts at the same
                              x position on every row (and every card) — reads
                              as one aligned column instead of drifting with
                              each label's length. */}
                          <span className="text-neutral-200 w-24 shrink-0 truncate">{label}</span>
                          {depleting && (
                            <span title="Projected to run out before it resets" className="flex items-center shrink-0">
                              <AlertCircle size={12} className="text-red-400" />
                            </span>
                          )}
                        </div>
                        <ResetBadge reset={sharedReset(p) ? null : reset} />
                      </div>
                      {/* Bar always fills in the consumed direction (matches
                          Cloudflare/Firecrawl's own dashboards, and reads as
                          a standard gauge — fuller = closer to the limit)
                          even though the primary NUMBER next to it says
                          "left" — those are two different, both-correct
                          views of the same pct: text answers "how much do I
                          have," bar answers "how close am I to the wall." */}
                      <ActivityBar pct={w.pct} pct1hAgo={w.pct_1h_ago} color={exhausted ? '#ef4444' : windowColor(i, w.color)} />
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-sm text-neutral-200">no data yet</div>
            )}
          </div>
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
// (config [control] allow_control). The backend can also surface service/log
// hints so this panel doesn't have to hardcode a specific systemd unit name.
function DaemonPanel({ onHealthChange }: { onHealthChange?: (health: any | null) => void }) {
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
      if (r.ok) {
        const next = await r.json();
        setHealth(next);
        onHealthChange?.(next);
        return;
      }
    } catch { /* unreachable */ }
    setHealth(null);
    onHealthChange?.(null);
  };
  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  const down = !health;
  const control = health?.control ?? {};
  const startHint = typeof control.start_hint === 'string' ? control.start_hint : null;
  const logHint = typeof control.log_hint === 'string' ? control.log_hint : null;
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
      setNote(startHint ? `run: ${startHint}` : 'start it via your service manager');
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
        setNote(logHint ? `did not come back — check: ${logHint}` : 'did not come back — check the daemon logs');
      } else if (action === 'stop') {
        setNote(body.hint || (body.supervised ? 'stopping… systemd will restart it' : 'stopping…'));
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
    ? (startHint ? `Daemon unreachable — start via ${startHint}` : 'Daemon unreachable — start it via your service manager')
    : `Daemon v${health.version} · up ${fmtUptime(health.uptime_s)} · ${providerCounts}${health.under_systemd ? '' : ' · not supervised'}`;

  return (
    <div className="flex items-center gap-2 text-sm min-w-0">
      <div className="flex items-center gap-1.5 min-w-0" title={statusTitle}>
        <span className={`w-2 h-2 rounded-full shrink-0 ${down ? 'bg-red-500' : 'bg-emerald-500'}`} />
        <span className="inline-flex items-center rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-sm font-medium text-cyan-200 shrink-0">
          Python daemon{health?.version ? ` v${health.version}` : ''}
        </span>
        {!down && (
          <span className="text-neutral-300 truncate hidden lg:inline">
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
        <button disabled={!!busy} onClick={() => act('start')} title="Start (shows the daemon start command to run)"
          className="flex items-center gap-1 px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 transition-colors">
          <Play size={12} />
          <span className="hidden sm:inline">Start</span>
        </button>
      </div>
      {note && (
        <div className="absolute top-full right-0 mt-1 z-20 px-2 py-1 rounded bg-neutral-900 border border-neutral-700 text-neutral-200 text-sm shadow-lg max-w-sm break-words">
          {note}
        </div>
      )}
    </div>
  );
}

export function App() {
  const [providers, setProviders] = useState<any[]>([]);
  const [daemonHealth, setDaemonHealth] = useState<any>(null);
  const [providersFetchedAt, setProvidersFetchedAt] = useState<number | null>(null);
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

  // Per-provider URL override (Provider settings → Provider URL), opened by double-clicking
  // a card. Persisted like `hidden`/`cardGroups`; an empty value removes the override.
  const [providerUrls, setProviderUrls] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('providerUrls') || '{}'); } catch { return {}; }
  });
  const persistUrls = (next: Record<string, string>) => {
    try { localStorage.setItem('providerUrls', JSON.stringify(next)); } catch {}
    return next;
  };
  const setProviderUrl = (provider: string, url: string) =>
    setProviderUrls((prev) => {
      const next = { ...prev };
      if (url.trim()) next[provider] = url.trim(); else delete next[provider];
      return persistUrls(next);
    });
  // Default when the user hasn't set one: the built-in map, else the auth domain the
  // daemon reports on the provider row (cookie_from_firefox, e.g. ".claude.ai").
  const defaultUrlFor = (provider: string): string => {
    if (DEFAULT_PROVIDER_URLS[provider]) return DEFAULT_PROVIDER_URLS[provider];
    const domain = providers.find((p) => p.provider === provider)?.cookie_from_firefox;
    return typeof domain === 'string' && domain ? `https://${domain.replace(/^\./, '')}` : '';
  };
  const openProvider = (provider: string) => {
    const url = providerUrls[provider] || defaultUrlFor(provider);
    if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
  };

  // Config import/export: everything the UI keeps in localStorage, as one JSON file.
  const exportConfig = () => {
    const cfg = { app: 'usage-web-ui', version: 1, hiddenProviders: [...hidden], cardGroups: cardGroup, providerUrls };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' }));
    a.download = 'usage-web-ui-config.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  // Returns an error message, or null on success. Only known keys with the right shape are applied.
  const importConfig = (text: string): string | null => {
    let cfg: any;
    try { cfg = JSON.parse(text); } catch { return 'Not valid JSON'; }
    if (!cfg || typeof cfg !== 'object' || cfg.app !== 'usage-web-ui') return 'Not a usage-web-ui config file';
    const isStrMap = (o: any) => o && typeof o === 'object' && !Array.isArray(o) && Object.values(o).every((v) => typeof v === 'string');
    if (Array.isArray(cfg.hiddenProviders) && cfg.hiddenProviders.every((s: any) => typeof s === 'string')) {
      setHidden(new Set(cfg.hiddenProviders));
      try { localStorage.setItem('hiddenProviders', JSON.stringify(cfg.hiddenProviders)); } catch {}
    }
    if (isStrMap(cfg.cardGroups)) {
      setCardGroupState(cfg.cardGroups);
      try { localStorage.setItem('cardGroups', JSON.stringify(cfg.cardGroups)); } catch {}
    }
    if (isStrMap(cfg.providerUrls)) setProviderUrls(persistUrls(cfg.providerUrls));
    return null;
  };

  const [showGlobalSettings, setShowGlobalSettings] = useState(false);

  const fetchProviders = async () => {
    try {
      const res = await fetch('/usage/providers');
      if (!res.ok) throw new Error('Failed to fetch providers');
      const data = await res.json();
      setProviders(data);
      setProvidersFetchedAt(Date.now());
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

  // Per-card force-refresh.
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
        backgroundImage: "linear-gradient(rgba(9,9,11,0.94), rgba(9,9,11,0.94)), url('/bubbalab-wallpaper.png')",
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundAttachment: 'fixed',
      }}
    >
      {/* Full-width top header — logo left, daemon controls + settings upper-right */}
      <header className="shrink-0 bg-neutral-900/92 backdrop-blur-xl border-b border-neutral-700 px-3 md:px-4 py-2.5 flex items-center justify-between gap-3 shadow-lg shadow-black/20">
        <div className="text-left flex items-center gap-3 min-w-0">
          <img src="/hoboguppy-logo2.svg" alt="" className="w-9 h-9 shrink-0" />
          <div className="min-w-0">
            <p className="text-cyan-400 text-sm font-extrabold hidden sm:block leading-tight" style={{ fontFamily: 'ui-rounded, "Segoe UI Rounded", system-ui, sans-serif' }}>bubbAlab</p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h1 className="text-lg md:text-lg font-bold leading-tight text-white">Provider Usage WebUI</h1>
            </div>
          </div>
        </div>
        <div className="relative flex items-center gap-2 shrink-0">
          <DaemonPanel onHealthChange={setDaemonHealth} />
          <button
            onClick={() => setShowGlobalSettings(true)}
            className="p-1.5 rounded-md text-neutral-300 hover:text-neutral-100 hover:bg-neutral-800 transition-colors shrink-0"
            title="Settings"
          >
            <Settings size={16} />
          </button>
        </div>
      </header>

      <div className="flex-1 flex flex-col min-h-0">
      {/* Main Content */}
      <main className="flex-1 overflow-y-auto p-4 md:p-8 custom-scrollbar">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <RefreshCw className="animate-spin text-neutral-300" />
          </div>
        ) : error ? (
          <div className="p-4 bg-red-900/20 border border-red-500/50 rounded-xl text-red-400 flex items-center gap-3">
            <AlertCircle />
            <span>{error}</span>
          </div>
        ) : (
          <OverviewBoardV3 providers={visibleProviders} cardGroup={cardGroup} onRefresh={forcePollProvider} onSettings={setSettingsProvider} onOpen={openProvider} fetchedAt={providersFetchedAt} />
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
          url={providerUrls[settingsProvider]}
          defaultUrl={defaultUrlFor(settingsProvider)}
          onSetUrl={setProviderUrl}
        />
      )}
      {showGlobalSettings && (
        <GlobalSettingsModal
          onClose={() => setShowGlobalSettings(false)}
          providers={providers}
          hidden={hidden}
          onToggleHidden={toggleHidden}
          providerUrls={providerUrls}
          onSetUrl={setProviderUrl}
          defaultUrlFor={defaultUrlFor}
          onExport={exportConfig}
          onImport={importConfig}
        />
      )}
    </div>
  );
}
