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
            {"presetId": "chatgpt", "anchorSessionId": "caller-session", "background": True},
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


def test_web_open_url_and_background(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MYCMUX_PANE_SESSION_ID", "caller")
    assert route(["web-open", "--url", "https://chatgpt.com/c/abc", "--background"]) == (
        "web.open",
        {"presetId": "chatgpt", "anchorSessionId": "caller",
         "url": "https://chatgpt.com/c/abc", "background": True},
    )


def test_web_read_and_close_routes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MYCMUX_PANE_SESSION_ID", "caller")
    assert route(["web-read", "--tab", "chat"]) == ("web.read", {"tabId": "chat"})
    assert route(["web-read", "--preset", "grok"]) == (
        "web.read", {"presetId": "grok", "anchorSessionId": "caller"},
    )
    assert route(["web-read"]) == (
        "web.read", {"presetId": "chatgpt", "anchorSessionId": "caller"},
    )
    assert route(["web-close", "--tab", "chat"]) == ("web.close", {"tabId": "chat"})
    with pytest.raises(SystemExit):
        route(["web-read", "--tab", "chat", "--preset", "grok"])
    with pytest.raises(SystemExit):
        route(["web-close"])


@pytest.mark.parametrize(
    ("argv", "command", "fields"),
    [
        (["web-navigate", "--url", "https://example.com/"], "navigate", {"url": "https://example.com/"}),
        (["web-navigate", "--back"], "navigate", {"action": "back"}),
        (["web-navigate", "--forward"], "navigate", {"action": "forward"}),
        (["web-navigate", "--reload"], "navigate", {"action": "reload"}),
        (["web-wait", "--state", "selector", "--selector", "#ready", "--timeout-ms", "20"], "wait", {"state": "selector", "selector": "#ready", "timeoutMs": 20}),
        (["web-eval", "--script", "return 42", "--timeout-ms", "500"], "eval", {"script": "return 42", "timeoutMs": 500}),
        (["web-snapshot", "--mode", "text", "--max-bytes", "4096"], "snapshot", {"mode": "text", "maxBytes": 4096}),
        (["web-find", "--text", "Count", "--role", "button", "--selector", "#counter", "--exact", "--limit", "2"], "find", {"text": "Count", "role": "button", "selector": "#counter", "exact": True, "limit": 2}),
        (["web-click", "--x", "1", "--y", "2", "--button", "right", "--click-count", "2", "--trusted"], "click", {"x": 1.0, "y": 2.0, "button": "right", "clickCount": 2, "trusted": True}),
        (["web-click", "--ref", "r1"], "click", {"ref": "r1", "trusted": False}),
        (["web-type", "--selector", "#input", "--text", "", "--append", "--submit", "--trusted"], "type", {"selector": "#input", "text": "", "mode": "append", "submit": True, "trusted": True}),
        (["web-key", "--key", "A", "--code", "KeyA", "--ref", "r1", "--mod", "ctrl,shift,alt,meta", "--trusted"], "key", {"key": "A", "code": "KeyA", "ref": "r1", "modifiers": ["ctrl", "shift", "alt", "meta"], "trusted": True}),
        (["web-scroll", "--selector", "#scroll", "--delta-x", "5", "--delta-y", "-40"], "scroll", {"selector": "#scroll", "deltaX": 5.0, "deltaY": -40.0}),
        (["web-downloads"], "downloads", {}),
        (["web-dialogs", "--clear"], "dialogs", {"clear": True}),
    ],
)
def test_automation_routes_all_fields(argv: list[str], command: str, fields: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MYCMUX_PANE_SESSION_ID", "caller")
    assert route([*argv, "--tab", "tab"]) == ("web." + command, {"tabId": "tab", **fields})
    assert route([*argv, "--preset", "browser"]) == (
        "web." + command, {"presetId": "browser", "anchorSessionId": "caller", **fields}
    )
    assert route(argv) == ("web." + command, {"presetId": "chatgpt", "anchorSessionId": "caller", **fields})


def test_automation_reads_utf8_sources_and_resolves_upload_and_screenshot_paths(tmp_path: Path) -> None:
    source = tmp_path / "source.txt"
    text = "quote ' </script>\n\u65e5\u672c\u8a9e \U0001f600"
    source.write_text(text, encoding="utf-8")
    assert route(["web-eval", "--tab", "tab", "--script-file", str(source)])[1]["script"] == text
    assert route(["web-type", "--tab", "tab", "--ref", "r1", "--text-file", str(source)])[1]["text"] == text
    for mode in ([], ["--drop"], ["--trusted"]):
        cmd, args = route(["web-upload", "--tab", "tab", "--selector", "#file", "--file", str(source), "--file", str(source), *mode])
        assert cmd == "web.upload"
        assert args == {
            "tabId": "tab", "selector": "#file", "paths": [str(source.resolve())] * 2,
            "mode": "drop" if "--drop" in mode else "input", "trusted": "--trusted" in mode,
        }
    assert route(["web-screenshot", "--tab", "tab", "--out", str(source)])[1] == {"tabId": "tab", "path": str(source.resolve())}
    assert route(["web-open", "--preset", "browser", "--background"])[1]["presetId"] == "browser"


@pytest.mark.parametrize("argv", [
    ["web-navigate"], ["web-navigate", "--url", "a", "--back"],
    ["web-eval"], ["web-eval", "--script", "x", "--script-file", "a"],
    ["web-click"], ["web-click", "--ref", "r1", "--selector", "#x"],
    ["web-type", "--ref", "r1"], ["web-type", "--ref", "r1", "--text", "x", "--text-file", "a"],
    ["web-key"], ["web-upload", "--ref", "r1"], ["web-upload", "--file", "a"],
    ["web-scroll", "--ref", "r1", "--selector", "#x"],
    ["web-downloads", "--tab", "x", "--preset", "browser"],
])
def test_automation_parser_rejects_missing_and_exclusive_arguments(argv: list[str]) -> None:
    with pytest.raises(SystemExit):
        route(argv)


@pytest.mark.parametrize("argv", [
    ["web-click", "--x", "1"], ["web-click", "--ref", "r1", "--y", "2"],
    ["web-wait", "--state", "selector"], ["web-wait", "--selector", "#x"],
    ["web-find"], ["web-key", "--key", "a", "--mod", "ctrl,bad"],
    ["web-upload", "--ref", "r1", "--file", "a", "--drop", "--trusted"],
])
def test_automation_rejects_incomplete_or_incompatible_options(argv: list[str]) -> None:
    with pytest.raises(RuntimeError):
        route(argv)


@pytest.mark.parametrize("command", ["web-wait", "web-eval"])
def test_timeout_respects_socket_deadline(command: str) -> None:
    argv = [command, "--tab", "tab"] + (["--script", "return 1"] if command == "web-eval" else [])
    assert route([*argv, "--timeout-ms", "25000"])[1]["timeoutMs"] == 25000
    with pytest.raises(RuntimeError, match="timeoutMs must be <= 25000"):
        route([*argv, "--timeout-ms", "25001"])
    with pytest.raises(RuntimeError, match="must be nonnegative"):
        route([*argv, "--timeout-ms", "-1"])


@pytest.mark.parametrize("count", [0, 4, -1])
def test_click_count_rejects_outside_native_range(count: int) -> None:
    with pytest.raises(RuntimeError, match="clickCount must be between 1 and 3"):
        route(["web-click", "--tab", "tab", "--ref", "r1", "--click-count", str(count)])


@pytest.mark.parametrize("count", [1, 3])
def test_click_count_accepts_supported_boundaries(count: int) -> None:
    assert route(["web-click", "--tab", "tab", "--ref", "r1", "--click-count", str(count)])[1]["clickCount"] == count


def test_eval_script_limit_counts_utf8_bytes(tmp_path: Path) -> None:
    boundary = "\U0001f600" * 65536
    source = tmp_path / "script.js"
    source.write_text(boundary, encoding="utf-8")
    assert route(["web-eval", "--script-file", str(source)])[1]["script"] == boundary
    source.write_text(boundary + "x", encoding="utf-8")
    for options in (["--script-file", str(source)], ["--script", boundary + "x"]):
        with pytest.raises(RuntimeError, match="web.eval script exceeds 256 KB"):
            route(["web-eval", *options])


def test_snapshot_minimum_is_4096_bytes() -> None:
    with pytest.raises(RuntimeError, match="maxBytes must be between 4096 and 524288"):
        route(["web-snapshot", "--max-bytes", "4095"])
    assert route(["web-snapshot", "--max-bytes", "4096"])[1]["maxBytes"] == 4096


@pytest.mark.parametrize("command", ["web-close", "web-focus"])
def test_close_and_focus_require_tab_and_reject_preset(command: str) -> None:
    assert route([command, "--tab", "tab"])[1] == {"tabId": "tab"}
    with pytest.raises(SystemExit):
        route([command, "--preset", "browser"])
