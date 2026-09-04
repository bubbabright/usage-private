"""Port of test/log.test.js — write/timestamp, greppable fields, rotation, degrade.

log.py reads env at import; the daemon's own test run may have set USAGE_LOG_*
via os.environ mutation in test_runner (import order), so these tests drive the
runtime configure() surface (same as the JS tests do after the initial import).
"""

import os
import re
import tempfile

from usage_daemon import log as logmod

_tmp = tempfile.mkdtemp(prefix="usage-daemon-log-")
LOG_PATH = os.path.join(_tmp, "daemon.log")

logmod.configure({"file": LOG_PATH, "level": "debug", "stderr": False})
log = logmod.log


def _text():
    with open(logmod.log_file(), encoding="utf-8") as f:
        return f.read()


def test_writes_timestamped_level_tagged_line():
    log.info("hello")
    text = _text()
    assert re.search(
        r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} INFO  usage-daemon: hello$",
        text,
        re.M,
    ), text


def test_renders_context_as_greppable_key_value_pairs():
    log.warn("poll failed", {"provider": "grok", "consecutive_failures": 3})
    assert re.search(r"poll failed provider=grok consecutive_failures=3", _text())


def test_quotes_values_with_spaces_and_flattens_newlines():
    log.error("boom", {"error": "token missing\nor expired"})
    assert 'error="token missing\\nor expired"' in _text()


def test_level_filtering_drops_below_configured_level():
    logmod.configure({"level": "error"})
    log.info("should-not-appear")
    log.error("should-appear")
    text = _text()
    assert "should-not-appear" not in text
    assert "should-appear" in text
    logmod.configure({"level": "debug"})


def test_rotates_at_max_bytes_and_keeps_n_generations():
    rot_dir = tempfile.mkdtemp(prefix="usage-daemon-rot-")
    rot_path = os.path.join(rot_dir, "daemon.log")
    logmod.configure({"file": rot_path, "max_bytes": 500, "keep": 2})
    for i in range(40):
        log.info(f"line {i} " + "x" * 40)
    assert os.path.exists(rot_path), "live log exists"
    assert os.path.exists(rot_path + ".1"), "rotated generation 1 exists"
    assert not os.path.exists(rot_path + ".3"), "keep=2 means no third generation"
    logmod.configure({"file": LOG_PATH, "max_bytes": 5 * 1024 * 1024, "keep": 3})


def test_unwritable_file_degrades_instead_of_throwing():
    # A path whose parent is a regular file can never be created.
    blocker = os.path.join(_tmp, "blocker")
    with open(blocker, "w") as f:
        f.write("not a directory")
    logmod.configure({"file": os.path.join(blocker, "nested", "daemon.log")})
    log.error("still alive")  # must not raise
    logmod.configure({"file": LOG_PATH})
    assert logmod.log_file() == LOG_PATH
