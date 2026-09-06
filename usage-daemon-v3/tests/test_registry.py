"""Compiled-in registration coverage.

Guards the wiring regression where a provider module exists on disk with a
create() factory but was never added to _register_compiled_in() — the daemon
then logs "config names unknown provider, skipping" for it at startup even
though tests for its parser all pass.
"""

import importlib
import pkgutil

import pytest

from usage_daemon import __main__ as entry
from usage_daemon.registry import registry as reg


@pytest.fixture()
def clean_registry():
    """Isolate the singleton Registry instance: start empty, restore afterwards."""
    saved = dict(reg._factories)
    reg._factories.clear()
    yield reg
    reg._factories.clear()
    reg._factories.update(saved)


def _provider_modules() -> set[str]:
    import usage_daemon.providers as pkg

    modules = {
        name for _, name, _ in pkgutil.iter_modules(pkg.__path__) if name != "__init__"
    }
    assert modules, "no provider modules discovered — import path broken?"
    return modules


def test_register_compiled_in_covers_every_provider_module(clean_registry):
    entry._register_compiled_in()
    assert _provider_modules() <= set(reg.names()), (
        f"modules not wired into _register_compiled_in: "
        f"{sorted(_provider_modules() - set(reg.names()))}"
    )


def test_register_compiled_in_registers_exactly_the_modules(clean_registry):
    entry._register_compiled_in()
    assert set(reg.names()) == _provider_modules()


def test_registered_factories_are_callable(clean_registry):
    """reg.create() calls factory() with no args — pilots take create_provider(),
    newer modules take create(); both must be zero-arg callable."""
    entry._register_compiled_in()
    for name in reg.names():
        assert callable(reg._factories[name]), name


def test_registry_duplicate_registration_raises(clean_registry):
    entry._register_compiled_in()
    with pytest.raises(ValueError, match="already registered"):
        entry._register_compiled_in()  # second call in-process must fail loudly


def test_registry_create_unknown_provider_raises(clean_registry):
    with pytest.raises(KeyError, match="unknown provider"):
        reg.create("no-such-provider")


def test_registry_valid_segment_guard(clean_registry):
    assert reg.valid_segment("ollama")
    assert reg.valid_segment("opencode-go")
    assert not reg.valid_segment("../etc")
    assert not reg.valid_segment("")
    assert not reg.valid_segment(None)