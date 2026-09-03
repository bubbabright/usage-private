// Multi-provider dashboard HTML, served by the daemon at GET /.
// Thin client of the same A2 contract as multi-provider-extension:
//   GET /usage/providers, /usage/{id}/config, /usage/{id}/current
// Branch only on auth.kind — never on provider name (HANDOFF-17).
// Provider multi-select filters cards + Refresh all (URL ?p= + sessionStorage).
// Daemon owns cookies/secrets; this page never stores or redisplay them.
// Relative /usage/* URLs only (laptop / LXC / Docker same-origin).
// Zero runtime deps; self-contained string like report.js.

export function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>usage-daemon</title>
<style>
  :root { color-scheme: light dark; --border: #8884; --muted: #888; --ok: #2e7d32; --warn: #e69f00; --bad: #c62828; --card: #8881; --chip: #56b4e933; }
  * { box-sizing: border-box; }
  body { font: 15px/1.45 system-ui, sans-serif; margin: 0; padding: 1rem 1.25rem 3rem; max-width: 960px; margin-inline: auto; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; gap: .75rem 1.25rem; margin-bottom: .75rem; }
  h1 { font-size: 1.15rem; margin: 0; font-weight: 600; }
  .muted { color: var(--muted); font-size: .9rem; }
  #banner { display: none; padding: .65rem .9rem; border-radius: 8px; background: #c6282822; border: 1px solid #c6282866; margin-bottom: 1rem; }
  #banner.show { display: block; }
  #picker {
    display: flex; flex-wrap: wrap; align-items: center; gap: .5rem .65rem;
    margin-bottom: 1rem; padding: .75rem .9rem; border: 1px solid var(--border); border-radius: 10px; background: var(--card);
  }
  #picker .picker-label { font-size: .85rem; color: var(--muted); margin-right: .25rem; }
  #picker .picker-actions { display: flex; gap: .35rem; margin-left: auto; }
  #picker .picker-actions button { font-size: .8rem; padding: .25rem .55rem; }
  .chip {
    display: inline-flex; align-items: center; gap: .35rem;
    font-size: .85rem; padding: .3rem .65rem; border-radius: 999px;
    border: 1px solid var(--border); cursor: pointer; user-select: none; background: transparent;
  }
  .chip:has(input:checked) { background: var(--chip); border-color: #56b4e9; }
  .chip input { margin: 0; accent-color: #56b4e9; }
  #grid { display: grid; gap: 1rem; grid-template-columns: 1fr; }
  @media (min-width: 640px) { #grid { grid-template-columns: 1fr 1fr; } }
  .card { border: 1px solid var(--border); border-radius: 10px; padding: 1rem; background: var(--card); }
  .card-head { display: flex; gap: .75rem; align-items: center; margin-bottom: .65rem; }
  .card-head img { width: 28px; height: 28px; object-fit: contain; border-radius: 6px; }
  .avatar { width: 28px; height: 28px; border-radius: 6px; display: grid; place-items: center; font-size: .75rem; font-weight: 700; background: #8883; text-transform: uppercase; flex-shrink: 0; }
  .card-title { font-weight: 600; }
  .badges { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: .15rem; }
  .badge { font-size: .72rem; padding: .12rem .45rem; border-radius: 999px; border: 1px solid var(--border); text-transform: lowercase; }
  .badge.ok { border-color: var(--ok); color: var(--ok); }
  .badge.stale, .badge.auth_expired, .badge.rate_limited, .badge.error, .badge.pending { border-color: var(--bad); color: var(--bad); }
  .badge.tier { opacity: .85; }
  .win { margin: .55rem 0; }
  .win-meta { display: flex; justify-content: space-between; gap: .5rem; font-size: .85rem; margin-bottom: .25rem; }
  .track { height: 10px; border-radius: 5px; background: #8883; overflow: hidden; }
  .fill { height: 100%; border-radius: 5px; min-width: 0; transition: width .3s ease; }
  .fill.deplete { animation: pulse 1s ease-in-out infinite alternate; }
  @keyframes pulse { from { filter: brightness(1); } to { filter: brightness(1.35); } }
  .actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .75rem; }
  button, .btn { font: inherit; cursor: pointer; padding: .35rem .7rem; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: inherit; text-decoration: none; display: inline-block; }
  button.primary { background: #56b4e933; border-color: #56b4e9; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .auth { margin-top: .75rem; padding-top: .75rem; border-top: 1px solid var(--border); }
  .auth label { display: block; font-size: .85rem; margin-bottom: .35rem; }
  .auth textarea { width: 100%; min-height: 4.5rem; font: 12px/1.4 ui-monospace, monospace; padding: .5rem; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: inherit; resize: vertical; }
  .auth-status { font-size: .85rem; margin-top: .4rem; min-height: 1.2em; }
  .auth-note { font-size: .85rem; color: var(--muted); }
  #empty { display: none; padding: 1.5rem; border: 1px dashed var(--border); border-radius: 10px; text-align: center; color: var(--muted); }
  #empty.show { display: block; }
</style>
</head>
<body data-usage-dashboard="1">
<header>
  <h1>usage-daemon</h1>
  <span class="muted" id="meta">loading…</span>
  <button type="button" id="refresh-all" class="primary">Refresh selected</button>
</header>
<div id="picker" hidden>
  <span class="picker-label">Providers</span>
  <div id="picker-chips"></div>
  <div class="picker-actions">
    <button type="button" id="select-all">All</button>
    <button type="button" id="select-none">None</button>
  </div>
</div>
<div id="banner" role="alert"></div>
<div id="empty">No providers enabled on this daemon host. Edit the daemon config.toml.</div>
<div id="grid"></div>
<script>
(function () {
  const POLL_MS = 30000;
  const STORAGE_KEY = 'usage-daemon.selectedProviders';
  const SEEN_KEY = 'usage-daemon.seenProviders';
  const grid = document.getElementById('grid');
  const meta = document.getElementById('meta');
  const banner = document.getElementById('banner');
  const empty = document.getElementById('empty');
  const picker = document.getElementById('picker');
  const pickerChips = document.getElementById('picker-chips');
  let timer = null;
  /** @type {string[]} */
  let knownIds = [];
  /** @type {Set<string>} */
  let selected = new Set();
  /** @type {Map<string, string>} id -> label */
  let labels = new Map();
  let selectionInitialized = false;

  function showBanner(msg) {
    if (!msg) { banner.classList.remove('show'); banner.textContent = ''; return; }
    banner.textContent = msg;
    banner.classList.add('show');
  }

  async function getJson(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(path + ' → HTTP ' + res.status);
    return res.json();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function parseQuerySelection() {
    const raw = new URLSearchParams(location.search).get('p');
    if (raw == null || raw === '') return null;
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  function readSessionJson(key) {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map(String) : null;
    } catch { return null; }
  }

  function writeSessionJson(key, arr) {
    try { sessionStorage.setItem(key, JSON.stringify(arr)); } catch (_) {}
  }

  function persistSelection() {
    const arr = [...selected];
    writeSessionJson(STORAGE_KEY, arr);
    writeSessionJson(SEEN_KEY, knownIds);
    const url = new URL(location.href);
    // Never touch ?provider= (that is the single-provider report route).
    if (arr.length && knownIds.length && arr.length < knownIds.length) {
      url.searchParams.set('p', arr.join(','));
    } else {
      url.searchParams.delete('p');
    }
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }

  /**
   * Merge discovery with saved selection.
   * - First load: query → session → all
   * - Always auto-select ids never seen before (new daemon plugins)
   * - User deselections are kept (seen but not selected)
   */
  function syncSelection(ids) {
    const idSet = new Set(ids);
    // First visit (no SEEN_KEY): treat current ids as already seen so ?p= / session
    // partial selection is not force-filled. Later new plugins are not in SEEN_KEY.
    const storedSeen = readSessionJson(SEEN_KEY);
    const seenPrev = new Set(
      storedSeen != null ? storedSeen : (selectionInitialized ? knownIds : ids)
    );

    if (!selectionInitialized) {
      const fromQuery = parseQuerySelection();
      const fromSession = readSessionJson(STORAGE_KEY);
      let initial;
      if (fromQuery) initial = fromQuery.filter((id) => idSet.has(id));
      else if (fromSession) initial = fromSession.filter((id) => idSet.has(id));
      else initial = [...ids];
      selected = new Set(initial);
      selectionInitialized = true;
    } else {
      for (const id of [...selected]) {
        if (!idSet.has(id)) selected.delete(id);
      }
    }

    for (const id of ids) {
      if (!seenPrev.has(id)) selected.add(id);
    }

    knownIds = [...ids];
    persistSelection();
  }

  function renderPicker() {
    if (!knownIds.length) {
      picker.hidden = true;
      pickerChips.innerHTML = '';
      return;
    }
    picker.hidden = false;
    pickerChips.innerHTML = knownIds.map((id) => {
      const label = labels.get(id) || id;
      const checked = selected.has(id) ? ' checked' : '';
      return (
        '<label class="chip">' +
          '<input type="checkbox" data-pick="' + escapeHtml(id) + '"' + checked + '>' +
          '<span>' + escapeHtml(label) + '</span>' +
        '</label>'
      );
    }).join('');
    pickerChips.querySelectorAll('input[data-pick]').forEach((input) => {
      input.addEventListener('change', () => {
        const id = input.getAttribute('data-pick');
        if (input.checked) selected.add(id);
        else selected.delete(id);
        persistSelection();
        load({ skipDiscovery: true });
      });
    });
  }

  function pctLabel(v) {
    if (typeof v !== 'number' || Number.isNaN(v)) return '—';
    return (Math.round(v * 10) / 10) + '%';
  }

  function resetLabel(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      return 'resets ' + d.toLocaleString();
    } catch { return ''; }
  }

  function statusClass(status, stale) {
    if (stale && status === 'ok') return 'stale';
    return status || 'pending';
  }

  function letter(id, label) {
    const s = (label || id || '?').trim();
    return (s.slice(0, 2) || '?');
  }

  function windowRow(w) {
    const pct = typeof w.pct === 'number' ? Math.max(0, Math.min(100, w.pct)) : 0;
    const color = w.color || '#888';
    const deplete = w.will_deplete ? ' deplete' : '';
    return (
      '<div class="win">' +
        '<div class="win-meta">' +
          '<span style="color:' + color + '">' + escapeHtml(w.label || w.id) +
            (w.will_deplete ? ' · will deplete' : '') + '</span>' +
          '<span>' + pctLabel(w.pct) +
            (w.resets_at ? ' · ' + escapeHtml(resetLabel(w.resets_at)) : '') +
          '</span>' +
        '</div>' +
        '<div class="track"><div class="fill' + deplete + '" style="width:' + pct + '%;background:' + color + '"></div></div>' +
      '</div>'
    );
  }

  function authBlock(id, config, snap) {
    const kind = config?.auth?.kind;
    if (kind === 'cookie') {
      return (
        '<div class="auth" data-auth="cookie">' +
          '<label for="cookie-' + escapeHtml(id) + '">Session cookie — pasted here, stored only on the daemon (never redisplayed)</label>' +
          '<textarea id="cookie-' + escapeHtml(id) + '" autocomplete="off" spellcheck="false" placeholder="name=value; …"></textarea>' +
          '<div class="actions">' +
            '<button type="button" class="primary cookie-send" data-id="' + escapeHtml(id) + '">Send to daemon</button>' +
            '<button type="button" class="cookie-flush" data-id="' + escapeHtml(id) + '">Flush cookie</button>' +
          '</div>' +
          '<div class="auth-status" data-cookie-status="' + escapeHtml(id) + '"></div>' +
        '</div>'
      );
    }
    if (kind === 'oauth-file') {
      const exp = snap?.token_expires_at;
      const note = exp
        ? 'Credentials file on the daemon host — nothing to paste. Token expires ' + escapeHtml(new Date(exp).toLocaleString()) + '.'
        : 'Credentials file on the daemon host — nothing to paste here. Status comes from the live snapshot.';
      return '<div class="auth"><p class="auth-note">' + note + '</p></div>';
    }
    if (kind) {
      return '<div class="auth"><p class="auth-note">Unrecognized auth kind “' + escapeHtml(kind) + '” — nothing to configure in the UI yet.</p></div>';
    }
    return '';
  }

  function cardHtml(id, config, snap) {
    const label = config?.label || id;
    const status = snap?.status ?? 'pending';
    const stale = !!snap?.stale;
    const tier = snap?.tier;
    const windows = snap?.windows ?? config?.windows ?? [];
    const sc = statusClass(status, stale);
    const badges =
      '<span class="badge ' + sc + '">' + escapeHtml(stale && status === 'ok' ? 'stale' : status) + '</span>' +
      (tier && tier !== 'unknown' ? '<span class="badge tier">' + escapeHtml(tier) + '</span>' : '') +
      (snap?.error ? '<span class="badge error" title="' + escapeHtml(snap.error) + '">err</span>' : '');

    const icon =
      '<img src="/usage/' + encodeURIComponent(id) + '/icon" alt="" data-fallback="1" hidden>' +
      '<div class="avatar" data-avatar="' + escapeHtml(id) + '">' + escapeHtml(letter(id, label)) + '</div>';

    return (
      '<article class="card" data-provider="' + escapeHtml(id) + '">' +
        '<div class="card-head">' + icon +
          '<div><div class="card-title">' + escapeHtml(label) + '</div>' +
          '<div class="badges">' + badges + '</div></div>' +
        '</div>' +
        windows.map(windowRow).join('') +
        (windows.length ? '' : '<p class="muted">No windows yet.</p>') +
        '<div class="actions">' +
          '<button type="button" class="refresh-one" data-id="' + escapeHtml(id) + '">Refresh</button>' +
          '<a class="btn" href="/?provider=' + encodeURIComponent(id) + '">Report</a>' +
        '</div>' +
        authBlock(id, config, snap) +
      '</article>'
    );
  }

  function wireIcons(root) {
    root.querySelectorAll('img[data-fallback]').forEach((img) => {
      img.addEventListener('load', () => {
        img.hidden = false;
        const av = img.parentElement?.querySelector('[data-avatar]');
        if (av) av.hidden = true;
      });
      img.addEventListener('error', () => { img.remove(); });
      if (img.complete && img.naturalWidth) img.dispatchEvent(new Event('load'));
    });
  }

  function wireActions(root) {
    root.querySelectorAll('.refresh-one').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        btn.disabled = true;
        try {
          await fetch('/usage/' + encodeURIComponent(id) + '/refresh', { method: 'POST' });
          await load({ skipDiscovery: true });
        } catch (e) {
          showBanner('Refresh failed: ' + e.message);
        } finally {
          btn.disabled = false;
        }
      });
    });
    root.querySelectorAll('.cookie-send').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const ta = document.getElementById('cookie-' + id);
        const st = root.querySelector('[data-cookie-status="' + id + '"]');
        const cookie = (ta?.value || '').trim();
        if (!cookie) {
          if (st) st.textContent = 'Nothing to send — paste a cookie first.';
          return;
        }
        if (st) st.textContent = 'Sending…';
        btn.disabled = true;
        try {
          const res = await fetch('/usage/' + encodeURIComponent(id) + '/cookie', {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: cookie,
          });
          const snap = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(snap.error || ('HTTP ' + res.status));
          if (ta) ta.value = '';
          if (st) {
            st.textContent = snap.status === 'ok'
              ? 'Daemon accepted the cookie — live usage now flowing.'
              : 'Daemon stored cookie; status: ' + (snap.status || 'unknown') + (snap.stale ? ' (stale)' : '');
          }
          await load({ skipDiscovery: true });
        } catch (e) {
          if (st) st.textContent = 'Failed: ' + e.message;
        } finally {
          btn.disabled = false;
        }
      });
    });
    root.querySelectorAll('.cookie-flush').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const st = root.querySelector('[data-cookie-status="' + id + '"]');
        if (st) st.textContent = 'Flushing…';
        btn.disabled = true;
        try {
          const res = await fetch('/usage/' + encodeURIComponent(id) + '/cookie', { method: 'DELETE' });
          const snap = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(snap.error || ('HTTP ' + res.status));
          if (st) st.textContent = 'Cookie flushed — provider will show auth_expired until a new one is sent.';
          await load({ skipDiscovery: true });
        } catch (e) {
          if (st) st.textContent = 'Failed: ' + e.message;
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  /** Cache of last provider list rows for skipDiscovery reloads */
  let lastList = [];

  async function load(opts) {
    const skipDiscovery = opts && opts.skipDiscovery;
    try {
      let list = lastList;
      if (!skipDiscovery || !list.length) {
        list = await getJson('/usage/providers');
        lastList = list;
      }
      showBanner('');

      if (!list.length) {
        grid.innerHTML = '';
        empty.textContent = 'No providers enabled on this daemon host. Edit the daemon config.toml.';
        empty.classList.add('show');
        picker.hidden = true;
        meta.textContent = '0 providers';
        knownIds = [];
        selected = new Set();
        return;
      }

      const ids = list.map((row) => row.provider);

      // Resolve labels for picker (config is cheap + needed for cards too)
      const configs = new Map();
      await Promise.all(ids.map(async (id) => {
        try {
          const c = await getJson('/usage/' + encodeURIComponent(id) + '/config');
          configs.set(id, c);
          if (c?.label) labels.set(id, c.label);
          else labels.set(id, id);
        } catch (_) {
          labels.set(id, id);
        }
      }));

      syncSelection(ids);
      renderPicker();

      const visible = ids.filter((id) => selected.has(id));
      if (!visible.length) {
        grid.innerHTML = '';
        empty.textContent = 'Select at least one provider above.';
        empty.classList.add('show');
        meta.textContent = '0 of ' + ids.length + ' selected';
        return;
      }
      empty.classList.remove('show');

      const cards = await Promise.all(visible.map(async (id) => {
        const row = list.find((r) => r.provider === id) || {};
        const config = configs.get(id) || null;
        let snap = null;
        try { snap = await getJson('/usage/' + encodeURIComponent(id) + '/current'); } catch (_) {
          snap = { status: row.status, stale: row.stale, t: row.t, windows: [] };
        }
        return cardHtml(id, config, snap);
      }));

      grid.innerHTML = cards.join('');
      wireIcons(grid);
      wireActions(grid);
      meta.textContent = visible.length + ' of ' + ids.length + ' selected · updated ' +
        new Date().toLocaleTimeString();
    } catch (e) {
      showBanner('Cannot reach daemon API: ' + e.message);
      meta.textContent = 'offline';
    }
  }

  document.getElementById('select-all').addEventListener('click', () => {
    selected = new Set(knownIds);
    persistSelection();
    renderPicker();
    load({ skipDiscovery: true });
  });
  document.getElementById('select-none').addEventListener('click', () => {
    selected = new Set();
    persistSelection();
    renderPicker();
    load({ skipDiscovery: true });
  });

  document.getElementById('refresh-all').addEventListener('click', async () => {
    const ids = [...selected];
    await Promise.all(ids.map((id) =>
      fetch('/usage/' + encodeURIComponent(id) + '/refresh', { method: 'POST' }).catch(() => null)
    ));
    await load();
  });

  function schedule() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (document.hidden) return;
      load();
    }, POLL_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) load();
  });

  load();
  schedule();
})();
</script>
</body>
</html>`;
}
