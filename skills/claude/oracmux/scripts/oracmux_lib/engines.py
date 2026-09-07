"""engines.json loader and contract validation.

The JSON is the single place UI selectors live. When a site changes its DOM,
edit the JSON; the driver and the tests read the contract from here.

Validation covers what the driver relies on at run time (audit F-39): every
selector list is non-empty, every regex compiles, selectors that are fed to
`document.querySelectorAll` in the page never use Playwright-only pseudo
classes, the CDP port is a real port, and every mode referenced exists.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from . import paths

ENGINE_IDS: tuple[str, ...] = ("chatgpt", "gemini", "grok")

REQUIRED_SELECTOR_LISTS: tuple[str, ...] = (
    "composer",
    "send",
    "generating",
    "assistant",
    "new_chat",
    "history",
    "login",
    "captcha",
)
OPTIONAL_STRING_LISTS: tuple[str, ...] = (
    "history_skip_aria",
    "limit_texts",
    "dismiss",
    "user_turns",
    "mode_label",
    "answer_strip_patterns",
)
REQUIRED_SCALARS: tuple[str, ...] = (
    "label",
    "url",
    "pane_preset",
    "conversation_url_pattern",
    "default_mode",
    "max_inline_chars",
)
REQUIRED_TIMEOUTS: tuple[str, ...] = (
    "answer_appear_sec",
    "stable_sec",
    "min_wait_sec",
    "overall_min",
)
# Selectors evaluated inside the page with querySelectorAll/matches must be
# standard CSS; Playwright-only pseudo classes silently match nothing there.
JS_EVALUATED_KEYS: tuple[str, ...] = ("assistant", "user_turns")
PLAYWRIGHT_ONLY = (":has-text(", ":text(", ":text-is(", ":visible", ":nth-match(", ">>")
KNOWN_PANE_PRESETS: tuple[str, ...] = ("chatgpt", "gemini", "grok", "claude", "notebooklm")


class EngineContractError(ValueError):
    pass


def _is_nonempty_str_list(value: Any) -> bool:
    return isinstance(value, list) and bool(value) and all(isinstance(item, str) and item.strip() for item in value)


def _is_str_list(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) and item.strip() for item in value)


def _check_regexes(engine_id: str, key: str, patterns: list[str]) -> None:
    for pattern in patterns:
        try:
            re.compile(pattern)
        except re.error as exc:
            raise EngineContractError(f"{engine_id}: {key} has an invalid regex {pattern!r}: {exc}") from exc


def validate(data: Any) -> None:
    if not isinstance(data, dict):
        raise EngineContractError("engines.json root must be an object")
    cdp = data.get("cdp")
    if not isinstance(cdp, dict) or not isinstance(cdp.get("host"), str) or not cdp["host"].strip():
        raise EngineContractError("engines.json needs cdp.host (str)")
    port = cdp.get("port")
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise EngineContractError("engines.json needs cdp.port in 1..65535")
    for engine_id in ENGINE_IDS:
        site = data.get(engine_id)
        if not isinstance(site, dict):
            raise EngineContractError(f"engine missing: {engine_id}")
        for key in REQUIRED_SCALARS:
            if key not in site:
                raise EngineContractError(f"{engine_id}: missing key {key}")
        for key in ("label", "url", "pane_preset", "conversation_url_pattern", "default_mode"):
            if not isinstance(site[key], str) or not site[key].strip():
                raise EngineContractError(f"{engine_id}: {key} must be a non-empty string")
        limit = site["max_inline_chars"]
        if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
            raise EngineContractError(f"{engine_id}: max_inline_chars must be a positive int")
        if not str(site["url"]).startswith("https://") or len(str(site["url"])) < len("https://x.y"):
            raise EngineContractError(f"{engine_id}: url must be https with a host")
        if site["pane_preset"] not in KNOWN_PANE_PRESETS:
            raise EngineContractError(f"{engine_id}: unknown pane_preset {site['pane_preset']}")
        _check_regexes(engine_id, "conversation_url_pattern", [str(site["conversation_url_pattern"])])
        for key in REQUIRED_SELECTOR_LISTS:
            if not _is_nonempty_str_list(site.get(key)):
                raise EngineContractError(f"{engine_id}: {key} must be a non-empty list of selectors")
        for key in OPTIONAL_STRING_LISTS:
            if key in site and not _is_str_list(site[key]):
                raise EngineContractError(f"{engine_id}: {key} must be a list of non-empty strings")
        if "answer_strip_patterns" in site:
            _check_regexes(engine_id, "answer_strip_patterns", list(site["answer_strip_patterns"]))
        for key in JS_EVALUATED_KEYS:
            for selector in site.get(key, []):
                if any(token in selector for token in PLAYWRIGHT_ONLY):
                    raise EngineContractError(f"{engine_id}: {key} selector {selector!r} uses Playwright-only syntax; it runs inside the page")
        modes = site.get("modes")
        if not isinstance(modes, dict) or not modes:
            raise EngineContractError(f"{engine_id}: modes must be a non-empty object")
        if site["default_mode"] not in modes:
            raise EngineContractError(f"{engine_id}: default_mode {site['default_mode']} not in modes")
        for mode_id, mode in modes.items():
            if not isinstance(mode, dict):
                raise EngineContractError(f"{engine_id}.{mode_id}: mode must be an object")
            steps = mode.get("steps", [])
            if not isinstance(steps, list) or not all(_is_nonempty_str_list(step) for step in steps):
                raise EngineContractError(f"{engine_id}.{mode_id}: steps must be a list of non-empty selector lists")
            for key in ("labels", "active"):
                if key in mode and not _is_nonempty_str_list(mode[key]):
                    raise EngineContractError(f"{engine_id}.{mode_id}: {key} must be a non-empty list of strings")
        timeouts = site.get("timeouts")
        if not isinstance(timeouts, dict):
            raise EngineContractError(f"{engine_id}: timeouts must be an object")
        for key in REQUIRED_TIMEOUTS:
            value = timeouts.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0 or value != value:
                raise EngineContractError(f"{engine_id}: timeouts.{key} must be a positive number")


def load(path: Path | None = None) -> dict[str, Any]:
    target = path or paths.engines_json()
    try:
        data = json.loads(target.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise EngineContractError(f"engines.json unreadable: {target}: {exc}") from exc
    validate(data)
    return data


def engine(data: dict[str, Any], engine_id: str) -> dict[str, Any]:
    if engine_id not in ENGINE_IDS:
        raise EngineContractError(f"unknown engine: {engine_id}")
    return data[engine_id]


def cdp_endpoint(data: dict[str, Any]) -> str:
    cdp = data["cdp"]
    return f"http://{cdp['host']}:{cdp['port']}"
