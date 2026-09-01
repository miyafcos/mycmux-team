from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import mycmux_agent_cli as cli  # noqa: E402


def route(argv: list[str]) -> tuple[str, dict[str, Any]]:
    return cli.request_for(cli.build_parser().parse_args(argv))


def test_web_open_and_list_follow_the_socket_command_shapes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MYCMUX_PANE_SESSION_ID", "caller-session")
    assert route(["web-open"]) == (
        "web.open",
        {"presetId": "chatgpt", "anchorSessionId": "caller-session"},
    )
    assert route(
        ["web-open", "--preset", "other", "--anchor-session", "anchor", "--replace-anchor"]
    ) == (
        "web.open",
        {"presetId": "other", "anchorSessionId": "anchor", "replaceAnchor": True},
    )
    assert route(["web-list"]) == ("web.list", {})


def test_web_push_defaults_to_draft_and_passes_the_caller_workspace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MYCMUX_PANE_SESSION_ID", "caller-session")
    assert route(["web-push", "--text", "下書き"]) == (
        "web.push",
        {
            "submit": False,
            "text": "下書き",
            "presetId": "chatgpt",
            "anchorSessionId": "caller-session",
        },
    )
    assert route(["web-push", "--tab", "tab-1", "--text", "送信", "--send"]) == (
        "web.push",
        {"submit": True, "text": "送信", "tabId": "tab-1"},
    )


def test_web_push_reads_utf8_text_file_without_changing_special_characters(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The CLI fills anchorSessionId in from the pane it was called in, so a test
    # that does not pin this env var passes alone and fails inside mycmux.
    monkeypatch.delenv("MYCMUX_PANE_SESSION_ID", raising=False)
    text = '引用 "hello"\nC:\\作業\\brief.md\n</script>'
    text_path = tmp_path / "質問.txt"
    text_path.write_text(text, encoding="utf-8")

    assert route(["web-push", "--text-file", str(text_path), "--preset", "chatgpt"]) == (
        "web.push",
        {"submit": False, "text": text, "presetId": "chatgpt"},
    )


def test_web_push_rejects_ambiguous_text_and_target_arguments() -> None:
    parser = cli.build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["web-push", "--text", "a", "--text-file", "b.txt"])
    with pytest.raises(SystemExit):
        parser.parse_args(["web-push", "--tab", "tab", "--preset", "chatgpt", "--send"])
    with pytest.raises(RuntimeError, match="requires --text"):
        route(["web-push"])


def test_cli_opens_and_retries_only_for_the_no_matching_tab_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, dict[str, Any]]] = []

    def fake_send(command: str, args: dict[str, Any]) -> Any:
        calls.append((command, args))
        if len(calls) == 1:
            raise RuntimeError(cli.WEB_PUSH_NO_MATCH_ERROR)
        if command == "web.open":
            return {"tabId": "opened-tab"}
        if command == "web.focus":
            return {"tabId": "opened-tab", "workspaceId": "workspace"}
        return {"tabId": "opened-tab", "submitted": False}

    monkeypatch.setattr(cli, "send_request", fake_send)
    result = cli.send_web_push_with_open(
        {
            "presetId": "chatgpt",
            "anchorSessionId": "caller-session",
            "text": "draft",
            "submit": False,
        }
    )

    assert result == {"tabId": "opened-tab", "submitted": False}
    assert calls == [
        (
            "web.push",
            {
                "presetId": "chatgpt",
                "anchorSessionId": "caller-session",
                "text": "draft",
                "submit": False,
            },
        ),
        (
            "web.open",
            {"presetId": "chatgpt", "anchorSessionId": "caller-session"},
        ),
        (
            "web.focus",
            {"tabId": "opened-tab"},
        ),
        (
            "web.push",
            {"text": "draft", "submit": False, "tabId": "opened-tab"},
        ),
    ]


def test_cli_does_not_open_for_other_push_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def fake_send(command: str, _args: dict[str, Any]) -> Any:
        calls.append(command)
        raise RuntimeError("ChatGPT composer #prompt-textarea was not found")

    monkeypatch.setattr(cli, "send_request", fake_send)
    with pytest.raises(RuntimeError, match="composer"):
        cli.send_web_push_with_open({"presetId": "chatgpt", "text": "draft"})
    assert calls == ["web.push"]
