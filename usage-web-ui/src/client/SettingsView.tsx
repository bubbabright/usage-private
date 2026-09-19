import React, { useEffect, useState } from 'react';
import { X, Eye, EyeOff } from 'lucide-react';
import { ProviderIcon } from './App';

// Per-provider settings, opened via the gear icon on that provider's sidebar row.
export function ProviderSettingsModal({ provider, providerMeta, onClose, onRefresh, hidden, onToggleHidden, url, defaultUrl, onSetUrl }: any) {
  const [config, setConfig] = useState<any>(null);
  const [revealed, setRevealed] = useState(false);
  // "Refresh from Firefox" state. The daemon exposes cookie_from_firefox on the
  // provider row only when config.toml gave that provider a domain, so the
  // button appears exactly where it can work.
  const [ffBusy, setFfBusy] = useState(false);
  const [ffNote, setFfNote] = useState<string | null>(null);
  // Shared busy/verdict state for the credential forms below.
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/usage/${provider}/config`);
        if (res.ok && !cancelled) setConfig(await res.json());
      } catch (e) {}
    })();
    return () => { cancelled = true; };
  }, [provider]);

  const isHidden = hidden?.has(provider);
  const hasForm =
    config?.auth?.kind === 'cookie' ||
    config?.auth?.kind === 'oauth-file' ||
    config?.auth?.kind === 'token';
  const connected = providerMeta?.status === 'ok' && !providerMeta?.stale;
  const showForm = !hasForm || !connected || revealed;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div
        className="bg-neutral-900 border border-neutral-700 rounded-xl p-4 w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-medium text-lg capitalize flex items-center gap-2">
            <ProviderIcon provider={provider} size={18} className="text-emerald-400" />
            {provider}
          </h4>
          <div className="flex items-center gap-2">
            {hasForm && connected && (
              <span className="text-sm text-emerald-400 bg-emerald-950/50 border border-emerald-900 px-2 py-1 rounded flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
                Connected
              </span>
            )}
            {config?.auth && (
              <span className="text-sm text-neutral-200 bg-neutral-950 px-2 py-1 rounded">{config.auth.kind}</span>
            )}
            <button onClick={onClose} className="text-neutral-300 hover:text-neutral-200 p-1">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between mb-3 p-2 bg-neutral-950 rounded-lg border border-neutral-700">
          <span className="text-base text-neutral-200">Visibility</span>
          <button
            onClick={() => onToggleHidden(provider)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              isHidden
                ? 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200'
                : 'bg-emerald-950/50 border border-emerald-900 text-emerald-400 hover:bg-emerald-950'
            }`}
            title={isHidden ? 'Hidden — click to show' : 'Visible — click to hide'}
          >
            {isHidden ? <><EyeOff size={14} /> Hidden</> : <><Eye size={14} /> Visible</>}
          </button>
        </div>

        <div className="mb-3 p-2 bg-neutral-950 rounded-lg border border-neutral-700">
          <label className="block text-base text-neutral-200 mb-1">
            Provider URL <span className="text-neutral-300 text-sm">(double-click a card to open)</span>
          </label>
          <input
            type="url"
            value={url ?? ''}
            placeholder={defaultUrl || 'https://…'}
            onChange={(e) => onSetUrl(provider, e.target.value)}
            className="w-full px-2 py-1.5 rounded-md text-sm bg-neutral-900 border border-neutral-700 text-neutral-100 placeholder:text-neutral-300 focus:outline-none focus:border-neutral-500"
          />
          {defaultUrl && <div className="mt-1 text-sm text-neutral-300">Leave empty to use the default: {defaultUrl}</div>}
        </div>

        {config?.auth && (
          <>
            {hasForm && connected && !revealed && (
              <div className="flex items-center justify-between">
                <p className="text-base text-neutral-200">Credentials accepted.</p>
                <button
                  onClick={() => setRevealed(true)}
                  className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded-lg text-base font-medium transition-colors whitespace-nowrap"
                >
                  Replace credentials
                </button>
              </div>
            )}

            {hasForm && connected && revealed && (
              <button
                onClick={() => setRevealed(false)}
                className="text-sm text-neutral-200 hover:text-neutral-100 mb-2"
              >
                ← cancel
              </button>
            )}

            {showForm && config.auth.kind === 'cookie' && (
              <div className="flex flex-col gap-2">
                <p className="text-base text-neutral-200">
                  Paste a session cookie. Stored daemon-side.
                </p>

                {providerMeta?.cookie_from_firefox && (
                  <div className="flex flex-col gap-1 pb-1 border-b border-neutral-700">
                    <button
                      disabled={ffBusy}
                      onClick={async () => {
                        setFfBusy(true);
                        setFfNote(null);
                        try {
                          const r = await fetch(`/usage/${provider}/cookie/from-firefox`, { method: 'POST' });
                          const body = await r.json().catch(() => ({}));
                          if (r.ok) {
                            setRevealed(false);
                            onRefresh();
                          } else {
                            setFfNote(body.error || 'could not read the cookie from Firefox');
                          }
                        } catch {
                          setFfNote('request failed');
                        } finally {
                          setFfBusy(false);
                        }
                      }}
                      className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-lg text-base font-medium transition-colors"
                    >
                      {ffBusy ? 'Reading Firefox…' : `Refresh from Firefox (${providerMeta.cookie_from_firefox})`}
                    </button>
                    <p className="text-sm text-neutral-300">
                      Pulls this site's cookie from your local Firefox profile once — log in there first if it's expired.
                      {providerMeta.cookie_expires_at && (
                        <> Last read expires {new Date(providerMeta.cookie_expires_at).toLocaleString()}.</>
                      )}
                    </p>
                    {ffNote && <p className="text-sm text-red-400">{ffNote}</p>}
                  </div>
                )}
                <textarea
                  id={`cookie-input-${provider}`}
                  placeholder="name=value; ..."
                  className="w-full h-16 bg-neutral-950 border border-neutral-700 rounded-lg p-2 text-base font-mono text-neutral-200 focus:outline-none focus:border-emerald-500 resize-none custom-scrollbar"
                />
                <div className="flex gap-2">
                  <button
                    disabled={saving}
                    onClick={async () => {
                      const val = (document.getElementById(`cookie-input-${provider}`) as HTMLTextAreaElement).value;
                      if (!val) return;
                      setSaving(true); setResult(null);
                      try {
                        const r = await fetch(`/usage/${provider}/cookie`, { method: 'POST', body: val });
                        const snap = await r.json().catch(() => ({}));
                        if (!r.ok) {
                          setResult({ ok: false, msg: snap.error || `save failed (HTTP ${r.status})` });
                        } else if (snap.status === 'ok') {
                          setResult({ ok: true, msg: `Cookie accepted — ${provider} is live.` });
                          setRevealed(false);
                        } else {
                          setResult({ ok: false, msg: `Rejected: ${snap.error || snap.status}` });
                        }
                        onRefresh();
                      } catch {
                        setResult({ ok: false, msg: 'Request failed' });
                      } finally {
                        setSaving(false);
                      }
                    }}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-base font-medium transition-colors"
                  >
                    {saving ? 'Checking cookie…' : 'Set Cookie'}
                  </button>
                  <button
                    disabled={saving}
                    onClick={async () => {
                      setSaving(true); setResult(null);
                      try {
                        await fetch(`/usage/${provider}/cookie`, { method: 'DELETE' });
                        setResult({ ok: true, msg: 'Stored cookie flushed.' });
                        setRevealed(false);
                        onRefresh();
                      } finally {
                        setSaving(false);
                      }
                    }}
                    className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 text-neutral-200 rounded-lg text-base font-medium transition-colors"
                  >
                    Flush
                  </button>
                </div>
                {result && (
                  <p className={`text-sm ${result.ok ? 'text-emerald-400' : 'text-red-400'}`}>{result.msg}</p>
                )}
              </div>
            )}

            {showForm && config.auth.kind === 'oauth-file' && (
              <div className="flex flex-col gap-2">
                <p className="text-base text-neutral-200">
                  Paste CLI credentials JSON.
                </p>
                <textarea
                  id={`oauth-input-${provider}`}
                  placeholder='{"accessToken": "..."}'
                  className="w-full h-20 bg-neutral-950 border border-neutral-700 rounded-lg p-2 text-base font-mono text-neutral-200 focus:outline-none focus:border-emerald-500 resize-none custom-scrollbar"
                />
                <div className="flex gap-2">
                  <button
                    onClick={async () => {
                      const val = (document.getElementById(`oauth-input-${provider}`) as HTMLTextAreaElement).value;
                      if (!val) return;
                      await fetch(`/usage/${provider}/auth`, { method: 'POST', body: JSON.stringify({ payload: val }), headers: { 'Content-Type': 'application/json' } });
                      setRevealed(false);
                      onRefresh();
                    }}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-base font-medium transition-colors"
                  >
                    Set Credentials
                  </button>
                </div>
              </div>
            )}

            {showForm && config.auth.kind === 'token' && (
              <div className="flex flex-col gap-2">
                <p className="text-base text-neutral-200">
                  {config.auth.relogin
                    ? `Paste: ${config.auth.relogin}. Stored daemon-side, never shown back.`
                    : 'Paste an API key. Stored daemon-side, never shown back.'}
                </p>
                <input
                  id={`token-input-${provider}`}
                  type="password"
                  placeholder={config.auth.relogin ? 'Session token / JWT' : 'API key'}
                  className="w-full bg-neutral-950 border border-neutral-700 rounded-lg p-2 text-base font-mono text-neutral-200 focus:outline-none focus:border-emerald-500"
                />
                <div className="flex gap-2">
                  <button
                    disabled={saving}
                    onClick={async () => {
                      const val = (document.getElementById(`token-input-${provider}`) as HTMLInputElement).value;
                      if (!val) return;
                      // Feedback matters more here than anywhere else in this
                      // modal: the daemon validates the key by actually calling
                      // the provider, and on rejection the form re-renders
                      // identically (connected stays false, so showForm stays
                      // true). Without a spinner and a verdict, a rejected key
                      // is indistinguishable from a dead button.
                      setSaving(true); setResult(null);
                      try {
                        const r = await fetch(`/usage/${provider}/auth`, {
                          method: 'POST',
                          body: JSON.stringify({ payload: val }),
                          headers: { 'Content-Type': 'application/json' },
                        });
                        const snap = await r.json().catch(() => ({}));
                        if (!r.ok) {
                          setResult({ ok: false, msg: snap.error || `save failed (HTTP ${r.status})` });
                        } else if (snap.status === 'ok') {
                          setResult({ ok: true, msg: 'Key accepted.' });
                          setRevealed(false);
                        } else {
                          setResult({ ok: false, msg: `Rejected: ${snap.error || snap.status}` });
                        }
                        onRefresh();
                      } catch {
                        setResult({ ok: false, msg: 'Request failed' });
                      } finally {
                        setSaving(false);
                      }
                    }}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-base font-medium transition-colors"
                  >
                    {saving ? 'Checking key…' : 'Set Key'}
                  </button>
                  <button
                    disabled={saving}
                    onClick={async () => {
                      setSaving(true); setResult(null);
                      try {
                        await fetch(`/usage/${provider}/auth`, { method: 'DELETE' });
                        setResult({ ok: true, msg: 'Stored key purged.' });
                        setRevealed(false);
                        onRefresh();
                      } finally {
                        setSaving(false);
                      }
                    }}
                    className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 text-neutral-200 rounded-lg text-base font-medium transition-colors"
                  >
                    Purge
                  </button>
                </div>
                {result && (
                  <p className={`text-sm ${result.ok ? 'text-emerald-400' : 'text-red-400'}`}>{result.msg}</p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
