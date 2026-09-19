import { useState } from 'react';
import { X, Eye, EyeOff, Download, Upload } from 'lucide-react';

// App-wide UI preferences, opened via the gear icon in the sidebar header.
// Distinct from ProviderSettingsModal (SettingsView.tsx), which holds
// per-provider auth/visibility settings.
export function GlobalSettingsModal({ onClose, providers, hidden, onToggleHidden, providerUrls, onSetUrl, defaultUrlFor, onExport, onImport }: any) {
  const [importNote, setImportNote] = useState<{ ok: boolean; msg: string } | null>(null);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div
        className="bg-neutral-900 border border-neutral-700 rounded-xl p-4 w-full max-w-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-medium text-lg">Settings</h4>
          <button onClick={onClose} className="text-neutral-300 hover:text-neutral-200 p-1">
            <X size={16} />
          </button>
        </div>

        <div className="flex items-center justify-between gap-2 p-2 bg-neutral-950 rounded-lg border border-neutral-700">
          <span className="text-base text-neutral-200">Config</span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={onExport}
              title="Download visibility, card groups, provider URLs and settings as JSON"
              className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium bg-neutral-800 hover:bg-neutral-700 text-neutral-200 transition-colors"
            >
              <Download size={14} /> Export
            </button>
            <label
              title="Load a previously exported config file (replaces current settings)"
              className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium bg-neutral-800 hover:bg-neutral-700 text-neutral-200 transition-colors cursor-pointer"
            >
              <Upload size={14} /> Import
              <input
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  const err = onImport(await file.text());
                  setImportNote(err ? { ok: false, msg: err } : { ok: true, msg: `Imported ${file.name}` });
                }}
              />
            </label>
          </div>
        </div>
        {importNote && (
          <p className={`mt-1 text-sm ${importNote.ok ? 'text-emerald-400' : 'text-red-400'}`}>{importNote.msg}</p>
        )}

        {Array.isArray(providers) && providers.length > 0 && (
          <div className="mt-3">
            <div className="text-base text-neutral-200 mb-2">Providers</div>
            <div className="space-y-1 max-h-80 overflow-y-auto">
              {providers.map((p: any) => {
                const isHidden = hidden?.has(p.provider);
                return (
                  <div
                    key={p.provider}
                    className="flex items-center justify-between gap-2 p-2 bg-neutral-950 rounded-lg border border-neutral-700"
                  >
                    <span className="text-base text-neutral-200 capitalize truncate w-28 shrink-0">{p.provider}</span>
                    <input
                      type="url"
                      value={providerUrls?.[p.provider] ?? ''}
                      placeholder={defaultUrlFor(p.provider) || 'no default — https://…'}
                      onChange={(e) => onSetUrl(p.provider, e.target.value)}
                      title="Opened by double-clicking the card. Placeholder = default; empty uses it."
                      className="flex-1 min-w-0 px-2 py-1.5 rounded-md text-sm bg-neutral-900 border border-neutral-700 text-neutral-100 placeholder:text-neutral-300 focus:outline-none focus:border-neutral-500"
                    />
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => onToggleHidden(p.provider)}
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
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
