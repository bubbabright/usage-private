from pathlib import Path

import pytest

from usage_daemon.errors import AuthExpiredError
from usage_daemon.providers.firecrawl import parse, slice_credits

FIXTURE = Path(__file__).parent / "fixtures" / "firecrawl-credit-usage.json"
envelope = FIXTURE.read_text(encoding="utf-8")


def test_slice_credits_splits_balance_into_cycles_and_slice():
    assert slice_credits(8056, 1000) == {"cycles": 8, "sliceRemaining": 56}
    assert slice_credits(8000, 1000) == {"cycles": 8, "sliceRemaining": 1000}
    assert slice_credits(500, 1000) == {"cycles": 0, "sliceRemaining": 500}
    assert slice_credits(0, 1000) == {"cycles": 0, "sliceRemaining": 0}


def test_parse_credits_window_shows_remaining_count_no_bar():
    out = parse(envelope)
    w = next(x for x in out["windows"] if x["id"] == "credits")
    assert out["tier"] is None
    assert w["pct"] is None
    assert w["used"] == 3000
    assert w["cap"] == 10000
    assert w["unit"] == "credits"
    assert w["color"] == "#0072B2"
    assert out["_credits"]["cycles_remaining"] == 0


def test_parse_rollover_still_pct_null():
    top = parse('{"remaining_credits": 8056, "plan_credits": 1000}')
    assert top["windows"][0]["pct"] is None
    assert top["_credits"]["cycles_remaining"] == 8
    rolled = parse('{"remaining_credits": 8000, "plan_credits": 1000}')
    assert rolled["windows"][0]["pct"] is None


def test_parse_resets_at_surfaces_even_with_banked_cycles():
    banked = parse('{"remaining_credits": 8056, "plan_credits": 1000, "period_end": "2026-08-14T13:25:19.683Z"}')
    assert banked["_credits"]["cycles_remaining"] == 8
    assert banked["windows"][0]["resets_at"] == "2026-08-14T13:25:19.683Z"


def test_parse_resets_at_on_last_slice_too():
    last = parse('{"remaining_credits": 400, "plan_credits": 1000, "period_end": "2026-08-14T13:25:19.683Z"}')
    assert last["_credits"]["cycles_remaining"] == 0
    assert last["windows"][0]["resets_at"] == "2026-08-14T13:25:19.683Z"
    assert last["windows"][0]["pct"] is None


def test_parse_no_plan_size_is_bare_count_meter():
    out = parse('{"remaining_credits": 500}')
    assert out["windows"][0]["pct"] is None
    assert out["windows"][0]["used"] == 500
    assert out["_credits"]["remaining"] == 500
    assert out["_credits"]["cycles_remaining"] is None


def test_parse_error_payload_raises_auth_expired():
    with pytest.raises(AuthExpiredError):
        parse('{"success": false, "error": "Unauthorized"}')


def test_parse_missing_credit_figures_raises():
    with pytest.raises(AuthExpiredError):
        parse('{"plan_credits": 10000}')


def test_parse_unparseable_envelope_raises():
    with pytest.raises(AuthExpiredError):
        parse("not json")
