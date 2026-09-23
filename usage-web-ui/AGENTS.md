# usage-web-ui

React 19 + Vite + Tailwind SPA, pure client of `usage-daemon`'s `/usage/*` HTTP
contract. Independent git repo — parent `/mnt/nas/projects/usage/` is a folder of
repos, not a monorepo. See its `../AGENTS.md` for the wider picture.

## Architecture

No router, no sidebar, no provider detail page — the app is one page: the Overview
board (`OverviewBoardV3` in `App.tsx`), a masonry of cards (CSS `columns`, so each card
keeps its own height). Every provider card carries a refresh button (POST
`/usage/:provider/refresh`) and a settings gear (`settingsProvider` state →
`ProviderSettingsModal` overlay); double-clicking a card opens the provider's URL in a new
tab. No Redux/Zustand, function components + hooks only.

- `src/client/main.tsx` — ReactDOM bootstrap.
- `src/client/App.tsx` — nearly all app logic: `HeadlineBar` (currently unrendered),
  `DaemonPanel`, `OverviewBoardV3`, `GroupedCard`, `CardActions`, `ResetBadge`,
  `ProviderIcon`. Read the inline comments here first — they document non-obvious
  decisions (see Key design below).
- `src/client/SettingsView.tsx` — exports `ProviderSettingsModal`: one provider's URL
  override, visibility toggle and auth form (cookie/oauth-file/token per
  `config.auth.kind`), as a modal over a backdrop. Not a page.
- `src/client/GlobalSettingsModal.tsx` — main Settings (header gear): config
  export/import (JSON), and a row per provider with its URL override (default shown as
  placeholder) and visibility toggle.
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

## systemd (production dev server)

`usage-webui.service` (this repo, tracked) runs the v3 dev server on `:5175`:
`systemctl --user start|status|restart usage-webui.service`. It drives vite
directly via an absolute `node` path, not `npm run` — `~/.local/bin/npm` is a
symlink that has pointed at a deleted Hermes node install and broken the unit
with `203/EXEC` before. If the service fails to start, check that symlink and
the node path in the unit; nvm has no stable `versions/node/current` symlink, so
the version number in `ExecStart` must be bumped when the active version moves.

## Key design

- **Independent of daemon internals by design** — talks only the documented `/usage/*`
  contract (`windows[]`, snapshot fields), no shared package with `usage-daemon`. Must
  degrade gracefully if a daemon field is missing (a future daemon-backend swap is an
  explicit possibility per this repo's `README.md`).
- Computes its own burn-rate/depletion projection client-side (`slope()` in `App.tsx`)
  rather than trusting a daemon-computed value — deliberate duplication, not an
  oversight.
- **Cards**: only "Support Services" (providers whose group resolves to `support` via
  `resolveGroup`) share one card, drawn as compact tiles — a single-window provider is
  one line (`Deepgram ..... $196.99`, label in the tooltip). Every other provider gets its
  own card. Group assignment is no longer editable in the UI (the Daily/Weekly/Monthly
  "buckets" only order the cards); `cardGroups` in localStorage still feeds `resolveGroup`.
- **Numbers hidden on non-Support cards**: values show in a hover flyout (absolutely
  positioned, no layout space). Exceptions: Support tiles, and windows with no bar.
  Groq and Voyage are special-cased (`groqLines`/`voyageLines` in `GroupedCard`):
  groq's four 30d totals are dropped, its daemon-side all-models aggregate
  (`daily_total`/`daily_tokens_total`) is drawn as a Total row, and each model is
  one line — requests bar left, tokens bar right. Voyage draws its aggregate as a
  Total row plus one free-token bar per model (`p.segments`). Both cards carry a
  collapse chevron (persisted in localStorage `cardCollapse`) that hides the model
  rows and keeps only the totals.
- **Reset countdown** is drawn by `ResetBadge` only: once in the card header (above the
  refresh/settings buttons) when all windows share the same countdown (`sharedReset`),
  else per-row at the row's right end. Never shown on Support tiles.
- **Provider URL** (double-click a card): user override in `localStorage.providerUrls` >
  `DEFAULT_PROVIDER_URLS` > `https://<cookie_from_firefox domain>` from the provider row.
  Config import/export (header gear → Settings) round-trips `hiddenProviders`,
  `cardGroups` and `providerUrls` as JSON (`app: "usage-web-ui"` marker checked on import).
- The pie/donut view and the sidebar were removed; `recharts` is still in `package.json`
  but unused. Depletion forecast display was removed too (full cards only flag windows
  already at ≥100%).
- **Type/contrast**: no web font (Tailwind system stack; `bubbAlab` uses `ui-rounded`,
  credential boxes are mono). Muted text is `text-neutral-300` at minimum on the dark
  cards — don't go dimmer; it was unreadable at 100% zoom.
- `DaemonPanel` talks only to `/usage/health` and `/usage/admin/:action` — no coupling
  to daemon internals beyond that. Rendered in the top header (right side).
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
