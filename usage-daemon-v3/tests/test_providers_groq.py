import asyncio
import datetime
from pathlib import Path

import pytest

from usage_daemon.errors import AuthExpiredError, ProviderError
from usage_daemon.providers.groq import (
    parse,
    GROQ_FREE_TIER_MODEL_LIMITS,
    GROQ_FREE_TIER_TOKEN_LIMITS,
    _org_id_from_jwt,
    _aggregate_activity_data,
    _daily_limit_windows,
    _exchange_stytch_session,
)

_ORG_JWT_SEG = "eyJodHRwczovL2dyb3EuY29tL29yZ2FuaXphdGlvbiI6eyJpZCI6Im9yZ18wMWtjcWJzMWFkZnNndDU1eXBhY3gzeDd4aiJ9fQ"

_DAY_START = int(datetime.datetime.now(datetime.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).timestamp())

SAMPLE_ACTIVITY = {
    "object": "list",
    "data": [
        {
            "organization_id": "org_01kcqbs1adfsgt55ypacx3x7xj",
            "organization_name": "Personal",
            "n_context_tokens_total": 4680,
            "n_non_cached_context_tokens_total": 4680,
            "n_generated_tokens_total": 65,
            "project_id": "project_01kcqbs1v3fskrj1vn902c54me",
            "api_key_id": "key_01m08554v4evjbbnmv3xqa0nez",
            "api_key_name": "usage-dashboard",
            "model": "openai/gpt-oss-20b",
            "timestamp": _DAY_START + 7200,
            "num_requests": 65,
            "cost": 0.0003705,
        },
        {
            "organization_id": "org_01kcqbs1adfsgt55ypacx3x7xj",
            "organization_name": "Personal",
            "n_context_tokens_total": 144,
            "n_non_cached_context_tokens_total": 144,
            "n_generated_tokens_total": 2,
            "model": "llama-3.1-8b-instant",
            "timestamp": _DAY_START + 10800,
            "num_requests": 2,
            "cost": 1.14e-05,
        },
    ],
}


def _envelope(activity_data=None, model_limits=None):
    import json
    env = {"object": "list", "data": activity_data or []}
    if model_limits:
        env["_groq_model_limits"] = model_limits
    return json.dumps(env)


def test_parse_builds_cost_tokens_context_requests_windows():
    raw = _envelope(SAMPLE_ACTIVITY["data"], GROQ_FREE_TIER_MODEL_LIMITS)
    out = parse(raw)
    assert out["tier"] is None
    assert len(out["windows"]) >= 4
    ids = [w["id"] for w in out["windows"]]
    assert "cost" in ids
    assert "generated_tokens" in ids
    assert "context_tokens" in ids
    assert "requests" in ids

    cost_w = next(w for w in out["windows"] if w["id"] == "cost")
    assert cost_w["used"] == pytest.approx(0.0003705 + 1.14e-05)
    assert cost_w["unit"] == "USD"


def test_parse_daily_limit_windows_for_known_models():
    raw = _envelope(SAMPLE_ACTIVITY["data"], GROQ_FREE_TIER_MODEL_LIMITS)
    out = parse(raw)
    daily_ids = [w["id"] for w in out["windows"] if w["letter"] == "D"]
    # model name "llama-3.1-8b-instant" → "llama_3.1_8b_instant" via replace('/', '_').replace('-', '_')
    assert any("llama_3.1_8b_instant" in wid for wid in daily_ids)


def test_parse_empty_data_raises_provider_error():
    # Empty data with no windows is a data problem, not an auth expiry
    with pytest.raises(ProviderError):
        parse(_envelope([], GROQ_FREE_TIER_MODEL_LIMITS))


def test_parse_unparseable_raises():
    with pytest.raises(AuthExpiredError):
        parse("not json")


def test_org_id_from_jwt():
    jwt = f"header.{_ORG_JWT_SEG}.signature"
    org = _org_id_from_jwt(jwt)
    assert org == "org_01kcqbs1adfsgt55ypacx3x7xj"


class _FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload


class _FakeClient:
    def __init__(self, response):
        self.response = response
        self.last_call = None

    async def post(self, *args, **kwargs):
        self.last_call = (args, kwargs)
        return self.response

    async def aclose(self):
        pass


def test_exchange_reads_data_session_jwt_shape():
    jwt = f"header.{_ORG_JWT_SEG}.signature"
    client = _FakeClient(_FakeResponse({"data": {"session_jwt": jwt}}))
    result = asyncio.run(_exchange_stytch_session("tok", "pub", "https://x", client))
    assert result == (jwt, "org_01kcqbs1adfsgt55ypacx3x7xj")
    url, kwargs = client.last_call
    assert url == ("https://x/sdk/v1/b2b/sessions/authenticate",)
    assert kwargs["json"] == {"session_token": "tok", "session_duration_minutes": 30}
    assert kwargs["headers"]["Content-Type"] == "application/json"
    assert kwargs["headers"]["Authorization"].startswith("Basic ")
    assert kwargs["headers"]["X-SDK-Client"]


def test_exchange_falls_back_to_session_jwt_shape():
    jwt = f"header.{_ORG_JWT_SEG}.signature"
    client = _FakeClient(_FakeResponse({"session": {"jwt": jwt}}))
    result = asyncio.run(_exchange_stytch_session("tok", "pub", "https://x", client))
    assert result == (jwt, "org_01kcqbs1adfsgt55ypacx3x7xj")


def test_exchange_non_200_returns_none():
    client = _FakeClient(_FakeResponse({"error": "nope"}, status_code=400))
    result = asyncio.run(_exchange_stytch_session("tok", "pub", "https://x", client))
    assert result is None


def test_aggregate_activity_data():
    agg = _aggregate_activity_data(SAMPLE_ACTIVITY["data"])
    ms = agg["model_stats"]
    assert "openai/gpt-oss-20b" in ms
    assert ms["openai/gpt-oss-20b"]["requests"] == 65
    assert ms["openai/gpt-oss-20b"]["cost"] == pytest.approx(0.0003705)
    assert ms["llama-3.1-8b-instant"]["requests"] == 2


def test_aggregate_activity_data_uses_month_window():
    now = datetime.datetime.now(datetime.timezone.utc)
    day_start = int(now.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
    entries = [
        {"model": "m1", "timestamp": day_start - 10 * 86400, "num_requests": 5, "cost": 0.1},
        {"model": "m1", "timestamp": day_start - 40 * 86400, "num_requests": 99, "cost": 9.9},
        {"model": "m1", "timestamp": day_start + 86400 + 60, "num_requests": 99, "cost": 9.9},
    ]
    agg = _aggregate_activity_data(entries)
    st = agg["model_stats"]["m1"]
    assert st["requests"] == 5
    assert st["cost"] == pytest.approx(0.1)
    assert st["requests_today"] == 0


def test_daily_limit_windows_builds_for_known_models():
    agg = _aggregate_activity_data(SAMPLE_ACTIVITY["data"])
    windows = _daily_limit_windows(agg["model_stats"], GROQ_FREE_TIER_MODEL_LIMITS)
    assert len(windows) == 2  # gpt-oss-20b and llama-3.1-8b-instant both have known caps
    llama = next(w for w in windows if "llama" in w["id"])
    assert llama["used"] == 2
    assert llama["cap"] == 14400
    assert llama["pct"] == pytest.approx(100 * 2 / 14400)
    gpt_oss = next(w for w in windows if "gpt_oss" in w["id"])
    assert gpt_oss["used"] == 65
    assert gpt_oss["cap"] == 1000


def test_daily_token_limit_windows_build_for_known_models():
    agg = _aggregate_activity_data(SAMPLE_ACTIVITY["data"])
    windows = _daily_limit_windows(agg["model_stats"], GROQ_FREE_TIER_MODEL_LIMITS, GROQ_FREE_TIER_TOKEN_LIMITS)
    llama = next(w for w in windows if w["id"] == "daily_tokens_llama_3.1_8b_instant")
    assert llama["unit"] == "tokens"
    assert llama["used"] == 146  # 144 non-cached + 2 generated; cached excluded
    assert llama["cap"] == 500000
    gpt_oss = next(w for w in windows if w["id"] == "daily_tokens_openai_gpt_oss_20b")
    assert gpt_oss["used"] == 4745  # 4680 non-cached + 65 generated
    assert gpt_oss["cap"] == 200000