import asyncio
import base64
import json
from pathlib import Path

import pytest

from usage_daemon.errors import AuthExpiredError
from usage_daemon.providers.context7 import (
    parse,
    _clerk_refresh_jwt,
    _session_id_from_jwt,
    _session_jwt_from_cookie_header,
)

_SESSION_JWT = "header.{}.".format(
    base64.urlsafe_b64encode(
        json.dumps({"sid": "sess_abc123", "role": "authenticated"}).encode()
    ).decode().rstrip("=")
)

FIXTURE = Path(__file__).parent / "fixtures" / "context7-stats.json"
raw = FIXTURE.read_text(encoding="utf-8")


def test_parse_tier_from_owner_plan():
    assert parse(raw)["tier"] == "free"


def test_parse_requests_window_shows_remaining_not_consumed():
    windows = parse(raw)["windows"]
    assert len(windows) == 1
    w = windows[0]
    assert w["id"] == "requests"
    assert w["label"] == "Requests/mo"
    assert w["letter"] == "Rq"
    assert w["used"] == 997
    assert w["used_is_remaining"] is True
    assert w["cap"] == 1000
    assert w["unit"] == "requests"
    assert w["color"] == "#F0E442"
    assert w["resets_at"] is None
    assert w["will_deplete"] is False


def test_parse_pct_is_consumed_fraction():
    assert parse(raw)["windows"][0]["pct"] == pytest.approx(0.3)


def test_parse_pct_null_without_quota_limit():
    w = parse('{"success": true, "data": {"userRequests": 5}}')["windows"][0]
    assert w["pct"] is None
    assert w["cap"] is None


def test_parse_meta_carries_raw_figures():
    assert parse(raw)["_context7"] == {
        "quotaLimit": 1000,
        "userRequests": 3,
        "ownerPlan": "free",
        "creditBalance": 0,
    }


def test_parse_success_false_raises():
    with pytest.raises(AuthExpiredError):
        parse('{"success": false}')


def test_parse_missing_data_raises():
    with pytest.raises(AuthExpiredError):
        parse('{"success": true}')


def test_parse_no_user_requests_raises():
    with pytest.raises(AuthExpiredError):
        parse('{"success": true, "data": {}}')


def test_parse_unparseable_json_raises():
    with pytest.raises(AuthExpiredError):
        parse("not json")


def test_session_id_extracted_from_jwt():
    assert _session_id_from_jwt(_SESSION_JWT) == "sess_abc123"
    assert _session_id_from_jwt("garbage") is None


def test_session_jwt_read_from_cookie_header():
    header = f"foo=bar; __session={_SESSION_JWT}; other=x"
    assert _session_jwt_from_cookie_header(header) == _SESSION_JWT
    assert _session_jwt_from_cookie_header("foo=bar") is None


class _FakeResponse:
    def __init__(self, json_payload, status_code=200):
        self._json = json_payload
        self.status_code = status_code

    def json(self):
        return self._json


class _FakeClient:
    def __init__(self, response):
        self.response = response
        self.last_call = None

    async def post(self, *args, **kwargs):
        self.last_call = (args, kwargs)
        return self.response

    async def aclose(self):
        pass


def test_clerk_refresh_mints_jwt_from_session_cookie():
    client = _FakeClient(_FakeResponse({"object": "token", "jwt": "fresh.jwt"}))
    result = asyncio.run(
        _clerk_refresh_jwt(f"__session={_SESSION_JWT}", client)
    )
    assert result == "fresh.jwt"
    url, kwargs = client.last_call
    assert url == ("https://clerk.context7.com/v1/client/sessions/sess_abc123/tokens",)
    assert kwargs["headers"]["Origin"] == "https://context7.com"
    assert "__session=" in kwargs["headers"]["Cookie"]


def test_clerk_refresh_returns_none_without_session_cookie():
    client = _FakeClient(_FakeResponse({}))
    assert asyncio.run(_clerk_refresh_jwt("foo=bar", client)) is None


def test_clerk_refresh_returns_none_on_error():
    client = _FakeClient(_FakeResponse({"error": "x"}, status_code=401))
    assert asyncio.run(_clerk_refresh_jwt(f"__session={_SESSION_JWT}", client)) is None
