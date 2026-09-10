"""Cloudflare provider parse tests (port of test/cloudflare.test.js)."""

from __future__ import annotations

import json
import pathlib

import pytest

from usage_daemon.errors import AuthExpiredError, RateLimitedError
from usage_daemon.providers.cloudflare import (
    FREE_NEURONS_PER_DAY,
    next_utc_midnight,
    parse,
)

HERE = pathlib.Path(__file__).parent
# Real capture of aiInferenceAdaptiveGroups for one UTC day (2026-07-18), only
# the account tag scrubbed. 7 per-model rows summing to 4983.683301 neurons.
REAL = (HERE / "fixtures" / "cloudflare-ai-day.json").read_text()


def test_parse_sums_total_neurons_across_models():
    out = parse(REAL)
    w = next(x for x in out["windows"] if x["id"] == "daily_neurons")

    expected_pct = (100 * 4983.683301429079) / FREE_NEURONS_PER_DAY
    assert abs(w["pct"] - expected_pct) < 1e-6
    assert w["color"] == "#E69F00"
    assert w["resets_at"] == next_utc_midnight()

    # per-model segments, largest first
    segs = out["segments"]
    assert len(segs) == 7
    assert segs[0]["neurons"] >= segs[-1]["neurons"]
    assert segs[0]["model"].startswith("@cf/")


def test_parse_empty_groups_is_zero_pct_not_an_error():
    empty = json.dumps({
        "data": {"viewer": {"accounts": [{"aiInferenceAdaptiveGroups": []}]}},
        "errors": None,
    })
    out = parse(empty)
    assert out["windows"][0]["pct"] == 0


def test_parse_overage_past_free_allocation_is_not_clamped():
    over = json.dumps({
        "data": {
            "viewer": {
                "accounts": [
                    {
                        "aiInferenceAdaptiveGroups": [
                            {
                                "sum": {"totalNeurons": 15000},
                                "dimensions": {"date": "2026-07-23", "modelId": "@cf/x"},
                            },
                        ],
                    },
                ],
            },
        },
    })
    assert parse(over)["windows"][0]["pct"] == 150


def test_parse_graphql_auth_error_throws_auth_expired():
    err = json.dumps({
        "data": None,
        "errors": [{"message": "Authentication error", "extensions": {"code": "authz"}}],
    })
    with pytest.raises(AuthExpiredError):
        parse(err)


def test_parse_graphql_quota_error_throws_rate_limited():
    err = json.dumps({
        "data": None,
        "errors": [{"message": "time range too wide", "extensions": {"code": "quota"}}],
    })
    with pytest.raises(RateLimitedError):
        parse(err)


def test_parse_no_account_matched_throws_auth_expired():
    none = json.dumps({"data": {"viewer": {"accounts": []}}})
    with pytest.raises(AuthExpiredError):
        parse(none)
