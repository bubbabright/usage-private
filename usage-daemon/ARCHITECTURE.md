# usage-daemon architecture

Verified against actual imports and route registrations in `src/` (not inferred from comments) as of 2026-08-08.

```mermaid
flowchart TB
    subgraph entry["index.js (entry)"]
        cfg["config.js<br/>loadConfig()"]
        reg["registry.js<br/>register/create"]
    end

    subgraph providers["providers/*.js (21 files)"]
        p1["claude.js"]
        p2["grok.js"]
        p3["mistral.js"]
        p4["ollama.js"]
        p5["groq.js"]
        p6["openrouter.js"]
        p7["cloudflare.js"]
        p8["deepgram.js"]
        p9["firecrawl.js"]
        p10["opencode-go.js"]
    end

    subgraph run["runner.js (Runner)"]
        poll["poll loop per provider:<br/>fetch() -> parse() -> snapshot"]
    end

    subgraph calc["derived metrics"]
        burn["burnrate.js<br/>slope(), willDeplete()"]
        head["headline.js<br/>computeHeadline()"]
    end

    subgraph persist["store.js"]
        jsonl["~/.local/state/usage-daemon/&lt;provider&gt;/history.jsonl<br/>(append-only, trimmed to 20k lines)"]
    end

    subgraph web["http.js (express router, mounted at /usage)"]
        r1["GET /health"]
        r2["GET /providers"]
        r3["GET /headline"]
        r4["GET /:provider/config"]
        r5["GET /:provider/current"]
        r6["GET /:provider/history"]
        r7["POST /:provider/refresh"]
        r8["POST/DELETE /:provider/auth, /cookie"]
        r9["POST /admin/:action"]
    end

    orphan["dashboard.js, report.js<br/>DEAD: not imported anywhere,<br/>no GET / route exists"]
    deadroutes["GET /:provider/icon, /:provider/icons<br/>+ providers/icons/ assets<br/>DEAD: built for retired GNOME extensions,<br/>webui renders icons client-side (lucide-react)"]
    urls["usage-urls.js<br/>loadOverrides/saveOverride"]

    cfg --> entry
    reg -->|create per name| providers
    entry -->|register all 11| reg
    entry --> run
    reg -->|Runner reads factories| run
    providers -->|fetch/parse| poll
    poll --> burn
    poll -->|append snapshot| jsonl
    burn --> head
    head --> r3
    jsonl --> r6
    poll -->|in-memory latest| r4 & r5
    reg --> r2
    urls --> r8
    run -.->|runner.providers Map| web

    style orphan fill:#444,stroke:#888,color:#eee
    style deadroutes fill:#444,stroke:#888,color:#eee
```

## Dead code (post GNOME-extension-retirement)

Both confirmed by grepping every consumer in this repo, `usage-web-ui`, and the still-active `claude-usage-extension` (separate repo, doesn't talk to the daemon at all):

- **`dashboard.js` + `report.js`** — zero import references anywhere. `index.js` has the `createServer` import commented out and no `app.get('/')` route exists. The `http.js` header comment claiming `GET /` serves these is stale.
- **`GET /:provider/icon`, `GET /:provider/icons`, `findIconFile()`, `listIconVariants()`, `providers/icons/` (12 asset files)** — built to serve icon files to the retired GNOME Shell panel extensions. `usage-web-ui` renders provider icons client-side via `lucide-react` (`App.tsx:48`) and never calls these routes.

Everything else in the diagram is live — confirmed against actual `fetch()` calls in `usage-web-ui/src/client/{App,SettingsView}.tsx`.

Not yet removed; this doc is the record of what's safe to cut when that cleanup happens.
