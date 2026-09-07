"""Pane lane (mycmux Web pane) against scripted web.* responses. No mycmux needed."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import oracmux
from oracmux_lib import cdp, engines, pane, pane_driver, paths

SITE = dict(engines.load(paths.engines_json())["gemini"])
SITE["timeouts"] = {"answer_appear_sec": 20, "stable_sec": 4, "min_wait_sec": 2, "overall_min": 1}


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        self.now += 1.0
        return self.now


class FakePane:
    """Scripted mycmux: one tab, answer appears N reads after the push."""

    def __init__(self, *, answer_after_reads: int = 2, answer: str = "ORACMUX-OK", signed_out: bool = False, sign_out_at_read: int | None = None, composer_after_reads: int = 0, last_role: str = "assistant"):
        self.answer_after_reads = answer_after_reads
        self.answer = answer
        self.signed_out = signed_out
        self.sign_out_at_read = sign_out_at_read
        self.composer_after_reads = composer_after_reads
        self.last_role = last_role
        self.reads = 0
        self.pushed: list[tuple[str, bool]] = []
        self.opened: list[dict] = []
        self.closed: list[str] = []
        self.sent = False
        self.tabs = [{"tabId": "tab-1", "presetId": "gemini", "url": "https://gemini.google.com/app", "title": "Gemini", "workspaceId": "w", "background": True, "active": False}]

    def install(self, monkeypatch) -> None:
        monkeypatch.setattr(pane, "web_open", self.web_open)
        monkeypatch.setattr(pane, "web_read", self.web_read)
        monkeypatch.setattr(pane, "web_push", self.web_push)
        monkeypatch.setattr(pane, "web_close", self.web_close)
        monkeypatch.setattr(pane, "web_list", lambda: list(self.tabs))
        monkeypatch.setattr(pane, "anchor_session", lambda: "caller")
        monkeypatch.setattr(pane_driver.time, "sleep", lambda _s: None)
        monkeypatch.setattr(pane_driver.time, "monotonic", Clock())

    def web_open(self, preset, *, url=None, background=True, anchor=None):
        self.opened.append({"preset": preset, "url": url, "background": background, "anchor": anchor})
        return {"tabId": "tab-1", "background": background}

    def web_push(self, *, preset, text_file, send=False, tab=None):
        self.pushed.append((str(text_file), send))
        self.sent = send
        return {"tabId": tab, "submitted": send, "textBytes": 10}

    def web_close(self, tab):
        self.closed.append(tab)
        return {"tabId": tab, "closed": True}

    def web_read(self, *, tab=None, preset=None):
        self.reads += 1
        if self.sign_out_at_read is not None and self.reads >= self.sign_out_at_read:
            self.signed_out = True
        turns = [{"role": "user", "text": "q"}]
        last = ""
        if self.sent and self.reads >= self.answer_after_reads:
            last = self.answer
            turns.append({"role": "assistant", "text": self.answer})
            if self.last_role == "user":
                turns.append({"role": "user", "text": "q2"})
        return {
            "tabId": tab or "tab-1",
            "presetId": "gemini",
            "url": "https://gemini.google.com/app/deadbeef01" if self.sent else "https://gemini.google.com/app",
            "signedOut": self.signed_out,
            "composerPresent": self.reads > self.composer_after_reads,
            "generating": bool(self.sent and self.reads < self.answer_after_reads + 1),
            "turns": turns,
            "lastAssistant": last,
            "lastAssistantLinks": ["https://example.com/ref"] if last else [],
            "chars": len(last),
            "truncated": False,
        }


def test_consult_opens_background_tab_pushes_and_harvests(monkeypatch, tmp_path):
    fake = FakePane()
    fake.install(monkeypatch)
    brief = tmp_path / "brief.md"
    brief.write_text("問い", encoding="utf-8")
    result = pane_driver.consult(SITE, brief, "問い", mode="current", out_dir=None, log=lambda _m: None)
    assert result.status == cdp.STATUS_OK
    assert result.answer == "ORACMUX-OK"
    assert result.conversation_url == "https://gemini.google.com/app/deadbeef01"
    assert fake.opened == [{"preset": "gemini", "url": None, "background": True, "anchor": "caller"}]
    assert fake.pushed == [(str(brief), True)]
    assert result.tab_kept_open and fake.closed == [] and result.tab_id == "tab-1"
    assert result.citations == ["https://example.com/ref"]
    assert result.turns[-1]["role"] == "assistant"


def test_consult_close_tab_and_mode_note(monkeypatch, tmp_path):
    fake = FakePane()
    fake.install(monkeypatch)
    brief = tmp_path / "brief.md"
    brief.write_text("問い", encoding="utf-8")
    result = pane_driver.consult(SITE, brief, "問い", mode="pro", out_dir=None, log=lambda _m: None, close_tab=True)
    assert result.status == cdp.STATUS_OK and fake.closed == ["tab-1"] and not result.tab_kept_open
    assert result.mode_actual == "current" and any("cannot switch modes" in item for item in result.trace)


def test_consult_signed_out_pane_is_needs_human_with_tab_kept(monkeypatch, tmp_path):
    fake = FakePane(signed_out=True)
    fake.install(monkeypatch)
    brief = tmp_path / "brief.md"
    brief.write_text("問い", encoding="utf-8")
    result = pane_driver.consult(SITE, brief, "問い", mode="current", out_dir=None, log=lambda _m: None)
    assert result.status == cdp.STATUS_NEEDS_HUMAN and result.exit_code == 3
    assert result.tab_kept_open and fake.pushed == []
    assert "signed out" in result.error


def test_consult_timeout_without_answer_is_timeout(monkeypatch, tmp_path):
    fake = FakePane(answer_after_reads=10_000)
    fake.install(monkeypatch)
    brief = tmp_path / "brief.md"
    brief.write_text("問い", encoding="utf-8")
    result = pane_driver.consult(SITE, brief, "問い", mode="current", out_dir=None, log=lambda _m: None)
    assert result.status == cdp.STATUS_TIMEOUT and result.exit_code == 2
    assert result.conversation_url.endswith("/deadbeef01")


def test_consult_reuses_a_given_tab(monkeypatch, tmp_path):
    fake = FakePane()
    fake.install(monkeypatch)
    brief = tmp_path / "brief.md"
    brief.write_text("問い", encoding="utf-8")
    result = pane_driver.consult(SITE, brief, "問い", mode="current", out_dir=None, log=lambda _m: None, tab_id="tab-9")
    assert result.status == cdp.STATUS_OK and fake.opened == [] and result.tab_id == "tab-9"


def test_collect_reads_latest_pane_and_waits_for_assistant_turn(monkeypatch):
    fake = FakePane(answer_after_reads=0)
    fake.sent = True
    fake.install(monkeypatch)
    result = pane_driver.collect(SITE, tab_id=None, url=None, log=lambda _m: None, stable_sec=3, overall_sec=120)
    assert result.status == cdp.STATUS_OK and result.answer == "ORACMUX-OK" and result.tab_id == "tab-1"
    fake2 = FakePane(answer_after_reads=0, last_role="user")
    fake2.sent = True
    fake2.install(monkeypatch)
    result2 = pane_driver.collect(SITE, tab_id="tab-1", url=None, log=lambda _m: None, stable_sec=3, overall_sec=20)
    assert result2.status == cdp.STATUS_PARTIAL and result2.detection == "timeout"


def test_collect_by_url_opens_background_tab_and_can_close_it(monkeypatch):
    fake = FakePane(answer_after_reads=0)
    fake.sent = True
    fake.install(monkeypatch)
    result = pane_driver.collect(SITE, tab_id=None, url="https://gemini.google.com/app/abc", log=lambda _m: None, stable_sec=3, overall_sec=120, close_tab=True)
    assert result.status == cdp.STATUS_OK
    assert fake.opened[0]["url"] == "https://gemini.google.com/app/abc" and fake.closed == ["tab-1"]


def test_collect_without_open_pane_is_needs_human(monkeypatch):
    fake = FakePane()
    fake.tabs = []
    fake.install(monkeypatch)
    result = pane_driver.collect(SITE, tab_id=None, url=None, log=lambda _m: None, stable_sec=3, overall_sec=20)
    assert result.status == cdp.STATUS_NEEDS_HUMAN and "no gemini pane is open" in result.error


def test_probe_statuses(monkeypatch):
    fake = FakePane(answer_after_reads=0)
    fake.install(monkeypatch)
    assert pane_driver.probe(SITE, lambda _m: None)["status"] == "ok"
    fake.signed_out = True
    assert pane_driver.probe(SITE, lambda _m: None)["status"] == "not_logged_in"
    fake.tabs = []
    assert pane_driver.probe(SITE, lambda _m: None)["status"] == "no_tab"
    monkeypatch.setattr(pane, "web_list", lambda: (_ for _ in ()).throw(pane.PaneUnavailable("socket request failed")))
    assert pane_driver.probe(SITE, lambda _m: None)["status"] == "mycmux_down"


def test_pane_commands_and_error_classification(tmp_path):
    cli = Path("C:/cli.py")
    assert pane.build_open_command("grok", url="https://grok.com/c/1", background=True, anchor="a", cli=cli)[2:] == ["web-open", "--preset", "grok", "--url", "https://grok.com/c/1", "--background", "--anchor-session", "a"]
    assert pane.build_read_command(tab="t", cli=cli)[2:] == ["web-read", "--tab", "t"]
    assert pane.build_read_command(preset="gemini", cli=cli)[2:] == ["web-read", "--preset", "gemini"]
    assert pane.build_close_command("t", cli=cli)[2:] == ["web-close", "--tab", "t"]
    assert pane.is_not_ready("web pane does not exist: t") and not pane.is_not_ready("boom")
    assert pane.is_no_match("web.read found no matching web tab in the target workspace")


def test_cli_defaults_to_the_pane_lane_and_guards_lane_flags(isolated_home, capsys, tmp_path):
    assert oracmux.main(["ask", "--engine", "chatgpt", "-q", "PING", "--dry-run", "--json"]) == oracmux.EXIT_OK
    payload = json.loads([line for line in capsys.readouterr().out.splitlines() if line.startswith("JSON ")][-1][5:])
    request = json.loads((Path(payload["run_dir"]) / "request.json").read_text(encoding="utf-8"))
    assert request["via"] == "pane"
    assert oracmux.main(["ask", "--engine", "gemini", "-q", "q", "--via", "cdp", "--tab", "t", "--dry-run"]) == oracmux.EXIT_PRECONDITION
    pdf = tmp_path / "a.pdf"
    pdf.write_bytes(b"%PDF")
    assert oracmux.main(["ask", "--engine", "chatgpt", "-q", "q", "--upload", str(pdf), "--dry-run"]) == oracmux.EXIT_PRECONDITION, "uploads need --via oracle"
    assert oracmux.main(["ask", "--engine", "chatgpt", "-q", "q", "--via", "oracle", "--upload", str(pdf), "--dry-run"]) == oracmux.EXIT_OK
    command = oracmux.lane_command("grok", tmp_path, "current", 5, False, via="pane", close_tab=True)
    assert command[command.index("--via") + 1] == "pane" and command[-1] == "--close-tab"
    assert "--close-tab" not in oracmux.lane_command("grok", tmp_path, "current", 5, False, via="cdp", close_tab=True)


def test_collect_cli_lane_rules(isolated_home, capsys):
    assert oracmux.main(["collect", "--engine", "gemini", "--latest", "--via", "pane"]) == oracmux.EXIT_PRECONDITION
    assert oracmux.main(["collect", "--engine", "gemini", "--tab", "t", "--via", "cdp"]) == oracmux.EXIT_PRECONDITION
