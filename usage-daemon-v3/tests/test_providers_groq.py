from pathlib import Path

import pytest

from usage_daemon.errors import AuthExpiredError
from usage_daemon.providers.groq import parse, GROQ_FREE_TIER_MODEL_LIMITS, _org_id_from_jwt, _aggregate_activity_data, _daily_limit_windows

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
            "timestamp": 1789050000,
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
            "timestamp": 1789055000,
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


def test_parse_empty_data_raises():
    # Empty data with no windows is treated as no usable activity data
    with pytest.raises(AuthExpiredError):
        parse(_envelope([], GROQ_FREE_TIER_MODEL_LIMITS))


def test_parse_unparseable_raises():
    with pytest.raises(AuthExpiredError):
        parse("not json")


def test_org_id_from_jwt():
    jwt_seg = "eyJodHRwczovL2dyb3EuY29tL29yZ2FuaXphdGlvbiI6eyJpZCI6Im9yZ18wMWtjcWJzMWFkZnNndDU1eXBhY3gzeDd4aiJ9fQ"
    # Reconstruct a JWT-like string with header.payload.signature
    jwt = f"header.{jwt_seg}.signature"
    org = _org_id_from_jwt(jwt)
    assert org == "org_01kcqbs1adfsgt55ypacx3x7xj"


def test_aggregate_activity_data():
    agg = _aggregate_activity_data(SAMPLE_ACTIVITY["data"])
    ms = agg["model_stats"]
    assert "openai/gpt-oss-20b" in ms
    assert ms["openai/gpt-oss-20b"]["requests"] == 65
    assert ms["openai/gpt-oss-20b"]["cost"] == pytest.approx(0.0003705)
    assert ms["llama-3.1-8b-instant"]["requests"] == 2


def test_daily_limit_windows_builds_for_known_models():
    agg = _aggregate_activity_data(SAMPLE_ACTIVITY["data"])
    windows = _daily_limit_windows(agg["model_stats"], GROQ_FREE_TIER_MODEL_LIMITS)
    assert len(windows) == 1  # only llama-3.1-8b-instant has a known limit
    w = windows[0]
    assert w["used"] == 2
    assert w["cap"] == 14400
    assert w["pct"] == pytest.approx(100 * 2 / 14400)