"""Pane lane (mycmux Web pane) against scripted web.* responses. No mycmux needed."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import oracmux
from oracmux_lib import cdp, engines, pane, pane_driver, paths
from oracmux_lib.pane_driver import _values

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
        # Upload surface: a service either mounts its file input at load
        # (chatgpt / grok) or only after the opener is clicked (gemini).
        self.input_mounted = True
        self.opener_mounts: tuple[str, ...] = ()
        self.evals: list[str] = []
        self.clicked: list[str] = []
        self.uploaded: list[tuple[str, list[str]]] = []
        self.uploaded_names: list[str] = []
        self.accept_probes = 0
        self.accept_after_probes = 1
        # Submit confirmation: a service that swallowed the send leaves the brief
        # sitting in the composer (ChatGPT during an attachment upload, 2026-09-09).
        self.composer_text = ""
        self.clears_composer_on_click = True

    def install_upload(self, monkeypatch) -> None:
        monkeypatch.setattr(pane, "web_eval", self.web_eval)
        monkeypatch.setattr(pane, "web_click", self.web_click)
        monkeypatch.setattr(pane, "web_upload", self.web_upload)
        monkeypatch.setattr(pane, "check_upload_size", lambda files: 1)

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

    # --- upload surface (see install_upload) -------------------------------
    def web_eval(self, tab, script):
        """Answers the three scripts the driver runs: count inputs, check upload
        acceptance, read the composer."""
        self.evals.append(script)
        if "const groups" in script:
            raise AssertionError("FakePane.web_eval has no groups answer; use a selftest fake")
        if "querySelectorAll" in script:
            return 1 if self.input_mounted else 0
        if "el.value" in script:
            return {"found": True, "text": self.composer_text}
        self.accept_probes += 1
        shown = self.uploaded_names if self.accept_probes >= self.accept_after_probes else []
        return {"held": len(self.uploaded_names), "shown": shown}

    def web_click(self, tab, selector):
        self.clicked.append(selector)
        if selector in self.opener_mounts:
            self.input_mounted = True
        if selector in _values(SITE, "send") and self.clears_composer_on_click:
            self.composer_text = ""
        return {"tabId": tab, "selector": selector}

    def web_upload(self, tab, selector, files):
        if not self.input_mounted:
            raise pane.PaneError("target was not found")
        self.uploaded.append((selector, [Path(f).name for f in files]))
        self.uploaded_names = [Path(f).name for f in files]
        return {"files": [{"name": name} for name in self.uploaded_names], "mode": "input"}

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


def _quiet_pane(fake):
    """A pane that reports no turn, no conversation URL and no generating flag,
    so only the composer can tell whether the submit landed."""
    fake.answer_after_reads = 10_000

    def quiet_read(*, tab=None, preset=None):
        return {
            "tabId": tab or "tab-1", "presetId": "gemini",
            "url": "https://gemini.google.com/app", "signedOut": False,
            "composerPresent": True, "generating": False,
            "turns": [], "lastAssistant": "", "lastAssistantLinks": [],
            "chars": 0, "truncated": False,
        }

    return quiet_read


def test_confirm_submitted_presses_send_again_when_the_brief_is_still_in_the_composer(monkeypatch):
    """ChatGPT 2026-09-09: an attachment still uploading swallowed the send and
    left the brief in the composer with no turn and no error."""
    fake = FakePane()
    fake.install(monkeypatch)
    fake.install_upload(monkeypatch)
    monkeypatch.setattr(pane, "web_read", _quiet_pane(fake))
    monkeypatch.setattr(pane_driver.time, "sleep", lambda _s: None)
    fake.composer_text = "# oracmux brief ..."
    verdict = pane_driver.confirm_submitted(SITE, "tab-1", 0, lambda _m: None, confirm_sec=30)
    assert verdict == "submitted"
    assert fake.clicked == [_values(SITE, "send")[0]], "exactly one retry press"


def test_confirm_submitted_does_not_press_send_when_the_composer_is_clear(monkeypatch):
    """The composer being empty is the proof of submit; never press again."""
    fake = FakePane()
    fake.install(monkeypatch)
    fake.install_upload(monkeypatch)
    monkeypatch.setattr(pane, "web_read", _quiet_pane(fake))
    fake.composer_text = ""
    assert pane_driver.confirm_submitted(SITE, "tab-1", 0, lambda _m: None, confirm_sec=30) == "submitted"
    assert fake.clicked == [], "a cleared composer must not trigger a second send"


def test_confirm_submitted_gives_up_and_keeps_the_tab_for_the_human(monkeypatch):
    fake = FakePane()
    fake.install(monkeypatch)
    fake.install_upload(monkeypatch)
    monkeypatch.setattr(pane, "web_read", _quiet_pane(fake))
    monkeypatch.setattr(pane_driver.time, "sleep", lambda _s: None)
    fake.composer_text = "# oracmux brief ..."
    fake.clears_composer_on_click = False
    with pytest.raises(pane_driver.PaneNotReady) as excinfo:
        pane_driver.confirm_submitted(SITE, "tab-1", 0, lambda _m: None, confirm_sec=30, retries=2)
    assert "never accepted the submit" in str(excinfo.value)
    assert len(fake.clicked) == 2, "retries are bounded"


def test_confirm_submitted_trusts_a_grown_turn_count_over_the_composer(monkeypatch):
    """When the service already shows a new turn, the composer is not consulted."""
    fake = FakePane()
    fake.install(monkeypatch)
    fake.install_upload(monkeypatch)
    fake.composer_text = "still here"
    fake.sent = True
    fake.answer_after_reads = 0
    assert pane_driver.confirm_submitted(SITE, "tab-1", 0, lambda _m: None, confirm_sec=30) == "submitted"
    assert fake.clicked == []


MODEL_SITE = dict(
    SITE,
    label="Gemini",
    model_button=["button.picker"],
    model_read="aria",
    model_menu_item=["[role='menuitem']"],
    expected_model="Pro",
)


class FakePicker:
    """A model picker: reads a name, opens a menu, and switches when clicked."""

    def __init__(self, current="現在のモデル: Flash", menu=("3.8 Flash", "3.1 Pro 高度な推論"), switches=True):
        self.current = current
        self.menu = list(menu)
        self.switches = switches
        self.clicked: list[str] = []
        self.found = True

    def install(self, monkeypatch):
        monkeypatch.setattr(pane, "web_eval", self.web_eval)
        monkeypatch.setattr(pane, "web_click", self.web_click)
        monkeypatch.setattr(pane_driver.time, "sleep", lambda _s: None)

    def web_eval(self, tab, script):
        if "__BUTTONS__" in script or "aria-label" in script and "getClientRects" in script:
            if not self.found:
                return {"found": False, "aria": "", "text": ""}
            return {"found": True, "selector": "button.picker", "aria": self.current, "text": self.current}
        if "seen.push" in script:
            want = json.loads(script.split("const want = ", 1)[1].split(";", 1)[0])
            for row in self.menu:
                if want in row:
                    if self.switches:
                        self.current = f"現在のモデル: {want}"
                    return {"ok": True, "clicked": row, "seen": self.menu}
            return {"ok": False, "seen": self.menu}
        raise AssertionError("unexpected script for FakePicker")

    def web_click(self, tab, selector):
        self.clicked.append(selector)
        return {"tabId": tab, "selector": selector}


def test_read_model_extracts_the_bare_name_from_a_sentence_label(monkeypatch):
    """Gemini's picker label is a whole sentence; reports should say "Pro"."""
    picker = FakePicker(current="モード選択ツールを開く（現在のモデル: Pro）")
    picker.install(monkeypatch)
    site = dict(MODEL_SITE, model_pattern=r"現在のモデル:\s*([^）)]+)")
    state = pane_driver.read_model(site, "tab-1")
    assert state["name"] == "Pro"
    assert state["raw"].startswith("モード選択")


def test_read_model_keeps_the_label_when_the_pattern_misses(monkeypatch):
    picker = FakePicker(current="Model select")
    picker.install(monkeypatch)
    site = dict(MODEL_SITE, model_pattern=r"現在のモデル:\s*([^）)]+)")
    assert pane_driver.read_model(site, "tab-1")["name"] == "Model select"


def test_ensure_model_switches_a_pane_sitting_on_the_cheap_model(monkeypatch):
    """Measured 2026-09-09: Gemini was on Flash and Grok on Fast while every
    document said Pro / Expert, and nothing in the pipeline noticed."""
    picker = FakePicker()
    picker.install(monkeypatch)
    chosen = pane_driver.ensure_model(MODEL_SITE, "tab-1", "Pro", lambda _m: None, settle_sec=0)
    assert chosen["switched"] is True
    assert "Pro" in chosen["model"]
    assert "switched from" in chosen["evidence"]
    assert picker.clicked == ["button.picker"], "the picker is opened exactly once"


def test_ensure_model_leaves_a_correct_pane_alone(monkeypatch):
    picker = FakePicker(current="現在のモデル: Pro")
    picker.install(monkeypatch)
    chosen = pane_driver.ensure_model(MODEL_SITE, "tab-1", "Pro", lambda _m: None, settle_sec=0)
    assert chosen["switched"] is False
    assert picker.clicked == [], "no need to touch a picker already on the right model"
    assert "already selected" in chosen["evidence"]


def test_ensure_model_refuses_to_send_when_the_switch_does_not_take(monkeypatch):
    """Clicking is not proof: the picker has to read back as the wanted model."""
    picker = FakePicker(switches=False)
    picker.install(monkeypatch)
    with pytest.raises(pane_driver.PaneNotReady) as excinfo:
        pane_driver.ensure_model(MODEL_SITE, "tab-1", "Pro", lambda _m: None, settle_sec=0)
    assert "still reads" in str(excinfo.value)


def test_ensure_model_refuses_when_the_menu_has_no_such_model(monkeypatch):
    picker = FakePicker(menu=["3.8 Flash", "3.5 Flash-Lite"])
    picker.install(monkeypatch)
    with pytest.raises(pane_driver.PaneNotReady) as excinfo:
        pane_driver.ensure_model(MODEL_SITE, "tab-1", "Pro", lambda _m: None, settle_sec=0)
    assert "no menu row matched" in str(excinfo.value)


def test_ensure_model_refuses_when_the_picker_is_missing(monkeypatch):
    """ChatGPT only shows its picker on a new chat; inside a conversation the
    lookalike button is the per-message retry control."""
    picker = FakePicker()
    picker.found = False
    picker.install(monkeypatch)
    with pytest.raises(pane_driver.PaneNotReady) as excinfo:
        pane_driver.ensure_model(MODEL_SITE, "tab-1", "Pro", lambda _m: None, settle_sec=0)
    assert "model picker was not found" in str(excinfo.value)


def test_consult_stops_before_sending_when_the_model_is_wrong(monkeypatch, tmp_path):
    fake = FakePane()
    fake.install(monkeypatch)
    picker = FakePicker(switches=False)
    monkeypatch.setattr(pane, "web_eval", picker.web_eval)
    monkeypatch.setattr(pane, "web_click", picker.web_click)
    brief = tmp_path / "brief.md"
    brief.write_text("問い", encoding="utf-8")
    result = pane_driver.consult(MODEL_SITE, brief, "問い", mode="current", out_dir=None,
                                 log=lambda _m: None, enforce_model="Pro")
    assert result.status == cdp.STATUS_NEEDS_HUMAN
    assert fake.pushed == [], "a turn must not be spent on the wrong model"
    assert result.tab_kept_open


def test_consult_records_the_model_evidence(monkeypatch, tmp_path):
    fake = FakePane()
    fake.install(monkeypatch)
    picker = FakePicker(current="現在のモデル: Pro")
    monkeypatch.setattr(pane, "web_eval", picker.web_eval)
    monkeypatch.setattr(pane, "web_click", picker.web_click)
    brief = tmp_path / "brief.md"
    brief.write_text("問い", encoding="utf-8")
    result = pane_driver.consult(MODEL_SITE, brief, "問い", mode="current", out_dir=None,
                                 log=lambda _m: None, enforce_model="Pro")
    assert result.status == cdp.STATUS_OK
    assert "Pro" in result.model and "Gemini picker" in result.model_evidence


def test_resolve_model_defaults_to_expected_and_honours_the_opt_out():
    import argparse as _argparse

    site = {"expected_model": "Pro"}
    plain = _argparse.Namespace(model=None, any_model=False)
    assert oracmux.resolve_model(site, plain) == "Pro"
    override = _argparse.Namespace(model="Thinking", any_model=False)
    assert oracmux.resolve_model(site, override) == "Thinking"
    opted_out = _argparse.Namespace(model=None, any_model=True)
    assert oracmux.resolve_model(site, opted_out) is None
    assert oracmux.resolve_model({}, plain) is None


RESEARCH_SITE = dict(
    SITE,
    label="ChatGPT",
    research={
        "steps": [{"selector": "[data-testid='plus']"}, {"text": "Deep Research", "in": ["div.__menu-item"]}],
        "active": {"text": "Deep Research", "in": ["form button"]},
    },
)


class FakeResearch:
    """A two-step research toggle that only turns on once every step ran."""

    def __init__(self, *, turns_on=True, fail_at=None):
        self.turns_on = turns_on
        self.fail_at = fail_at
        self.steps: list[str] = []
        self.on = False

    def install(self, monkeypatch):
        monkeypatch.setattr(pane, "web_eval", self.web_eval)
        monkeypatch.setattr(pane_driver.time, "sleep", lambda _s: None)

    def web_eval(self, tab, script):
        if "const spec" in script:
            return {"known": True, "active": self.on}
        if "const step" in script:
            index = len(self.steps) + 1
            if self.fail_at == index:
                return {"ok": False}
            self.steps.append(f"step{index}")
            if index == 2 and self.turns_on:
                self.on = True
            return {"ok": True, "label": f"step{index}"}
        raise AssertionError("unexpected script for FakeResearch")


def test_ensure_research_walks_the_menu_and_proves_the_toggle(monkeypatch):
    fake = FakeResearch()
    fake.install(monkeypatch)
    out = pane_driver.ensure_research(RESEARCH_SITE, "tab-1", lambda _m: None, settle_sec=0)
    assert out["active"] is True and out["switched"] is True
    assert fake.steps == ["step1", "step2"]


def test_ensure_research_is_a_noop_when_already_on(monkeypatch):
    fake = FakeResearch()
    fake.on = True
    fake.install(monkeypatch)
    out = pane_driver.ensure_research(RESEARCH_SITE, "tab-1", lambda _m: None, settle_sec=0)
    assert out["switched"] is False and fake.steps == []


def test_ensure_research_refuses_when_a_step_is_missing(monkeypatch):
    fake = FakeResearch(fail_at=2)
    fake.install(monkeypatch)
    with pytest.raises(pane_driver.PaneNotReady) as excinfo:
        pane_driver.ensure_research(RESEARCH_SITE, "tab-1", lambda _m: None, settle_sec=0)
    assert "step 2/2 not found" in str(excinfo.value)


def test_ensure_research_refuses_when_the_toggle_does_not_take(monkeypatch):
    """Clicking through the menu is not proof; a shallow answer would still cost
    a Pro turn."""
    fake = FakeResearch(turns_on=False)
    fake.install(monkeypatch)
    with pytest.raises(pane_driver.PaneNotReady) as excinfo:
        pane_driver.ensure_research(RESEARCH_SITE, "tab-1", lambda _m: None, settle_sec=0)
    assert "did not turn on" in str(excinfo.value)


def test_ensure_research_says_so_when_the_service_has_none(monkeypatch):
    site = dict(SITE, label="Grok", research={"steps": [], "unavailable": "Grok に Deep Research 相当は無い"})
    with pytest.raises(pane_driver.PaneNotReady) as excinfo:
        pane_driver.ensure_research(site, "tab-1", lambda _m: None)
    assert "Deep Research 相当は無い" in str(excinfo.value)


def test_consult_does_not_send_when_research_cannot_be_enabled(monkeypatch, tmp_path):
    fake = FakePane()
    fake.install(monkeypatch)
    research = FakeResearch(turns_on=False)
    monkeypatch.setattr(pane, "web_eval", research.web_eval)
    brief = tmp_path / "brief.md"
    brief.write_text("問い", encoding="utf-8")
    result = pane_driver.consult(RESEARCH_SITE, brief, "問い", mode="current", out_dir=None,
                                 log=lambda _m: None, research=True)
    assert result.status == cdp.STATUS_NEEDS_HUMAN
    assert fake.pushed == [], "no turn may be spent on a shallow answer"


def test_follow_up_reuses_the_tab_and_never_opens_one(monkeypatch, tmp_path):
    fake = FakePane()
    fake.install(monkeypatch)
    brief = tmp_path / "followup.md"
    brief.write_text("追い質問", encoding="utf-8")
    result = pane_driver.follow_up(SITE, "tab-1", brief, "追い質問", log=lambda _m: None)
    assert result.status == cdp.STATUS_OK
    assert fake.opened == [], "a follow-up must not open a new conversation"
    assert fake.pushed == [(str(brief), True)]
    assert result.tab_kept_open


def test_duplicate_guard_spots_an_unfinished_run_with_the_same_brief(tmp_path):
    from oracmux_lib import ledger as ledger_mod

    path = tmp_path / "ledger.jsonl"
    digest = oracmux.prompt_digest("同じ問い\n")
    ledger_mod.append({"run_id": "r1", "engine": "chatgpt", "status": "started", "prompt_sha": digest}, path)
    assert ledger_mod.running_same_prompt("chatgpt", digest, path)["run_id"] == "r1"
    # a different engine, a different brief, and a finished run are all fine
    assert ledger_mod.running_same_prompt("gemini", digest, path) is None
    assert ledger_mod.running_same_prompt("chatgpt", "deadbeef", path) is None
    ledger_mod.append({"run_id": "r1", "engine": "chatgpt", "status": "ok"}, path)
    assert ledger_mod.running_same_prompt("chatgpt", digest, path) is None


def test_duplicate_guard_forgets_a_run_that_was_killed(tmp_path):
    """A killed lane leaves a "started" row with no terminal status. Found by
    killing a Deep Research consult: without a cutoff that brief is blocked
    forever."""
    from datetime import datetime, timedelta, timezone

    from oracmux_lib import ledger as ledger_mod

    path = tmp_path / "ledger.jsonl"
    digest = oracmux.prompt_digest("止まった問い\n")
    ledger_mod.append({"run_id": "zombie", "engine": "chatgpt", "status": "started", "prompt_sha": digest}, path)
    now = datetime.now(timezone.utc)
    assert ledger_mod.running_same_prompt("chatgpt", digest, path, now=now) is not None
    later = now + timedelta(seconds=ledger_mod.STALE_RUN_SEC + 60)
    assert ledger_mod.running_same_prompt("chatgpt", digest, path, now=later) is None


def test_duplicate_guard_treats_an_unreadable_timestamp_as_stale(tmp_path):
    """A malformed line must never be able to block a send."""
    from oracmux_lib import ledger as ledger_mod

    path = tmp_path / "ledger.jsonl"
    digest = oracmux.prompt_digest("問い\n")
    path.write_text(
        json.dumps({"run_id": "r", "engine": "chatgpt", "status": "started",
                    "prompt_sha": digest, "ts": "not-a-date"}) + "\n",
        encoding="ascii",
    )
    assert ledger_mod.running_same_prompt("chatgpt", digest, path) is None


def test_prompt_digest_ignores_line_endings_and_trailing_spaces():
    assert oracmux.prompt_digest("a\r\nb  \n") == oracmux.prompt_digest("a\nb\n")
    assert oracmux.prompt_digest("a\nb") != oracmux.prompt_digest("a\nc")


def test_selftest_flags_a_selector_that_no_longer_matches(monkeypatch):
    """The 2026-09-09 case: ChatGPT dropped model-switcher-dropdown-button and
    nothing noticed, because the pytest suite never touches a real DOM."""
    fake = FakePane()
    fake.install(monkeypatch)

    def counts(tab, script):
        if "el.value" in script:
            return {"found": True, "text": ""}
        # composer matches, the model picker no longer does
        return {
            "composer": {"hits": 1, "matched": "div.ql-editor"},
            "send": {"hits": 0, "matched": None},
            "assistant": {"hits": 2, "matched": "model-response"},
            "mode_label": {"hits": 0, "matched": None},
            "upload_input": {"hits": 1, "matched": "input[type=file]"},
            "upload_open": {"hits": 1, "matched": "button.plus"},
            "__modeLabel": "",
        }

    monkeypatch.setattr(pane, "web_eval", counts)
    report = pane_driver.selftest(SITE, "tab-1", lambda _m: None)
    assert report["ok"] is False
    assert any("mode_label" in failure for failure in report["failures"])


def test_selftest_surfaces_the_model_picker_label(monkeypatch):
    """Gemini was silently on Flash while the docs claimed Pro."""
    fake = FakePane()
    fake.install(monkeypatch)
    monkeypatch.setattr(pane, "web_eval", lambda tab, script: {
        "composer": {"hits": 1, "matched": "div.ql-editor"},
        "send": {"hits": 0, "matched": None},
        "assistant": {"hits": 0, "matched": None},
        "mode_label": {"hits": 1, "matched": "button"},
        "upload_input": {"hits": 1, "matched": "input[type=file]"},
        "upload_open": {"hits": 1, "matched": "button.plus"},
        "__modeLabel": "モード選択ツールを開く（現在のモデル: Flash）",
    })
    report = pane_driver.selftest(SITE, "tab-1", lambda _m: None)
    assert report["ok"] is True
    assert "Flash" in report["model_label"]


def test_selftest_presses_the_opener_when_the_file_input_is_absent(monkeypatch):
    """Gemini shape: absent is normal, so the opener has to prove it still works."""
    fake = FakePane()
    fake.install(monkeypatch)
    fake.install_upload(monkeypatch)
    fake.input_mounted = False
    fake.opener_mounts = ("button.real-opener",)
    calls = {"n": 0}

    def counts(tab, script):
        if "el.value" in script:
            return {"found": True, "text": ""}
        if "const groups" not in script:  # _first_present_input, after the click
            return 1 if fake.input_mounted else 0
        calls["n"] += 1
        return {
            "composer": {"hits": 1, "matched": "div.ql-editor"},
            "send": {"hits": 0, "matched": None},
            "assistant": {"hits": 0, "matched": None},
            "mode_label": {"hits": 1, "matched": "button"},
            "upload_input": {"hits": 0, "matched": None},
            "upload_open": {"hits": 1, "matched": "button.real-opener"},
            "__modeLabel": "",
        }

    monkeypatch.setattr(pane, "web_eval", counts)
    site = _upload_site(upload_input=["input.hidden-file-input"], upload_open=["button.real-opener"])
    report = pane_driver.selftest(site, "tab-1", lambda _m: None, settle_sec=0)
    assert report["ok"] is True
    assert fake.clicked == ["button.real-opener"]
    assert report["groups"]["upload_input"]["after_opener"] == "button.real-opener"


def test_selftest_fails_when_the_opener_mounts_nothing(monkeypatch):
    fake = FakePane()
    fake.install(monkeypatch)
    fake.install_upload(monkeypatch)
    fake.input_mounted = False
    fake.opener_mounts = ()

    def counts(tab, script):
        if "el.value" in script:
            return {"found": True, "text": ""}
        if "const groups" not in script:
            return 0
        return {
            "composer": {"hits": 1, "matched": "div.ql-editor"},
            "send": {"hits": 0, "matched": None},
            "assistant": {"hits": 0, "matched": None},
            "mode_label": {"hits": 1, "matched": "button"},
            "upload_input": {"hits": 0, "matched": None},
            "upload_open": {"hits": 1, "matched": "button.dead"},
            "__modeLabel": "",
        }

    monkeypatch.setattr(pane, "web_eval", counts)
    site = _upload_site(upload_input=["input.hidden-file-input"], upload_open=["button.dead"])
    report = pane_driver.selftest(site, "tab-1", lambda _m: None, settle_sec=0)
    assert report["ok"] is False
    assert any("did not mount" in failure for failure in report["failures"])


def _upload_site(**overrides):
    site = dict(SITE)
    site.update(overrides)
    return site


def test_attach_uploads_uses_an_already_mounted_input(monkeypatch, tmp_path):
    """ChatGPT / Grok shape: the file input exists at load, so no opener click."""
    fake = FakePane()
    fake.install(monkeypatch)
    fake.install_upload(monkeypatch)
    doc = tmp_path / "a.pdf"
    doc.write_bytes(b"%PDF")
    site = _upload_site(upload_input=["input#upload-files"], upload_open=["button.plus"])
    attached = pane_driver.attach_uploads(site, "tab-1", [doc], lambda _m: None, settle_sec=0)
    assert fake.clicked == [], "the opener must not be pressed when the input is already there"
    assert fake.uploaded == [("input#upload-files", ["a.pdf"])]
    assert attached["files"] == ["a.pdf"] and attached["selector"] == "input#upload-files"


def test_attach_uploads_clicks_the_opener_when_the_input_is_missing(monkeypatch, tmp_path):
    """Gemini shape: no file input until the upload menu button is clicked."""
    fake = FakePane()
    fake.install(monkeypatch)
    fake.install_upload(monkeypatch)
    fake.input_mounted = False
    fake.opener_mounts = ("button.real-opener",)
    doc = tmp_path / "a.pdf"
    doc.write_bytes(b"%PDF")
    site = _upload_site(upload_input=["input.hidden-file-input"], upload_open=["button.dead", "button.real-opener"])
    attached = pane_driver.attach_uploads(site, "tab-1", [doc], lambda _m: None, settle_sec=0)
    assert fake.clicked == ["button.dead", "button.real-opener"]
    assert attached["selector"] == "input.hidden-file-input"
    assert fake.uploaded == [("input.hidden-file-input", ["a.pdf"])]


def test_attach_uploads_accepts_a_preview_that_drops_the_extension(monkeypatch, tmp_path):
    """Gemini renders "TXT" + the stem, not the full basename. Matching only the
    full name failed every Gemini upload until 2026-09-09."""
    fake = FakePane()
    fake.install(monkeypatch)
    fake.install_upload(monkeypatch)
    doc = tmp_path / "report.pdf"
    doc.write_bytes(b"%PDF")

    def stem_only(tab, script):
        if "querySelectorAll" in script:
            return 1
        assert "entry.stem" in script, "the acceptance probe must offer the stem to the page"
        # The page text holds "PDF\nreport" — the stem, never "report.pdf".
        return {"held": 0, "shown": ["report.pdf"]}

    monkeypatch.setattr(pane, "web_eval", stem_only)
    site = _upload_site(upload_input=["input#upload-files"], upload_open=[])
    attached = pane_driver.attach_uploads(site, "tab-1", [doc], lambda _m: None, settle_sec=0)
    assert attached["shown"] == ["report.pdf"]


def test_attach_uploads_raises_when_the_service_never_shows_the_file(monkeypatch, tmp_path):
    """Setting .files is not proof of delivery: without the service's own
    preview the brief must not be sent."""
    fake = FakePane()
    fake.install(monkeypatch)
    fake.install_upload(monkeypatch)
    fake.accept_after_probes = 10_000
    doc = tmp_path / "a.pdf"
    doc.write_bytes(b"%PDF")
    site = _upload_site(upload_input=["input#upload-files"], upload_open=[])
    with pytest.raises(pane_driver.PaneNotReady) as excinfo:
        pane_driver.attach_uploads(site, "tab-1", [doc], lambda _m: None, settle_sec=0, accept_sec=0.2)
    assert "did not show the attachment" in str(excinfo.value)


def test_attach_uploads_without_a_selector_is_refused(monkeypatch, tmp_path):
    fake = FakePane()
    fake.install(monkeypatch)
    fake.install_upload(monkeypatch)
    doc = tmp_path / "a.pdf"
    doc.write_bytes(b"%PDF")
    with pytest.raises(pane_driver.PaneNotReady):
        pane_driver.attach_uploads(_upload_site(upload_input=[]), "tab-1", [doc], lambda _m: None)


def test_consult_attaches_before_pushing_and_records_the_names(monkeypatch, tmp_path):
    fake = FakePane()
    fake.install(monkeypatch)
    fake.install_upload(monkeypatch)
    brief = tmp_path / "brief.md"
    brief.write_text("問い", encoding="utf-8")
    doc = tmp_path / "a.pdf"
    doc.write_bytes(b"%PDF")
    site = _upload_site(upload_input=["input#upload-files"], upload_open=[])
    result = pane_driver.consult(site, brief, "問い", mode="current", out_dir=None, log=lambda _m: None, uploads=[doc])
    assert result.status == cdp.STATUS_OK
    assert result.uploads == ["a.pdf"]
    assert fake.uploaded and fake.pushed, "both the attach and the push must have run"


def test_consult_reports_needs_human_when_the_attachment_never_lands(monkeypatch, tmp_path):
    fake = FakePane()
    fake.install(monkeypatch)
    fake.install_upload(monkeypatch)
    fake.accept_after_probes = 10_000
    brief = tmp_path / "brief.md"
    brief.write_text("問い", encoding="utf-8")
    doc = tmp_path / "a.pdf"
    doc.write_bytes(b"%PDF")
    site = _upload_site(upload_input=["input#upload-files"], upload_open=[])
    monkeypatch.setattr(pane_driver, "UPLOAD_ACCEPT_SEC", 0.2)
    result = pane_driver.consult(site, brief, "問い", mode="current", out_dir=None, log=lambda _m: None, uploads=[doc])
    assert result.status == cdp.STATUS_NEEDS_HUMAN
    assert fake.pushed == [], "nothing may be sent when the attachment did not land"
    assert result.tab_kept_open


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
    assert oracmux.main(["ask", "--engine", "chatgpt", "-q", "q", "--upload", str(pdf), "--dry-run"]) == oracmux.EXIT_OK, "the pane lane uploads since 2026-09-09"
    assert oracmux.main(["ask", "--engine", "chatgpt", "-q", "q", "--via", "oracle", "--upload", str(pdf), "--dry-run"]) == oracmux.EXIT_OK
    assert oracmux.main(["ask", "--engine", "chatgpt", "-q", "q", "--via", "cdp", "--upload", str(pdf), "--dry-run"]) == oracmux.EXIT_PRECONDITION
    command = oracmux.lane_command("grok", tmp_path, "current", 5, False, via="pane", close_tab=True)
    assert command[command.index("--via") + 1] == "pane" and command[-1] == "--close-tab"
    assert "--close-tab" not in oracmux.lane_command("grok", tmp_path, "current", 5, False, via="cdp", close_tab=True)


def test_collect_cli_lane_rules(isolated_home, capsys):
    assert oracmux.main(["collect", "--engine", "gemini", "--latest", "--via", "pane"]) == oracmux.EXIT_PRECONDITION
    assert oracmux.main(["collect", "--engine", "gemini", "--tab", "t", "--via", "cdp"]) == oracmux.EXIT_PRECONDITION
