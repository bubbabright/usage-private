"""Port of test/cookiejar.test.js — the pure parts of Firefox cookie handling.

to_epoch_seconds guards the FF-153 millisecond-stamp trap: comparing an ms
stamp against a seconds-based clock makes every cookie look unexpired, which
silently defeats the expired-cookie filter — the bug these tests pin.
"""

from datetime import datetime, timezone

from usage_daemon.cookiejar import host_matches, soonest_expiry, to_cookie_header, to_epoch_seconds

MS_STAMP = 1_787_030_245_429  # real value observed in this profile (a __cf_bm cookie)


# --- toEpochSeconds ---


def test_passes_seconds_stamp_through():
    assert to_epoch_seconds(1_787_030_245) == 1_787_030_245


def test_converts_millisecond_stamps_firefox_153_stores():
    assert to_epoch_seconds(MS_STAMP) == 1_787_030_245.429


def test_converts_microsecond_stamps():
    assert to_epoch_seconds(1_787_030_245_429_000) == 1_787_030_245.429


def test_session_cookies_and_junk_have_no_expiry():
    for v in (0, -1, None, float("nan"), float("inf"), "soon"):
        assert to_epoch_seconds(v) is None, str(v)


def test_millisecond_stamp_not_mistaken_for_far_future_date():
    # The original bug: 1.787e12 read as seconds lands in the year 58598.
    # (JS Date can represent that; Python datetime caps at year 9999, so the
    # sanity check is done arithmetically: ms -> s -> Julian years since 1970.)
    naive_year = 1970 + (MS_STAMP * 1000) // 31_556_952
    assert naive_year > 50_000, "sanity: the naive reading really is absurd"
    # NB: JS Date wants ms; Python fromtimestamp wants seconds (already normalized).
    fixed = datetime.fromtimestamp(to_epoch_seconds(MS_STAMP), timezone.utc).year
    assert fixed == 2026


# --- hostMatches ---


def test_exact_domain():
    assert host_matches("ollama.com", "ollama.com") is True


def test_leading_dot_domain_covers_bare_domain():
    assert host_matches(".mistral.ai", "mistral.ai") is True


def test_subdomains_belong_to_the_domain():
    for h in ("console.mistral.ai", "admin.mistral.ai", "chat.mistral.ai"):
        assert host_matches(h, "mistral.ai") is True, h


def test_different_registrable_domain_never_matches():
    assert host_matches("notmistral.ai", "mistral.ai") is False
    assert host_matches("mistral.ai.evil.com", "mistral.ai") is False
    assert host_matches("ollama.com", "mistral.ai") is False


def test_empty_or_garbage_input_is_not_a_match():
    for h, d in (("", "mistral.ai"), (None, "mistral.ai"), ("mistral.ai", ""), (None, None)):
        assert host_matches(h, d) is False


# --- toCookieHeader ---


def test_serializes_name_value_pairs_joined_with_semicolon():
    header = to_cookie_header(
        [
            {"name": "aid", "value": "A1"},
            {"name": "__Secure-session", "value": "S1"},
        ]
    )
    assert header == "aid=A1; __Secure-session=S1"


def test_later_rows_win_on_duplicate_names():
    # Rows arrive shortest-host-first, so the subdomain's csrftoken should win.
    header = to_cookie_header(
        [
            {"name": "csrftoken", "value": "from-bare-domain"},
            {"name": "csrftoken", "value": "from-console-subdomain"},
        ]
    )
    assert header == "csrftoken=from-console-subdomain"


def test_skips_nameless_rows_and_tolerates_missing_value():
    header = to_cookie_header(
        [
            {"name": "", "value": "x"},
            {"name": None, "value": "y"},
            {"name": "oc_locale"},
        ]
    )
    assert header == "oc_locale="


def test_empty_input_yields_empty_header():
    assert to_cookie_header([]) == ""


# --- soonestExpiry ---


def test_reports_earliest_real_expiry_as_iso():
    later, sooner = 2_000_000_000, 1_900_000_000
    iso = soonest_expiry([{"expiry": later}, {"expiry": sooner}])
    assert iso == datetime.fromtimestamp(sooner, timezone.utc).isoformat()


def test_normalizes_millisecond_rows_to_a_sane_year():
    iso = soonest_expiry([{"expiry": 1_787_030_245_429}, {"expiry": 1_787_111_197_664}])
    assert datetime.fromisoformat(iso).year == 2026
    assert iso == datetime.fromtimestamp(1_787_030_245.429, timezone.utc).isoformat()


def test_mixed_seconds_and_millisecond_rows_compare_on_one_scale():
    # seconds row is the earlier one; the ms row must not win by being a bigger number
    iso = soonest_expiry([{"expiry": 1_787_111_197_664}, {"expiry": 1_787_030_245}])
    assert iso == datetime.fromtimestamp(1_787_030_245, timezone.utc).isoformat()


def test_session_cookies_have_no_date_to_report():
    assert soonest_expiry([{"expiry": 0}, {"expiry": None}]) is None
    assert soonest_expiry([]) is None


def test_ignores_session_cookies_when_a_real_expiry_is_present():
    real = 1_900_000_000
    assert soonest_expiry([{"expiry": 0}, {"expiry": real}]) == datetime.fromtimestamp(
        real, timezone.utc
    ).isoformat()
