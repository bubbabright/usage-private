"""Compiled-in provider registry (port of src/registry.js).

Providers self-register via a factory (name -> create_provider). NOT dynamic
plugin loading — adding a provider = one import + one register() call at startup.
Also enforces the provider path-segment allowlist / traversal guard for HTTP.
"""

from __future__ import annotations

import re

_PROVIDER_SEG = re.compile(r"^[a-z0-9][a-z0-9_-]*$", re.IGNORECASE)


class Registry:
    def __init__(self) -> None:
        self._factories: dict[str, callable] = {}

    def register(self, name: str, factory: callable) -> None:
        if name in self._factories:
            raise ValueError(f"provider already registered: {name}")
        self._factories[name] = factory

    def has(self, name: str) -> bool:
        return name in self._factories

    def names(self) -> list[str]:
        return list(self._factories.keys())

    def create(self, name: str):
        f = self._factories.get(name)
        if f is None:
            raise KeyError(f"unknown provider: {name}")
        return f()

    def valid_segment(self, value: str) -> bool:
        """Traversal guard for the HTTP :provider path param."""
        return bool(_PROVIDER_SEG.match(value or ""))


# Module-level singleton, as the JS modules export one registry.
registry = Registry()