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


def test_cdp_alive_rejects_a_chrome_whose_debugger_socket_is_dead(monkeypatch):
    """2026-09-10: /json/version answered with Chrome 152 while the browser target
    it advertised was gone. oracle attached, got `Unexpected server response: 404`
    and died ~50s in. HTTP alone cannot see that; the handshake can."""
    monkeypatch.setattr(chrome, "cdp_version", lambda endpoint, timeout=5.0: (True, "Chrome/152.0", "ws://127.0.0.1:9222/devtools/browser/gone"))
    monkeypatch.setattr(chrome, "cdp_ws_alive", lambda ws, timeout=5.0: (False, "HTTP/1.1 404 Not Found"))
    alive, detail = chrome.cdp_alive("http://127.0.0.1:9222")
    assert alive is False
    assert "debugger socket is dead" in detail and "404" in detail


def test_cdp_alive_accepts_a_chrome_that_completes_the_handshake(monkeypatch):
    monkeypatch.setattr(chrome, "cdp_version", lambda endpoint, timeout=5.0: (True, "Chrome/152.0", "ws://127.0.0.1:9222/devtools/browser/ok"))
    monkeypatch.setattr(chrome, "cdp_ws_alive", lambda ws, timeout=5.0: (True, "HTTP/1.1 101 Switching Protocols"))
    assert chrome.cdp_alive("http://127.0.0.1:9222") == (True, "Chrome/152.0")


def test_ensure_up_explains_a_stale_target_instead_of_restarting_chrome(monkeypatch):
    """`oracle-chrome up` is a no-op while HTTP answers, so it cannot fix a stale
    target. Say so, and never restart: an oracle session may be mid-answer there."""
    monkeypatch.setattr(chrome, "cdp_alive", lambda endpoint, timeout=5.0: (False, "Chrome/152.0 answers HTTP but its debugger socket is dead (HTTP/1.1 404 Not Found)"))
    monkeypatch.setattr(chrome, "cdp_version", lambda endpoint, timeout=5.0: (True, "Chrome/152.0", "ws://x"))
    monkeypatch.setattr(chrome, "oracle_chrome", lambda action: (0, "oracle-chrome: already up"))
    with pytest.raises(RuntimeError) as excinfo:
        chrome.ensure_up("http://127.0.0.1:9222")
    message = str(excinfo.value)
    assert "oracle status" in message and "oracle-chrome down" in message and "--via pane" in message


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
