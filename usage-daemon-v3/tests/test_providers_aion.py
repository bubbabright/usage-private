from pathlib import Path

import pytest

from usage_daemon.errors import AuthExpiredError
from usage_daemon.providers.aion import next_utc_midnight, parse


FIXTURE = Path(__file__).parent / "fixtures" / "aion-usage.html"


def test_parse_quota_and_request_segments():
    body = parse(FIXTURE.read_text(encoding="utf-8"))
    window = body["windows"][0]
    assert window["id"] == "daily_tokens"
    assert window["used"] == 266
    assert window["cap"] == 20000
    assert window["pct"] == pytest.approx(1.33)
    assert window["resets_at"].endswith("Z")
    assert body["_aion"]["remaining"] == 19734
    assert body["segments"][0]["model"] == "aion-labs/aion-3.0"
    assert body["segments"][0]["total_tokens"] == 28


def test_parse_login_page_raises():
    with pytest.raises(AuthExpiredError):
        parse('<title>Sign In | Aion Labs</title><form action="/accounts/login/">')


def test_parse_missing_quota_raises():
    with pytest.raises(AuthExpiredError):
        parse("<html><body>Welcome</body></html>")


def test_next_utc_midnight_is_in_the_future():
    from datetime import datetime, timezone

    reset = datetime.fromisoformat(next_utc_midnight().replace("Z", "+00:00"))
    assert reset > datetime.now(timezone.utc)
    assert reset.hour == 0
