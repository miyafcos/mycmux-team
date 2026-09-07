"""oracle_cli / pane / cdp pure parts / chrome session scan — no browser, no network."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from oracmux_lib import cdp, chrome, oracle_cli, pane, paths


def test_oracle_command_shape_inline_vs_uploads(tmp_path):
    brief_path = tmp_path / "brief.md"
    out = tmp_path / "answer.raw.md"
    command = oracle_cli.build_command(brief_path, out, "oracmux-demo", node="node", cli_js=Path("C:/x/oracle-cli.js"))
    assert command[:4] == ["node", str(Path("C:/x/oracle-cli.js")), "--engine", "browser"]
    assert command[command.index("-p") + 1] == oracle_cli.INSTRUCTION
    assert command[command.index("-f") + 1] == str(brief_path)
    assert command[command.index("--browser-attachments") + 1] == "never"
    assert "--browser-research" not in command
    assert command[command.index("--slug") + 1] == "oracmux-demo"
    assert command[command.index("--timeout") + 1] == "auto"
    with_uploads = oracle_cli.build_command(brief_path, out, "s", uploads=[tmp_path / "a.pdf"], research=True, node="node", cli_js=Path("j"))
    assert with_uploads[with_uploads.index("--browser-attachments") + 1] == "always"
    assert with_uploads.count("-f") == 2
    assert with_uploads[with_uploads.index("--browser-research") + 1] == "deep"


def test_oracle_output_parsing():
    stdout = "…\nReattach: oracle session oracmux-260907-demo\nModel selection evidence: requestedKey=gpt-5.6-sol; status=already-selected\nopen https://chatgpt.com/c/6a61ed23-1bb4-83e8-92a4-93c05ead4953 later\n"
    info = oracle_cli.parse_output(stdout)
    assert info["session_slug"] == "oracmux-260907-demo"
    assert info["evidence"].startswith("requestedKey=gpt-5.6-sol")
    assert info["conversation_url"] == "https://chatgpt.com/c/6a61ed23-1bb4-83e8-92a4-93c05ead4953"
    assert oracle_cli.parse_output("") == {"session_slug": "", "evidence": "", "conversation_url": ""}


def test_session_conversation_url_reads_meta(isolated_home):
    sessions = paths.oracle_sessions_dir()
    (sessions / "s1").mkdir()
    (sessions / "s1" / "meta.json").write_text(
        json.dumps({"browser": {"runtime": {"tabUrl": "https://chatgpt.com/"}, "harvest": {"url": "https://chatgpt.com/c/abc-123?x=1"}}}),
        encoding="utf-8",
    )
    assert oracle_cli.session_conversation_url("s1") == "https://chatgpt.com/c/abc-123"
    assert oracle_cli.session_conversation_url("missing") == ""


def test_running_sessions_distinguish_alive_from_zombie(isolated_home, monkeypatch):
    sessions = paths.oracle_sessions_dir()
    now = datetime(2026, 9, 7, 4, 0, tzinfo=timezone.utc)
    for name, pid, created in (("live", 4242, "2026-09-07T03:30:00.000Z"), ("dead", 9999, "2026-09-07T03:40:00.000Z"), ("old", 4242, "2026-09-01T00:00:00.000Z")):
        (sessions / name).mkdir()
        (sessions / name / "meta.json").write_text(
            json.dumps({"id": name, "status": "running", "createdAt": created, "browser": {"runtime": {"controllerPid": pid}}}),
            encoding="utf-8",
        )
    (sessions / "done").mkdir()
    (sessions / "done" / "meta.json").write_text(json.dumps({"id": "done", "status": "completed", "createdAt": "2026-09-07T03:50:00.000Z"}), encoding="utf-8")
    monkeypatch.setattr(chrome, "_pid_alive", lambda pid: pid == 4242)
    found = {item["id"]: item for item in chrome.running_oracle_sessions(hours=6, now=now)}
    assert set(found) == {"live", "dead"}
    assert found["live"]["alive"] and not found["live"]["zombie"]
    assert found["dead"]["zombie"]


def test_push_command_and_size_guard(tmp_path, isolated_home):
    text_file = tmp_path / "brief.md"
    command = pane.build_push_command("gemini", text_file, send=False, cli=Path("C:/cli.py"))
    assert command[1:] == [str(Path("C:/cli.py")), "web-push", "--text-file", str(text_file), "--preset", "gemini"]
    command = pane.build_push_command("gemini", text_file, send=True, tab="tab-1", cli=Path("C:/cli.py"))
    assert command[-3:] == ["--tab", "tab-1", "--send"] and "--preset" not in command
    assert pane.check_text_size("abc") == 3
    with pytest.raises(ValueError):
        pane.check_text_size("x" * (pane.MAX_TEXT_BYTES + 1))
    with pytest.raises(RuntimeError):
        pane.push("gemini", text_file)  # MYCMUX_TERM_PROGRAM unset in isolated_home


def test_pick_latest_history_skips_landing_pinned_and_anchors():
    entries = [
        {"href": "/", "aria": "Home"},
        {"href": "#grok-content-area", "aria": ""},
        {"href": "/app", "aria": "チャットを新規作成"},
        {"href": "/c/pinned-1", "aria": "題名, pinned conversation"},
        {"href": "/c/latest-1", "aria": "最新"},
        {"href": "/c/older", "aria": ""},
    ]
    assert cdp.pick_latest_history(entries, ["pinned"])["href"] == "/c/latest-1"
    assert cdp.pick_latest_history(entries[:4], ["pinned"]) is None
    assert cdp.pick_latest_history([], []) is None


def test_result_exit_codes():
    assert cdp.Result(status=cdp.STATUS_OK).exit_code == 0
    assert cdp.Result(status=cdp.STATUS_PARTIAL).exit_code == 2
    assert cdp.Result(status=cdp.STATUS_NEEDS_HUMAN).exit_code == 3
    assert cdp.Result(status=cdp.STATUS_FAILED).exit_code == 4


def test_clean_answer_strips_only_leading_caption_lines():
    patterns = ["Gemini の回答", "Worked for .*"]
    assert cdp.clean_answer("Gemini の回答\n\nORACMUX-OK", patterns) == "ORACMUX-OK"
    assert cdp.clean_answer("Worked for 1s\n\nA\nWorked for 2s\nB", patterns) == "A\nWorked for 2s\nB"
    assert cdp.clean_answer("\n\nplain", []) == "plain"
    assert cdp.clean_answer("", patterns) == ""
