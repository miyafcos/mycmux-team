"""Contract: `spawn` defaults to a same-pane tab and splits only on request.

commit 57b4da3 routed the CLI `spawn` subcommand: with the caller's pane
session id (MYCMUX_PANE_SESSION_ID) and no placement options it must become
a `pane.spawn_tab` request anchored to that pane; any explicit placement
option (--split / --workspace / --anchor-pane / --direction) or a missing
env falls back to `pane.spawn`.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import mycmux_agent_cli as cli  # noqa: E402

PANE_SESSION_ID = "11112222-3333-4444-5555-666677778888"


def request_for_spawn(argv: list[str]) -> tuple[str, dict[str, Any]]:
    namespace = cli.build_parser().parse_args(["spawn", *argv])
    return cli.request_for(namespace)


def request_for_spawn_tab(argv: list[str]) -> tuple[str, dict[str, Any]]:
    namespace = cli.build_parser().parse_args(
        ["spawn-tab", "--anchor-session", PANE_SESSION_ID, *argv]
    )
    return cli.request_for(namespace)


def request_for_panes(argv: list[str]) -> tuple[str, dict[str, Any]]:
    namespace = cli.build_parser().parse_args(["panes", *argv])
    return cli.request_for(namespace)


def request_for_move(argv: list[str]) -> tuple[str, dict[str, Any]]:
    namespace = cli.build_parser().parse_args(["move", *argv])
    return cli.request_for(namespace)


def request_for_rename(argv: list[str]) -> tuple[str, dict[str, Any]]:
    namespace = cli.build_parser().parse_args(["rename", *argv])
    return cli.request_for(namespace)


def request_for_send(argv: list[str]) -> tuple[str, dict[str, Any]]:
    namespace = cli.build_parser().parse_args(["send", *argv])
    return cli.request_for(namespace)


def request_for_activate_tab(argv: list[str]) -> tuple[str, dict[str, Any]]:
    namespace = cli.build_parser().parse_args(["activate-tab", *argv])
    return cli.request_for(namespace)


def request_for_restore_activation(argv: list[str]) -> tuple[str, dict[str, Any]]:
    namespace = cli.build_parser().parse_args(["restore-activation", *argv])
    return cli.request_for(namespace)


def test_panes_keeps_existing_default_route() -> None:
    assert request_for_panes([]) == ("pane.list", {})


def test_send_without_expectations_preserves_existing_args() -> None:
    assert request_for_send(
        ["--session", PANE_SESSION_ID, "--text", "yes", "--enter"]
    ) == (
        "pane.send_text",
        {"sessionId": PANE_SESSION_ID, "text": "yes", "enter": True},
    )


def test_send_expectation_flags_are_additive() -> None:
    assert request_for_send(
        [
            "--session",
            PANE_SESSION_ID,
            "--text",
            "yes",
            "--expect-epoch",
            "7",
            "--expect-attention-id",
            "attention-a",
            "--expect-revision",
            "11",
        ]
    ) == (
        "pane.send_text",
        {
            "sessionId": PANE_SESSION_ID,
            "text": "yes",
            "enter": False,
            "expectedSessionEpoch": 7,
            "expectedAttentionId": "attention-a",
            "expectedSessionRevision": 11,
        },
    )


def test_send_key_routes_semantic_key_after_text() -> None:
    assert request_for_send(
        ["--session", PANE_SESSION_ID, "--text", "yes", "--key", "up"]
    ) == (
        "pane.send_text",
        {"sessionId": PANE_SESSION_ID, "text": "yes", "enter": False, "key": "up"},
    )


def test_send_key_can_be_used_without_text() -> None:
    assert request_for_send(["--session", PANE_SESSION_ID, "--key", "enter"]) == (
        "pane.send_text",
        {"sessionId": PANE_SESSION_ID, "text": "", "enter": False, "key": "enter"},
    )


def test_panes_keeps_existing_workspace_route() -> None:
    assert request_for_panes(["--workspace", "workspace-1"]) == (
        "pane.list",
        {"workspaceId": "workspace-1"},
    )


def test_panes_all_routes_to_cross_workspace_command() -> None:
    assert request_for_panes(["--all"]) == ("pane.list_all", {})


def test_panes_rejects_workspace_with_all() -> None:
    with pytest.raises(SystemExit):
        cli.build_parser().parse_args(
            ["panes", "--workspace", "workspace-1", "--all"]
        )


def test_move_routes_session_and_zero_based_position() -> None:
    assert request_for_move(
        ["--session", PANE_SESSION_ID, "--column", "2", "--row", "3"]
    ) == (
        "pane.move",
        {"sessionId": PANE_SESSION_ID, "toColumn": 2, "toRow": 3},
    )


def test_rename_routes_label_and_preserves_empty_reset() -> None:
    assert request_for_rename(
        ["--session", PANE_SESSION_ID, "--label", "人が読める名前"]
    ) == (
        "pane.rename_tab",
        {"sessionId": PANE_SESSION_ID, "label": "人が読める名前"},
    )
    assert request_for_rename(
        ["--session", PANE_SESSION_ID, "--label", ""]
    ) == (
        "pane.rename_tab",
        {"sessionId": PANE_SESSION_ID, "label": ""},
    )


def test_activate_tab_routes_session_id() -> None:
    assert request_for_activate_tab(["--session", PANE_SESSION_ID]) == (
        "pane.activate_tab",
        {"sessionId": PANE_SESSION_ID},
    )


def test_restore_activation_routes_token_object_unchanged() -> None:
    token = {
        "previous_session_id": "previous",
        "target_session_id": "target",
        "focus_revision": 7,
        "previous_session_identity": {
            "server_epoch": "server",
            "session_epoch": 11,
            "pane_id": "pane-a",
            "tab_id": "tab-a",
        },
        "target_session_identity": {
            "server_epoch": "server",
            "session_epoch": 12,
            "pane_id": "pane-b",
            "tab_id": "tab-b",
        },
    }
    assert request_for_restore_activation(
        ["--token", json.dumps(token)]
    ) == ("pane.restore_activation", token)


@pytest.mark.parametrize("value", ["[]", '"token"', "not-json"])
def test_restore_activation_rejects_non_object_token(value: str) -> None:
    with pytest.raises(SystemExit):
        cli.build_parser().parse_args(
            ["restore-activation", "--token", value]
        )


def test_env_and_no_placement_options_routes_to_same_pane_tab(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MYCMUX_PANE_SESSION_ID", PANE_SESSION_ID)
    cmd, args = request_for_spawn(["--target", "codex"])
    assert cmd == "pane.spawn_tab"
    assert args["anchorSessionId"] == PANE_SESSION_ID
    assert args["target"] == "codex"
    assert args["activate"] is False


def test_activate_flag_focuses_same_pane_tab(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MYCMUX_PANE_SESSION_ID", PANE_SESSION_ID)
    cmd, args = request_for_spawn(["--target", "codex", "--activate"])
    assert cmd == "pane.spawn_tab"
    assert args["activate"] is True


def test_split_flag_forces_split_pane(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MYCMUX_PANE_SESSION_ID", PANE_SESSION_ID)
    cmd, args = request_for_spawn(["--target", "claude", "--split"])
    assert cmd == "pane.spawn"
    assert args["activate"] is False


def test_split_activate_explicitly_switches_focus(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MYCMUX_PANE_SESSION_ID", PANE_SESSION_ID)
    cmd, args = request_for_spawn(["--target", "claude", "--split", "--activate"])
    assert cmd == "pane.spawn"
    assert args["activate"] is True


def test_split_reports_the_caller_pane_so_it_lands_next_to_the_caller(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Without this the frontend falls back to the operator's active workspace,
    so an agent in a background workspace splits the pane they are working in."""
    monkeypatch.setenv("MYCMUX_PANE_SESSION_ID", PANE_SESSION_ID)
    _, args = request_for_spawn(["--target", "claude", "--split"])
    assert args["anchorSessionId"] == PANE_SESSION_ID


def test_split_from_outside_a_pane_omits_the_caller_pane(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("MYCMUX_PANE_SESSION_ID", raising=False)
    _, args = request_for_spawn(["--target", "claude", "--split"])
    assert "anchorSessionId" not in args


def test_split_no_activate_remains_supported(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MYCMUX_PANE_SESSION_ID", PANE_SESSION_ID)
    cmd, args = request_for_spawn(
        ["--target", "claude", "--split", "--no-activate"]
    )
    assert cmd == "pane.spawn"
    assert args["activate"] is False


def test_direction_forces_split_pane(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MYCMUX_PANE_SESSION_ID", PANE_SESSION_ID)
    cmd, args = request_for_spawn(["--target", "claude", "--direction", "down"])
    assert cmd == "pane.spawn"
    assert args["direction"] == "down"


def test_anchor_pane_forces_split_pane(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MYCMUX_PANE_SESSION_ID", PANE_SESSION_ID)
    cmd, args = request_for_spawn(["--target", "claude", "--anchor-pane", "pane-42"])
    assert cmd == "pane.spawn"
    assert args["anchorPaneId"] == "pane-42"


def test_missing_env_falls_back_to_split_pane(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("MYCMUX_PANE_SESSION_ID", raising=False)
    cmd, _ = request_for_spawn(["--target", "claude"])
    assert cmd == "pane.spawn"


def test_prompt_writes_prompt_file_and_records_from_session(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MYCMUX_PANE_SESSION_ID", PANE_SESSION_ID)
    monkeypatch.setenv("MYCMUX_RUNTIME_DIR", str(tmp_path))
    cmd, args = request_for_spawn(["--target", "claude", "--prompt", "続きを頼む"])
    assert cmd == "pane.spawn_tab"
    prompt_file = Path(args["promptFile"])
    assert prompt_file.parent == (tmp_path / "agent-prompts").resolve()
    assert prompt_file.read_text(encoding="utf-8") == "続きを頼む"
    assert args["fromSessionId"] == PANE_SESSION_ID


def test_spawn_tab_defaults_to_background() -> None:
    cmd, args = request_for_spawn_tab(["--target", "codex"])
    assert cmd == "pane.spawn_tab"
    assert args["activate"] is False


def test_spawn_tab_activate_flag_switches_focus() -> None:
    cmd, args = request_for_spawn_tab(["--activate", "--", "cmd.exe", "/c", "echo ok"])
    assert cmd == "pane.spawn_tab"
    assert args["commandArgv"] == ["cmd.exe", "/c", "echo ok"]
    assert args["activate"] is True


def test_spawn_tab_no_activate_remains_supported() -> None:
    cmd, args = request_for_spawn_tab(["--no-activate", "--target", "claude"])
    assert cmd == "pane.spawn_tab"
    assert args["activate"] is False


def test_spawn_tab_detach_routes_to_a_new_pane(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MYCMUX_PANE_SESSION_ID", PANE_SESSION_ID)
    namespace = cli.build_parser().parse_args(["spawn-tab", "--detach", "--target", "codex"])
    cmd, args = cli.request_for(namespace)
    assert cmd == "pane.spawn"
    assert args["anchorSessionId"] == PANE_SESSION_ID
    assert args["target"] == "codex"


def test_spawn_tab_detach_rejects_explicit_anchor() -> None:
    namespace = cli.build_parser().parse_args([
        "spawn-tab", "--detach", "--anchor-session", PANE_SESSION_ID, "--target", "codex",
    ])
    with pytest.raises(RuntimeError, match="cannot be used with --anchor-session"):
        cli.request_for(namespace)
