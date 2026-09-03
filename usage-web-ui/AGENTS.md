# usage-web-ui

React 19 + Vite + Tailwind SPA, pure client of `usage-daemon`'s `/usage/*` HTTP
contract. Independent git repo — parent `/mnt/nas/projects/usage/` is a folder of
repos, not a monorepo. See its `../AGENTS.md` for the wider picture.

## Architecture

No router — page is one `selectedProvider` state variable in `App.tsx` (`null` =
Overview, else a provider id). Settings is not a page — it's a `settingsProvider`
state var that opens `ProviderSettingsModal` as an overlay, triggered by a gear icon on
each sidebar provider row. No Redux/Zustand, function components + hooks only.

- `src/client/main.tsx` — ReactDOM bootstrap.
- `src/client/App.tsx` — nearly all app logic: `HeadlineBar`, `DaemonPanel`,
  `OverviewBoard`, `ProviderDashboard`, `ProviderIcon`. Read the inline comments here
  first — they document non-obvious decisions (see Key design below).
- `src/client/SettingsView.tsx` — exports `ProviderSettingsModal`: one provider's auth
  form (cookie/oauth-file/token per `config.auth.kind`) + visibility toggle, as a modal
  over a backdrop. Not a page, not a list of all providers.
- `src/client/assets/providers/*.svg` — brand logo per provider (`currentColor` SVGs
  from `@lobehub/icons-static-svg`), imported via `?raw` and rendered inline
  (`dangerouslySetInnerHTML`) in `ProviderIcon` so they inherit the tint `className` the
  same way the lucide fallback icons do — an `<img src>` wouldn't pick up `currentColor`.
- `src/client/index.css` — Tailwind v4 theme tokens (light/dark CSS vars exist but the
  UI is hardcoded dark; nothing currently toggles them).

Everything is plain `fetch` + `setInterval` polling — no WebSocket. Providers/detail
poll every 30s, headline every 30s, daemon health every 5s.

## Dev workflow

```bash
npm install
npm run dev     # vite dev server, proxies /usage/* -> 127.0.0.1:8787 (vite.config.ts)
npm run build   # -> dist/, static
```

Change the proxy target in `vite.config.ts` if the daemon isn't on the default port.
No test framework configured, no ESLint config in this repo.

## Key design

- **Independent of daemon internals by design** — talks only the documented `/usage/*`
  contract (`windows[]`, snapshot fields), no shared package with `usage-daemon`. Must
  degrade gracefully if a daemon field is missing (a future daemon-backend swap is an
  explicit possibility per this repo's `README.md`).
- Computes its own burn-rate/depletion projection client-side (`slope()` in `App.tsx`)
  rather than trusting a daemon-computed value — deliberate duplication, not an
  oversight.
- `DaemonPanel` talks only to `/usage/health` and `/usage/admin/:action` — no coupling
  to daemon internals beyond that. Rendered in the top header (right side), not the sidebar.
  Compact horizontal layout: button labels hide on narrow screens (`hidden sm:inline`),
  full status text shows only on `lg`+ (`hidden lg:inline`). Notes appear as an absolute
  dropdown below the controls (auto-dismiss after 10s).
- Client-side `hiddenProviders` visibility toggle is cosmetic only (`localStorage`),
  does not touch daemon polling.
- History chart range preset (5h/12h/1d/7d/All) is a persisted user preference
  (`localStorage.historyRange`), not per-provider state — doesn't reset on provider
  switch or reload.
- `ProviderDashboard`'s chart X-axis domain floors to a 60s minimum width — a
  zero-width numeric domain (range preset narrower than the visible sample gap) used to
  hang Recharts'/d3's tick generation and freeze the tab.
- The "Global Alert Triggers" block (was dead/unwired UI) has been removed entirely,
  along with the standalone Settings page.

## Active work

`../PLAN-daemon-webui-stability.md` tracks known bugs here (error banner not clearing,
missing `AbortController`/stale-guard on provider-detail fetch, refresh failures only
logged to console) — check it before touching error-handling paths.
