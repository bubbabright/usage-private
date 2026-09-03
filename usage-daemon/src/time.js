// Datetime normalization for snapshot output.
//
// Providers emit reset timestamps in whatever form upstream gives (Anthropic/
// xAI use UTC `...Z` or `...+00:00`, our own toISOString() uses `Z`). The
// runner funnels every window's `resets_at` through toHostIso() so the daemon
// speaks ONE representation to all clients: ISO-8601 in the HOST's local time
// zone (the LXC/Docker container's TZ), with an explicit numeric offset.
//
// The instant is preserved exactly — only the wall-clock rendering + offset
// change — so relative "resets in Xh" math (which parses back to a Date) is
// unaffected, while absolute display shows the operator's local time.

function pad(n, width = 2) {
  return String(Math.abs(n)).padStart(width, '0');
}

// Convert an ISO-ish timestamp string to ISO-8601 in the host's local zone.
// Null/empty passes through untouched; an unparseable string is returned as-is
// (fail-soft — never throw inside snapshot assembly).
export function toHostIso(input) {
  if (!input) return input;
  const d = new Date(input);
  const ms = d.getTime();
  if (Number.isNaN(ms)) return input;

  // getTimezoneOffset(): minutes the local zone is BEHIND UTC at this date
  // (accounts for DST at the target instant). East-of-UTC → positive offset.
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';

  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.trunc(Math.abs(offMin) / 60))}:${pad(Math.abs(offMin) % 60)}`
  );
}
