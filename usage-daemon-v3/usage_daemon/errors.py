"""Shared provider error taxonomy.

Mirrors the JS daemon's error contract: providers raise these to signal
auth/rate-limit conditions, and the runner maps them onto the snapshot
`error` field and the `auth_expired` / `rate_limited` flags. `.code` mirrors the
JS `err.code`; `RateLimitedError.retryAfter` mirrors `err.retryAfter`.
"""


class ProviderError(Exception):
    """Base class for all provider fetch/parse failures."""

    code = "error"
    retryAfter = None

    def __init__(self, message: str = "provider error", *, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


class AuthExpiredError(ProviderError):
    """Credentials are missing/expired/rejected; snapshot flags auth_expired."""

    code = "auth_expired"


class RateLimitedError(ProviderError):
    """Upstream returned 429 / rate-limit; snapshot flags rate_limited.

    Mirrors JS `new RateLimitedError(retryAfter)`: the first positional arg is
    the Retry-After seconds (may be None).
    """

    code = "rate_limited"

    def __init__(
        self,
        retry_after: int | float | None = None,
        message: str = "rate_limited",
    ):
        super().__init__(message)
        self.retryAfter = retry_after


def code_of(err: BaseException) -> str:
    """Map an exception to the JS-style status code string."""
    if isinstance(err, AuthExpiredError):
        return "auth_expired"
    if isinstance(err, RateLimitedError):
        return "rate_limited"
    if isinstance(err, ProviderError):
        return err.code
    return "error"