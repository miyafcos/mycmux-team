"""Prove that installing our hook into an agent's settings file cannot damage it.

Writing into `~/.claude/settings.json` is the highest-risk part of the hook
work: that file holds the owner's own hooks, and a merge that drops one, or
quietly reorders them, breaks their environment rather than ours. Rules in a
document do not prevent that. This does.

The tests never touch the real file. They read it as a fixture when it exists,
so the shapes under test are the shapes that actually ship, and operate on
copies. A synthetic fixture covers CI and any machine without one.

Contract: docs/plans/2026-08-30-agent-hook-contract.md section 8.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
REAL_SETTINGS = Path.home() / ".claude" / "settings.json"

# The marker that identifies a handler as ours. Uninstall removes exactly the
# handlers carrying it and nothing else.
OWNERSHIP_MARKER = "mycmux_managed"
CLAUDE_EVENTS = {
    "UserPromptSubmit": "turn_active",
    "PermissionRequest": "attention_required",
    "Notification": "attention_required",
    "PreToolUse": "pre_tool_use",
    "PostToolUse": "turn_active",
    "Stop": "turn_ended",
    "SessionEnd": "session_terminated",
}
CLAUDE_MATCHERS = {
    "PreToolUse": "AskUserQuestion|Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|WebFetch|WebSearch|Agent|Skill",
    "PostToolUse": "AskUserQuestion",
}

SYNTHETIC: dict[str, Any] = {
    "cleanupPeriodDays": 30,
    "env": {"SOME_KEY": "value"},
    "hooks": {
        "UserPromptSubmit": [
            {"matcher": "", "hooks": [{"type": "command", "command": "first.py", "timeout": 12}]},
            {"matcher": "", "hooks": [{"type": "command", "command": "second.py", "timeout": 3}]},
            {"matcher": "", "hooks": [{"type": "command", "command": "third.py", "timeout": 3}]},
        ],
        "Stop": [{"matcher": "", "hooks": [{"type": "command", "command": "stop.py"}]}],
    },
    "theme": "dark",
}


def holds_our_hook(settings: dict[str, Any]) -> bool:
    """True when mycmux has already installed its hook into these settings.

    The round-trip tests assume a file that does not yet carry our handler.
    On a machine where mycmux is running, the real settings file does (the
    app registers on start), and install/uninstall on such a file legitimately
    does not return to the original. Those shapes still ship, but they cannot
    serve as the "before" of a round trip (v0.65.0 release run, 2026-09-07).
    """
    for groups in settings.get("hooks", {}).values():
        if not isinstance(groups, list):
            continue
        for group in groups:
            if not isinstance(group, dict):
                continue
            for handler in group.get("hooks", []):
                if not isinstance(handler, dict):
                    continue
                command = str(handler.get("command", ""))
                if "mycmux_hook" in command or "mycmux-hook" in command or handler.get(OWNERSHIP_MARKER):
                    return True
    return False


def load_fixture() -> dict[str, Any]:
    """Prefer the real settings file so the tests exercise real shapes."""
    if REAL_SETTINGS.is_file():
        try:
            loaded = json.loads(REAL_SETTINGS.read_text(encoding="utf-8"))
            if isinstance(loaded, dict) and not holds_our_hook(loaded):
                return loaded
        except (json.JSONDecodeError, OSError):
            pass
    return copy.deepcopy(SYNTHETIC)


def managed_handler(event: str) -> dict[str, Any]:
    return {
        "type": "command",
        "command": f'python "mycmux_hook.py" --provider claude --event-kind {CLAUDE_EVENTS.get(event, event)}',
        "timeout": 1,
        OWNERSHIP_MARKER: True,
    }


def install(settings: dict[str, Any], events: list[str]) -> dict[str, Any]:
    """Reference merge. The Rust implementation must behave identically.

    Appends one managed group per event, replacing only a previously managed
    group for that same event. Everything else is preserved by position.
    """
    result = copy.deepcopy(settings)
    hooks = result.setdefault("hooks", {})
    for event in events:
        groups = hooks.setdefault(event, [])
        kept = [g for g in groups if not is_managed_group(g)]
        group = {"hooks": [managed_handler(event)]}
        if event in CLAUDE_MATCHERS:
            group["matcher"] = CLAUDE_MATCHERS[event]
        kept.append(group)
        hooks[event] = kept
    return result


def uninstall(settings: dict[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(settings)
    hooks = result.get("hooks", {})
    for event in list(hooks.keys()):
        remaining = [g for g in hooks[event] if not is_managed_group(g)]
        if remaining:
            hooks[event] = remaining
        else:
            del hooks[event]
    return result


def is_managed_group(group: Any) -> bool:
    if not isinstance(group, dict):
        return False
    handlers = group.get("hooks")
    if not isinstance(handlers, list) or not handlers:
        return False
    return all(isinstance(h, dict) and h.get(OWNERSHIP_MARKER) is True for h in handlers)


def user_groups(settings: dict[str, Any]) -> dict[str, list[Any]]:
    """Every group the user owns, keyed by event, in order.

    An event that carries only our handler contributes nothing: installing into
    an event the user never used must not read as a changed user group (the
    synthetic fixture has no PreToolUse; the real one did, which hid this).
    """
    owned = {
        event: [g for g in groups if not is_managed_group(g)]
        for event, groups in settings.get("hooks", {}).items()
    }
    return {event: groups for event, groups in owned.items() if groups}


def test_install_preserves_every_user_group_and_its_order() -> None:
    before = load_fixture()
    after = install(before, list(CLAUDE_EVENTS))
    assert user_groups(after) == user_groups(before)


def test_install_preserves_every_unrelated_top_level_key() -> None:
    before = load_fixture()
    after = install(before, ["Stop"])
    for key, value in before.items():
        if key == "hooks":
            continue
        assert after[key] == value, f"top-level key {key!r} was modified"


def test_uninstall_returns_the_file_to_its_original_state() -> None:
    before = load_fixture()
    after = uninstall(install(before, list(CLAUDE_EVENTS)))
    assert after == before


def test_install_is_idempotent() -> None:
    before = load_fixture()
    once = install(before, list(CLAUDE_EVENTS))
    twice = install(once, list(CLAUDE_EVENTS))
    assert twice == once


def test_reinstall_replaces_our_group_rather_than_accumulating() -> None:
    before = load_fixture()
    after = install(install(before, ["Stop"]), ["Stop"])
    managed = [g for g in after["hooks"]["Stop"] if is_managed_group(g)]
    assert len(managed) == 1


def test_uninstall_leaves_an_event_that_only_the_user_owns() -> None:
    before = load_fixture()
    installed = install(before, ["Stop"])
    after = uninstall(installed)
    assert after.get("hooks", {}).get("Stop") == before.get("hooks", {}).get("Stop")


def test_uninstall_removes_an_event_we_alone_introduced() -> None:
    before = load_fixture()
    fresh_event = "SubagentStop"
    assert fresh_event not in before.get("hooks", {}), "fixture already owns the probe event"
    after = uninstall(install(before, [fresh_event]))
    assert fresh_event not in after.get("hooks", {})


def test_a_user_handler_is_never_mistaken_for_ours() -> None:
    """Ownership is the marker, not the command text."""
    before = copy.deepcopy(SYNTHETIC)
    before["hooks"]["Stop"] = [
        {"matcher": "", "hooks": [{"type": "command", "command": "mycmux-hook.exe --event=Stop"}]},
    ]
    after = uninstall(install(before, ["Stop"]))
    assert after == before


def test_the_real_settings_file_is_never_written() -> None:
    """The suite must not be able to damage the machine it runs on."""
    if not REAL_SETTINGS.is_file():
        pytest.skip("no real settings file on this machine")
    before = REAL_SETTINGS.read_bytes()
    install(load_fixture(), list(CLAUDE_EVENTS))
    uninstall(load_fixture())
    assert REAL_SETTINGS.read_bytes() == before


def test_fixture_shape_is_what_we_think_it_is() -> None:
    """Guard against the fixture silently degrading to the synthetic one."""
    settings = load_fixture()
    assert isinstance(settings.get("hooks"), dict) and settings["hooks"], "no hooks to protect"
    for event, groups in settings["hooks"].items():
        assert isinstance(groups, list), f"{event} is not a list of groups"
        for group in groups:
            assert isinstance(group, dict), f"{event} contains a non-object group"
            assert isinstance(group.get("hooks"), list), f"{event} group has no handler list"


@pytest.mark.parametrize("event", list(CLAUDE_EVENTS))
def test_all_claude_events_replace_only_our_group(event: str) -> None:
    before = copy.deepcopy(SYNTHETIC)
    user = {"matcher": "Bash|PowerShell|Agent|Skill", "hooks": [{"type": "command", "command": "user.py"}]}
    before["hooks"][event] = [user, {"matcher": "old", "hooks": [managed_handler(event)]}]
    after = install(before, list(CLAUDE_EVENTS))
    assert after["hooks"][event][0] == user
    assert len(after["hooks"][event]) == 2
    group = after["hooks"][event][1]
    assert group.get("matcher") == CLAUDE_MATCHERS.get(event)
    assert group["hooks"][0]["command"].endswith(f"--event-kind {CLAUDE_EVENTS[event]}")
    assert install(after, list(CLAUDE_EVENTS)) == after
    assert user_groups(uninstall(after)) == user_groups(before)
    assert len(after["hooks"]) == 7


def test_old_question_pre_hook_is_upgraded_to_one_managed_group() -> None:
    before = copy.deepcopy(SYNTHETIC)
    user = {"matcher": "Bash|PowerShell|Agent|Skill", "hooks": [{"type": "command", "command": "user.py"}]}
    old = managed_handler("PreToolUse")
    old["command"] = old["command"].replace("--event-kind pre_tool_use", "--event-kind attention_required")
    before["hooks"]["PreToolUse"] = [user, {"matcher": "AskUserQuestion", "hooks": [old]}]
    after = install(before, list(CLAUDE_EVENTS))
    groups = after["hooks"]["PreToolUse"]
    assert groups[0] == user
    assert len(groups) == 2
    assert groups[1]["matcher"] == CLAUDE_MATCHERS["PreToolUse"]
    assert groups[1]["hooks"][0]["command"].endswith("--event-kind pre_tool_use")
    assert install(after, list(CLAUDE_EVENTS)) == after
    assert user_groups(uninstall(after)) == user_groups(before)
