"""Config loading (port of src/config.js).

Reads config.toml via stdlib tomllib; exposes port, providers (with *_file
secrets resolved inline), [control], and [logging]. The config lives at
$XDG_CONFIG_HOME/usage-daemon/config.toml with a fallback to <cwd>/config.toml.
"""

from __future__ import annotations

import os
import tomllib
from pathlib import Path

from .log import log

DEFAULT_PORT = 8787


def expand_home(p: str | None) -> str | None:
    if not p:
        return p
    if p == "~":
        return os.path.expanduser("~")
    if p.startswith("~/"):
        return os.path.join(os.path.expanduser("~"), p[2:])
    return os.path.expanduser(p)


def _config_path() -> Path:
    xdg = os.environ.get("XDG_CONFIG_HOME") or os.path.join(
        os.path.expanduser("~"), ".config"
    )
    return Path(xdg) / "usage-daemon" / "config.toml"


DEFAULTS = {
    "port": DEFAULT_PORT,
    "providers": {"ollama": {"enabled": True, "interval_seconds": 300}},
}


def _read_first(*paths: Path):
    for p in paths:
        try:
            return p.read_bytes(), p
        except OSError:
            continue
    return None, None


def load_config(config_path: str | None = None) -> dict:
    parsed: dict = {}
    loaded_from = None
    if config_path:
        data, _ = _read_first(Path(config_path))
        if data is not None:
            parsed = tomllib.loads(data.decode("utf-8"))
            loaded_from = config_path
    else:
        legacy = Path.cwd() / "config.toml"
        data, which = _read_first(_config_path(), legacy)
        if data is not None:
            parsed = tomllib.loads(data.decode("utf-8"))
            loaded_from = str(which)

    if loaded_from:
        log.info("loaded config", {"path": loaded_from})
    elif not parsed:
        log.warn(
            "no config.toml found (checked XDG and cwd); using defaults",
            {"checked": f"{_config_path()},{Path.cwd() / 'config.toml'}"},
        )

    providers = dict(DEFAULTS["providers"])
    providers.update(parsed.get("providers") or {})

    cfg = {
        "port": parsed.get("port", DEFAULTS["port"]),
        "providers": providers,
        "control": parsed.get("control") or {},
        "logging": parsed.get("logging") or {},
    }

    # Resolve each provider's *_file secret into the inline field the plugin's
    # configure() reads. Missing file = leave unset -> provider reports
    # auth_expired until the secret exists.
    for name, pcfg in list(providers.items()):
        pcfg = dict(pcfg)
        if not pcfg.get("cookie") and pcfg.get("cookie_file"):
            v = _read_secret_file(pcfg["cookie_file"])
            if v is not None:
                pcfg["cookie"] = v
        if not pcfg.get("admin_key") and pcfg.get("admin_key_file"):
            v = _read_secret_file(pcfg["admin_key_file"])
            if v is not None:
                pcfg["admin_key"] = v
        for inline, file in (
            ("api_key", "api_key_file"),
            ("api_token", "api_token_file"),
            ("token", "token_file"),
        ):
            if not pcfg.get(inline) and pcfg.get(file):
                v = _read_secret_file(pcfg[file])
                if v is not None:
                    pcfg[inline] = v
        cfg["providers"][name] = pcfg
    return cfg


def _read_secret_file(p: str) -> str | None:
    try:
        return Path(expand_home(p)).read_text(encoding="utf-8").strip()
    except OSError:
        return None