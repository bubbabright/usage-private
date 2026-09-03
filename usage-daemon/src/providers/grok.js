// Grok / SuperGrok usage provider plugin — descriptor interface (HANDOFF-14).
//
// Two transports, one poll (mirrors grok-usage-extension/extension.js):
//   - MONTHLY: clean JSON off the CLI proxy
//     GET https://cli-chat-proxy.grok.com/v1/billing  (Bearer)
//   - WEEKLY : undocumented gRPC-web protobuf off grok.com
//     POST .../GetGrokCreditsConfig  (empty gRPC-web frame → protobuf scan)
// Weekly is BEST-EFFORT / non-fatal — only monthly drives error state, exactly
// like the extension. The token is read from ~/.grok/auth.json (the same file
// the `grok` CLI manages). READ-ONLY: this daemon never writes that file and
// never refreshes the token — expired/missing → auth_expired, clients render
// last-known-good dimmed. `grok login` remains the only thing that mutates it.
//
// parse() is a PURE function of a combined envelope string
//   { billing: "<monthly json text>", credits: "<base64 weekly bytes | null>" }
// so it unit-tests against the vendored fixture with no network/fs. fetch()
// adds the credentials read + both HTTP calls + envelope assembly around it.
// Field mapping / protobuf scan ported verbatim from the live extension (the
// extractor is the spec — read it, don't guess the shapes).

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Grok inverts claude's color mapping (see grok-usage-extension/stylesheet.css).
export const MONTHLY_COLOR = '#56B4E9'; // Okabe-Ito blue
export const WEEKLY_COLOR = '#E69F00';  // Okabe-Ito orange

export const ID = 'grok';
export const LABEL = 'Grok';

const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing';
const CREDITS_URL = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig';
const USER_AGENT = 'GrokUsageExtension/1.0';

export class AuthExpiredError extends Error {
  constructor(msg = 'Grok token missing or expired') {
    super(msg);
    this.code = 'auth_expired';
  }
}

export class RateLimitedError extends Error {
  constructor(retryAfter = null) {
    super('rate_limited');
    this.code = 'rate_limited';
    this.retryAfter = retryAfter;
  }
}

function defaultAuthPath() {
  return path.join(os.homedir(), '.grok', 'auth.json');
}

// ~/.grok/auth.json is keyed by issuer::client_id → { key, refresh_token,
// expires_at, ... }. Prefer a non-expired entry; fall back progressively.
// Ported from extension.js:973-994.
function extractToken(json) {
  if (!json || typeof json !== 'object') return null;
  const now = Date.now();
  let fallback = null;
  for (const v of Object.values(json)) {
    if (!v || typeof v !== 'object' || !v.key) continue;
    if (!fallback) fallback = v.key;
    if (v.expires_at) {
      const exp = new Date(v.expires_at).getTime();
      if (!Number.isNaN(exp) && exp > now) return v.key;
    } else {
      return v.key;
    }
  }
  return fallback || json.key || json.access_token || null;
}

// Ported from extension.js:996-1004.
function extractExpiry(json) {
  if (!json || typeof json !== 'object') return null;
  for (const v of Object.values(json)) {
    if (v && typeof v === 'object' && v.expires_at) return v.expires_at;
  }
  return json.expires_at || null;
}

// Monthly billing fields may arrive as bare scalars or wrapped { val: x }.
function valOf(x) {
  if (x == null) return null;
  if (typeof x === 'object' && 'val' in x) return x.val;
  return x;
}

// --- gRPC-web / protobuf helpers for GetGrokCreditsConfig (CodexBar-compatible) ---
// Ported verbatim from extension.js:100-281 (plain JS, no GJS dependency).

function _readVarint(bytes, indexRef) {
  let value = 0;
  let shift = 0;
  while (indexRef.i < bytes.length && shift < 35) {
    const b = bytes[indexRef.i++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return value >>> 0;
    shift += 7;
  }
  return null;
}

function _grpcWebDataFrames(bytes) {
  const frames = [];
  let i = 0;
  while (i + 5 <= bytes.length) {
    const flags = bytes[i];
    const length = (bytes[i + 1] << 24) | (bytes[i + 2] << 16) |
      (bytes[i + 3] << 8) | bytes[i + 4];
    const start = i + 5;
    const end = start + length;
    if (length < 0 || end > bytes.length) return null;
    if ((flags & 0x80) === 0) frames.push(bytes.subarray(start, end));
    i = end;
  }
  return frames;
}

function _looksLikeProtobuf(bytes) {
  if (!bytes || bytes.length === 0) return false;
  const first = bytes[0];
  const fieldNumber = first >> 3;
  const wireType = first & 0x07;
  return fieldNumber > 0 && (wireType === 0 || wireType === 1 ||
    wireType === 2 || wireType === 5);
}

// Scan protobuf (nested up to depth 4) for fixed32 floats and varints.
// Port of CodexBar GrokWebBillingFetcher.scanProtobuf.
function _scanProtobuf(bytes, depth = 0, prefix = [], orderRef = { n: 0 }) {
  const fixed32 = [];
  const varints = [];
  const indexRef = { i: 0 };
  while (indexRef.i < bytes.length) {
    const fieldStart = indexRef.i;
    const key = _readVarint(bytes, indexRef);
    if (key === null || key === 0) {
      indexRef.i = fieldStart + 1;
      continue;
    }
    const fieldNumber = key >>> 3;
    const wireType = key & 0x07;
    const fieldPath = prefix.concat(fieldNumber);

    if (wireType === 0) {
      const value = _readVarint(bytes, indexRef);
      if (value === null) {
        indexRef.i = fieldStart + 1;
        continue;
      }
      varints.push({ path: fieldPath, value });
    } else if (wireType === 1) {
      if (indexRef.i + 8 > bytes.length) break;
      indexRef.i += 8;
    } else if (wireType === 2) {
      const length = _readVarint(bytes, indexRef);
      if (length === null || indexRef.i + length > bytes.length) {
        indexRef.i = fieldStart + 1;
        continue;
      }
      const start = indexRef.i;
      const end = start + length;
      if (depth < 4) {
        const nested = _scanProtobuf(
          bytes.subarray(start, end), depth + 1, fieldPath, orderRef);
        fixed32.push(...nested.fixed32);
        varints.push(...nested.varints);
      }
      indexRef.i = end;
    } else if (wireType === 5) {
      if (indexRef.i + 4 > bytes.length) break;
      const view = new DataView(
        bytes.buffer, bytes.byteOffset + indexRef.i, 4);
      const value = view.getFloat32(0, true);
      fixed32.push({ path: fieldPath, value, order: orderRef.n++ });
      indexRef.i += 4;
    } else {
      indexRef.i = fieldStart + 1;
    }
  }
  return { fixed32, varints };
}

// Parse GetGrokCreditsConfig response bytes → { usedPercent, resetsAtMs } | null.
// Ported from extension.js:207-281.
export function parseGrokCreditsConfig(rawBytes) {
  if (!rawBytes || rawBytes.length === 0) return null;
  const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);

  let payloads = _grpcWebDataFrames(bytes);
  if (!payloads || payloads.length === 0) {
    if (_looksLikeProtobuf(bytes)) payloads = [bytes];
    else return null;
  }

  const allFixed = [];
  const allVarint = [];
  const orderRef = { n: 0 };
  for (const payload of payloads) {
    const scan = _scanProtobuf(payload, 0, [], orderRef);
    allFixed.push(...scan.fixed32);
    allVarint.push(...scan.varints);
  }

  // credit_usage_percent: fixed32 float 0–100, field number ending in 1;
  // prefer shallower paths (CodexBar: min path length, then order).
  const percentCandidates = allFixed.filter((f) =>
    f.path.length > 0 &&
    f.path[f.path.length - 1] === 1 &&
    Number.isFinite(f.value) &&
    f.value >= 0 && f.value <= 100,
  );
  percentCandidates.sort((a, b) =>
    a.path.length === b.path.length
      ? a.order - b.order
      : a.path.length - b.path.length,
  );
  let usedPercent = percentCandidates.length ? percentCandidates[0].value : null;

  // Reset: prefer path [1, 5, 1] (period end), else soonest future unix ts.
  const nowSec = Date.now() / 1000;
  const tsFields = allVarint.filter((f) =>
    f.value >= 1_700_000_000 && f.value <= 2_100_000_000,
  );
  const future = tsFields.filter((f) => f.value > nowSec);
  let resetsAtSec = null;
  const preferred = future.find((f) =>
    f.path.length === 3 && f.path[0] === 1 && f.path[1] === 5 && f.path[2] === 1,
  );
  if (preferred) resetsAtSec = preferred.value;
  else if (future.length) resetsAtSec = Math.min(...future.map((f) => f.value));

  // proto3 omits zero floats — period present + no % → 0% used.
  const hasUsagePeriod = allVarint.some((f) =>
    (f.path.length >= 2 && f.path[0] === 1 && f.path[1] === 6) ||
    (f.path.length === 3 && f.path[0] === 1 && f.path[1] === 8 &&
      f.path[2] === 1 && (f.value === 1 || f.value === 2)),
  );
  if (usedPercent === null && allFixed.length === 0 &&
    resetsAtSec != null && hasUsagePeriod) usedPercent = 0;

  if (usedPercent === null) return null;

  return {
    usedPercent,
    resetsAtMs: resetsAtSec != null ? resetsAtSec * 1000 : null,
  };
}

// Pure function of the combined envelope text — no fs/network.
//   raw = '{"billing":"<monthly json text>","credits":"<base64|null>"}'
// Monthly drives validity (mirrors claude: a body that isn't a usage response
// throws AuthExpiredError). Weekly is best-effort: absent/unparseable credits
// yield a weekly window with null pct rather than failing the whole snapshot.
export function parse(raw) {
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new AuthExpiredError('unparseable grok envelope');
  }

  // --- monthly ---
  let billing;
  try {
    billing = JSON.parse(envelope.billing);
  } catch {
    throw new AuthExpiredError('unparseable billing response');
  }
  const cfg = billing?.config || billing;
  const used = valOf(cfg?.used);
  const limit = valOf(cfg?.monthlyLimit);
  // used missing/unparseable = auth actually broken. limit === 0 or missing
  // is a real plan state (no monthly-included cap — usage tracked by weekly
  // credits/on-demand instead), not an auth failure; emit pct: null rather
  // than failing the whole snapshot (same "no limit" convention mistral.js
  // uses for its monthly_spend window).
  if (used == null) throw new AuthExpiredError();

  const monthly = {
    id: 'monthly',
    label: 'Monthly',
    letter: 'Mo',
    pct: limit ? (100 * used) / limit : null,
    resets_at: cfg.billingPeriodEnd || null,
    color: MONTHLY_COLOR,
    will_deplete: false,
  };

  // --- weekly (best-effort) ---
  let weeklyPct = null;
  let weeklyResets = null;
  if (envelope.credits) {
    const bytes = new Uint8Array(Buffer.from(envelope.credits, 'base64'));
    const parsedWeek = parseGrokCreditsConfig(bytes);
    if (parsedWeek) {
      weeklyPct = parsedWeek.usedPercent;
      weeklyResets = parsedWeek.resetsAtMs != null
        ? new Date(parsedWeek.resetsAtMs).toISOString()
        : null;
    }
  }
  const weekly = {
    id: 'weekly',
    label: 'Weekly',
    letter: 'Wk',
    pct: weeklyPct,
    resets_at: weeklyResets,
    color: WEEKLY_COLOR,
    will_deplete: false,
  };

  // shorter-window-first, matching claude/ollama ([session, weekly]) — array
  // order IS display order, no renderer sorts by duration.
  return { tier: null, windows: [weekly, monthly], segments: [] };
}

function createProvider() {
  let authPath = defaultAuthPath();
  let lastTokenExpiresAt = null; // surfaced via meta() — set on each auth read

  return {
    id: ID,
    label: LABEL,
    auth: { kind: 'oauth-file' },

    config() {
      return {
        id: ID,
        label: LABEL,
        usageUrl: 'https://grok.com/?_s=usage',
        // path/relogin let a client explain an auth_expired instead of just
        // showing it: this token is read straight from the Grok CLI's own file
        // and never refreshed here, so re-login IS the fix.
        auth: { kind: 'oauth-file', path: authPath, relogin: 'grok login' },
        windows: [
          { id: 'monthly', label: 'Monthly', color: MONTHLY_COLOR },
          { id: 'weekly', label: 'Weekly', color: WEEKLY_COLOR },
        ],
        tiers: [],
      };
    },

    configure(cfg = {}) {
      const p = cfg.authPath || cfg.auth_path;
      if (p) authPath = p;
    },

    async setAuth(payload) {
      await fs.mkdir(path.dirname(authPath), { recursive: true });
      await fs.writeFile(authPath, payload + '\n', { mode: 0o600 });
    },

    async fetch() {
      let token;
      try {
        const rawAuth = await fs.readFile(authPath, 'utf8');
        const json = JSON.parse(rawAuth);
        token = extractToken(json);
        lastTokenExpiresAt = extractExpiry(json);
      } catch {
        throw new AuthExpiredError('no Grok auth file found (run `grok login`)');
      }
      if (!token) throw new AuthExpiredError('no token in ~/.grok/auth.json');

      // Monthly — authoritative for error state.
      const billingRes = await fetch(BILLING_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
      });
      if (billingRes.status === 401) throw new AuthExpiredError();
      if (billingRes.status === 429) {
        const retryAfter = Number(billingRes.headers.get('retry-after')) || null;
        throw new RateLimitedError(retryAfter);
      }
      if (!billingRes.ok) throw new Error(`cli-chat-proxy.grok.com HTTP ${billingRes.status}`);
      const billing = await billingRes.text();

      // Weekly — best-effort; any failure leaves credits null, never throws.
      let credits = null;
      try {
        const weeklyRes = await fetch(CREDITS_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/grpc-web+proto',
            'x-grpc-web': '1',
            'x-user-agent': 'connect-es/2.1.1',
            Origin: 'https://grok.com',
            Referer: 'https://grok.com/?_s=usage',
            Accept: '*/*',
            'User-Agent': USER_AGENT,
          },
          // Empty gRPC-web data frame (5 zero bytes).
          body: new Uint8Array([0, 0, 0, 0, 0]),
        });
        if (weeklyRes.ok) {
          const buf = Buffer.from(await weeklyRes.arrayBuffer());
          credits = buf.toString('base64');
        }
      } catch {
        credits = null;
      }

      return JSON.stringify({ billing, credits });
    },

    intervalSeconds() {
      return 300;
    },

    meta() {
      return { token_expires_at: lastTokenExpiresAt };
    },

    parse,
  };
}

export { createProvider };
