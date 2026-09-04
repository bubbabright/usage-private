"""Port of test/time.test.js (toHostIso)."""

import re
from datetime import datetime

from usage_daemon.timeutil import to_host_iso


def test_preserves_exact_instant():
    for iso in (
        "2026-08-01T00:00:00+00:00",
        "2026-07-16T06:22:02.000Z",
        "2026-12-31T23:59:59-05:00",
    ):
        parsed = datetime.fromisoformat(to_host_iso(iso))
        expected = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        assert parsed.timestamp() == expected.timestamp()


def test_output_carries_explicit_numeric_offset():
    out = to_host_iso("2026-08-01T00:00:00Z")
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$", out)


def test_none_and_empty_pass_through():
    assert to_host_iso(None) is None
    assert to_host_iso("") == ""


def test_unparseable_string_returned_as_is():
    assert to_host_iso("not a date") == "not a date"


def test_matches_host_wall_clock_for_known_instant():
    iso = "2026-08-01T00:00:00Z"
    out = to_host_iso(iso)
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})", out)
    y, mo, d, h, mi, s = (int(g) for g in m.groups())
    loc = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone()
    assert (y, mo, d, h, mi, s) == (
        loc.year,
        loc.month,
        loc.day,
        loc.hour,
        loc.minute,
        loc.second,
    )
