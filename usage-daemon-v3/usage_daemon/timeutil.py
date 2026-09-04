"""Datetime normalization for snapshot output (port of src/time.js).

Providers emit reset timestamps in whatever form upstream gives. The runner
funnels every window's resets_at through to_host_iso() so the daemon speaks ONE
representation to all clients: ISO-8601 in the HOST's local time zone with an
explicit numeric offset. The instant is preserved exactly.

Fail-soft: null/empty passes through; an unparseable value is returned as-is.
"""

import re
from datetime import datetime, timedelta, timezone

_ISO_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})"
    r"[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?"
    r"\s*(Z|[+-]\d{2}:?\d{2})?$"
)


def _format_local(dt: datetime) -> str:
    """Render a datetime as YYYY-MM-DDTHH:MM:SS+HH:MM in its own local offset."""
    off = dt.utcoffset() or timedelta(0)
    total = int(off.total_seconds())
    sign = "+" if total >= 0 else "-"
    total = abs(total)
    oh, om = total // 3600, (total % 3600) // 60
    return (
        f"{dt.year:04d}-{dt.month:02d}-{dt.day:02d}"
        f"T{dt.hour:02d}:{dt.minute:02d}:{dt.second:02d}"
        f"{sign}{oh:02d}:{om:02d}"
    )


def _epoch_to_iso(seconds: float) -> str:
    return _format_local(datetime.fromtimestamp(seconds).astimezone())


def _parse_full(s: str) -> datetime | None:
    """Parse the ISO strings upstream actually emits; return an aware datetime."""
    m = _ISO_RE.match(s)
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    hh, mi = int(m.group(4)), int(m.group(5))
    ss = int(m.group(6) or 0)
    frac = (m.group(7) or "").ljust(6, "0")[:6]
    micro = int(frac) if frac else 0
    zone = m.group(8)
    if zone in (None, ""):
        # No offset: JS treats a zoned-less ISO as LOCAL. Attach the local zone.
        return datetime(y, mo, d, hh, mi, ss, micro).astimezone()
    if zone == "Z":
        tz = timezone.utc
    else:
        z = zone.replace(":", "")
        zm = int(z[1:3]) * 60 + int(z[3:5])
        if z[0] == "-":
            zm = -zm
        tz = timezone(timedelta(minutes=zm))
    return datetime(y, mo, d, hh, mi, ss, micro, tzinfo=tz)


def to_host_iso(value):
    """Convert an ISO/epoch/eNum token into host-local ISO; fail-soft otherwise."""
    if value is None or value == "":
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            return _epoch_to_iso(float(value))
        except Exception:
            return value
    if isinstance(value, str):
        s = value.strip()
        # Bare epoch seconds ("1788525960") — treat as a unix timestamp.
        if s.isdigit() and 1_000_000_000 < int(s) < 10_000_000_000:
            try:
                return _epoch_to_iso(float(s))
            except Exception:
                return value
        dt = _parse_full(s)
        if dt is None:
            # last-ditch: let the stdlib try it (accepts many forms)
            try:
                dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            except Exception:
                return value
        try:
            return _format_local(dt.astimezone())
        except Exception:
            return value
    return value