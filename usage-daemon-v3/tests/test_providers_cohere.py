"""Port of test/cohere.test.js — parse() against the usage API fixture."""

import json
from pathlib import Path

import pytest

from usage_daemon.errors import AuthExpiredError
from usage_daemon.providers.cohere import parse

FIXTURE = Path(__file__).parent / "fixtures" / "cohere-usage.json"
raw = FIXTURE.read_text(encoding="utf-8")


def test_parse_tokens_window_sums_input_output():
    windows = parse(raw)["windows"]
    assert len(windows) == 1
    w = windows[0]
    assert w["id"] == "tokens"
    assert w["label"] == "Tokens (30d)"
    assert w["letter"] == "Tk"
    assert w["used"] == 16973  # (36+4692+36) input + (9+12189+11) output
    assert w["cap"] is None
    assert w["pct"] is None
    assert w["resets_at"] is None
    assert w["color"] == "#D55E00"


def test_parse_cohere_meta_with_raw_figures():
    meta = parse(raw)["_cohere"]
    assert meta["input_tokens"] == 4764
    assert meta["output_tokens"] == 12209
    assert meta["total_tokens"] == 16973


def test_parse_empty_usages_gives_zero_tokens():
    windows = parse(json.dumps({"usages": []}))["windows"]
    assert windows[0]["used"] == 0


def test_parse_missing_usages_raises_auth_expired():
    with pytest.raises(AuthExpiredError):
        parse(json.dumps({}))


def test_parse_unparseable_json_raises_auth_expired():
    with pytest.raises(AuthExpiredError):
        parse("not json")