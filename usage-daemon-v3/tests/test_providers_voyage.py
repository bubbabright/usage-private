import asyncio
from datetime import datetime

import pytest

from usage_daemon.errors import AuthExpiredError
from usage_daemon.providers.voyage import create, parse


def test_parse_free_token_response():
    snap = parse({"data": [{"modelName": "voyage-4", "totalFreeToken": 10000, "remainingToken": 8750}]})
    window = snap["windows"][0]
    assert window["used"] == 1250
    assert window["cap"] == 10000
    assert window["pct"] == 12.5
    datetime.fromisoformat(window["resets_at"].replace("Z", "+00:00"))


def test_parse_derived_remaining():
    snap = parse({"used": 20, "remaining": 80})
    assert snap["windows"][0]["cap"] == 100


def test_parse_requires_quota():
    with pytest.raises(AuthExpiredError):
        parse({"status": "ok"})


def test_fetch_requires_access_token():
    with pytest.raises(AuthExpiredError):
        asyncio.run(create()["fetch"]())
