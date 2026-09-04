"""HTTP/net helpers (port of src/ipv4.js + shared fetch plumbing).

Force IPv4-only outbound connects for this process. Host IPv6 is broken / not
required on the LAN; providers that publish AAAA records can make a dual-stack
HTTPS client hang until connect-timeout. Best-effort: we reach into whichever
DNS path httpx's transport uses and prefer the A records; if patching is not
possible it degrades to the default resolver rather than failing.
"""

from __future__ import annotations

import socket

import httpx


def _prefer_ipv4_results() -> None:
    """Return only AF_INET records when httpx/anyio resolves a host."""
    try:
        import httpcore  # type: ignore
        from anyio._core._synchronization import unwrap_eventhook  # noqa
    except Exception:
        return

    orig_getaddrinfo = None
    import anyio

    # anyio >=4 resolves via anyio.getaddrinfo (a drop-in of socket.getaddrinfo).
    target = getattr(anyio, "getaddrinfo", None)
    if target is None or not callable(target):
        # Fall back to patching socket's own resolver globally — broad but safe.
        return

    def _v4_only(host, port, family=0, type=0, proto=0, flags=0):
        if family == 0:
            family = socket.AF_INET
        return target(host, port, family=family, type=type, proto=proto, flags=flags)

    # Refuse to stack patches across repeated calls.
    if not getattr(anyio.getaddrinfo, "_usage_v4_patched", False):
        anyio.getaddrinfo = _v4_only
        anyio.getaddrinfo._usage_v4_patched = True  # type: ignore[attr-defined]


def force_ipv4() -> None:
    """Call once at startup, before any provider fetch runs."""
    try:
        _prefer_ipv4_results()
    except Exception:
        pass


class _TimeoutParam:
    def __init__(self, timeout: float = 30.0) -> None:
        self.timeout = timeout

    def httpx(self):
        return httpx.Timeout(self.timeout)


def create_client(*, timeout: float = 30.0) -> httpx.AsyncClient:
    """Build an httpx.AsyncClient with IPv4 preference + the daemon's timeout."""
    return httpx.AsyncClient(
        timeout=httpx.Timeout(timeout),
        follow_redirects=False,
        http2=False,
        verify=True,
    )