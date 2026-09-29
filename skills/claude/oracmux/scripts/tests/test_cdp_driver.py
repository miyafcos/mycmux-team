"""Driver state machine against a scripted fake site (no browser, no network).

Covers the audit's High findings on the driver: F-12/F-13/F-14 (timeouts are
timeouts), F-15/F-16/F-17 (empty / echo / same-length reads), F-18 (unanswered
last user turn), F-19 (login wall while waiting), F-21 (hidden first match),
F-22 (fill verification), F-23 (send evidence), F-24 (mode verification),
F-26 (connect failure), F-27 (human-needed tab kept open), F-54 / F-55.
"""

from __future__ import annotations

import itertools

import pytest

from oracmux_lib import cdp, engines, paths
import fakes

SITE = dict(engines.load(paths.engines_json())["gemini"])
SITE["timeouts"] = {"answer_appear_sec": 20, "stable_sec": 4, "min_wait_sec": 2, "overall_min": 1}
SITE["url"] = "https://example.test/app"
SITE["conversation_url_pattern"] = "^https://example\\.test/app/[0-9a-f]+"


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        self.now += 1.0
        return self.now


def make_scenario(*, answer_after_polls: int = 2, answer: str = "ORACMUX-OK", login_at_poll: int | None = None, flicker: bool = False):
    counter = itertools.count()
    state = {"polls": 0, "sent": False}

    def on_send(page: fakes.FakePage) -> None:
        state["sent"] = True
        page.url = "https://example.test/app/abc123"
        page.composer_value = ""

    def resolve(page: fakes.FakePage, selector: str, scope: str | None) -> list[fakes.Node]:
        if selector in SITE["composer"]:
            return [fakes.Node(text=page.composer_value, tag="div")]
        if selector in SITE["send"]:
            return [fakes.Node(text="send", on_click=lambda: on_send(page))] if page.composer_value else []
        if selector in SITE["assistant"]:
            if not state["sent"]:
                return []
            state["polls"] += 1
            if state["polls"] < answer_after_polls:
                return []
            if flicker and state["polls"] % 5 == 0:
                return [fakes.Node(text="")]
            return [fakes.Node(text=answer)]
        if selector in SITE["generating"]:
            return [fakes.Node(text="stop")] if state["sent"] and state["polls"] < answer_after_polls + 1 else []
        if selector in SITE["login"]:
            return [fakes.Node(text="ログイン")] if login_at_poll is not None and state["polls"] >= login_at_poll else []
        return []

    return fakes.Scenario(resolve=resolve, on_send=on_send)


def run_consult(monkeypatch, scenario, **kwargs):
    page = fakes.FakePage(scenario, url=SITE["url"])
    fakes.install(monkeypatch, cdp, page)
    monkeypatch.setattr(cdp.time, "monotonic", Clock())
    result = cdp.consult(SITE, "http://127.0.0.1:0", "問い本文 " * 30, mode="current", out_dir=None, log=lambda _m: None, **kwargs)
    return result, page


def test_consult_happy_path_collects_answer_url_and_closes_tab(monkeypatch):
    result, page = run_consult(monkeypatch, make_scenario())
    assert result.status == cdp.STATUS_OK
    assert result.answer == "ORACMUX-OK"
    assert result.conversation_url == "https://example.test/app/abc123"
    assert result.detection == "answer_stable_after_appear"
    assert page.closed and not result.tab_kept_open
    assert any(item.startswith("filled_via=") for item in result.trace)


def test_consult_never_appearing_answer_is_a_timeout_not_ui_failure(monkeypatch):
    result, _page = run_consult(monkeypatch, make_scenario(answer_after_polls=10_000))
    assert result.status == cdp.STATUS_TIMEOUT
    assert result.exit_code == 2
    assert result.conversation_url == "https://example.test/app/abc123", "URL survives the failure (F-55)"


def test_consult_empty_flicker_reads_do_not_finish_an_empty_answer(monkeypatch):
    result, _page = run_consult(monkeypatch, make_scenario(flicker=True))
    assert result.status == cdp.STATUS_OK
    assert result.answer == "ORACMUX-OK"


def test_consult_login_wall_while_waiting_keeps_tab_open(monkeypatch):
    result, page = run_consult(monkeypatch, make_scenario(answer_after_polls=50, login_at_poll=3))
    assert result.status == cdp.STATUS_NEEDS_HUMAN
    assert result.tab_kept_open and not page.closed
    assert "login" in result.error
    assert any(item.startswith("tab_kept_open=") for item in result.trace)


def test_consult_connect_failure_is_a_precondition(monkeypatch):
    page = fakes.FakePage(make_scenario(), url=SITE["url"])
    fakes.install(monkeypatch, cdp, page, fail_connect=True)
    result = cdp.consult(SITE, "http://127.0.0.1:0", "q", mode="current", out_dir=None, log=lambda _m: None)
    assert result.status == cdp.STATUS_PRECONDITION and result.exit_code == 7


def test_first_skips_hidden_matches(monkeypatch):
    nodes = [fakes.Node(text="hidden", visible=False), fakes.Node(text="shown", visible=True)]
    page = fakes.FakePage(fakes.Scenario(resolve=lambda p, s, sc: nodes if s == "x" else []))
    driver = cdp.SiteDriver(page, {"composer": ["x"]}, lambda _m: None)
    assert driver.first("composer").inner_text() == "shown"
    assert driver.first("composer", last=True).inner_text() == "shown"


def test_fill_verifies_the_text_landed(monkeypatch):
    def resolve(page, selector, scope):
        return [fakes.Node(text="wrong")] if selector == "c" else []

    page = fakes.FakePage(fakes.Scenario(resolve=resolve))
    driver = cdp.SiteDriver(page, {"composer": ["c"]}, lambda _m: None)
    monkeypatch.setattr(cdp.time, "sleep", lambda _s: None)
    page.composer_value = "prefilled"
    monkeypatch.setattr(driver, "composer_text", lambda: "something else entirely")
    with pytest.raises(cdp.UiNotFound):
        driver.fill_composer("hello world")


def test_send_needs_positive_evidence(monkeypatch):
    state = {"gen": False}

    def resolve(page, selector, scope):
        if selector == "c":
            return [fakes.Node(text=page.composer_value)]
        if selector == "s":
            return [fakes.Node(text="send")]
        if selector == "g":
            return [fakes.Node(text="stop")] if state["gen"] else []
        return []

    page = fakes.FakePage(fakes.Scenario(resolve=resolve))
    page.composer_value = "text"
    driver = cdp.SiteDriver(page, {"composer": ["c"], "send": ["s"], "generating": ["g"], "assistant": ["a"]}, lambda _m: None)
    clock = Clock()
    monkeypatch.setattr(cdp.time, "monotonic", clock)
    monkeypatch.setattr(cdp.time, "sleep", lambda _s: None)
    with pytest.raises(cdp.UiNotFound):
        driver.send()  # composer keeps its text, nothing generates -> not confirmed
    state["gen"] = True
    assert driver.send() == "button"


def test_select_mode_requires_item_click_or_active_selector(monkeypatch):
    clicks: list[str] = []

    def resolve(page, selector, scope):
        if selector == "open":
            return [fakes.Node(text="menu", on_click=lambda: clicks.append("open"))]
        return []

    page = fakes.FakePage(fakes.Scenario(resolve=resolve))
    site = {"modes": {"thinking": {"steps": [["open"]], "labels": ["強化版思考モード"]}}}
    driver = cdp.SiteDriver(page, site, lambda _m: None)
    monkeypatch.setattr(cdp.time, "sleep", lambda _s: None)
    actual, trace = driver.select_mode("thinking")
    assert actual == "current", "opening the menu alone must not count as switched (F-24)"
    assert "fallback=current" in trace and page.keyboard.pressed == ["Escape"]
    assert driver.select_mode("nope") == ("current", "unknown_mode:nope")


def test_select_mode_succeeds_when_label_is_clicked(monkeypatch):
    def resolve(page, selector, scope):
        if selector == "open":
            return [fakes.Node(text="menu")]
        if selector == cdp.CLICKABLE:
            return [fakes.Node(text="3.7 Flash"), fakes.Node(text="強化版思考モード")]
        return []

    page = fakes.FakePage(fakes.Scenario(resolve=resolve))
    site = {"modes": {"thinking": {"steps": [["open"]], "labels": ["強化版思考モード"]}}}
    driver = cdp.SiteDriver(page, site, lambda _m: None)
    monkeypatch.setattr(cdp.time, "sleep", lambda _s: None)
    actual, trace = driver.select_mode("thinking")
    assert actual == "thinking" and "item_clicked=true" in trace


def test_clean_answer_never_returns_empty_for_a_real_answer():
    assert cdp.clean_answer("Expert", ["Expert"]) == "Expert"
    assert cdp.clean_answer("Worked for 2s\n\nAuto", ["Worked for .*"]) == "Auto"


def test_history_target_builds_absolute_urls():
    assert cdp.history_target("https://gemini.google.com/app", "/app/abc") == "https://gemini.google.com/app/abc"
    assert cdp.history_target("https://grok.com/", "/c/1") == "https://grok.com/c/1"
    assert cdp.history_target("https://chatgpt.com/", "https://chatgpt.com/c/x") == "https://chatgpt.com/c/x"


def make_collect_scenario(*, turns: list[dict[str, str]], answer_polls_before_reply: int = 0):
    state = {"polls": 0}

    def resolve(page: fakes.FakePage, selector: str, scope: str | None) -> list[fakes.Node]:
        if selector in SITE["composer"]:
            return [fakes.Node(text="")]
        if selector in SITE["assistant"]:
            state["polls"] += 1
            assistant = [turn for turn in page.turns if turn["role"] == "assistant"]
            return [fakes.Node(text=assistant[-1]["text"])] if assistant else []
        return []

    scenario = fakes.Scenario(resolve=resolve)
    page = fakes.FakePage(scenario, url="https://example.test/app/abc123")
    page.turns = list(turns)
    return scenario, page, state


def test_collect_waits_for_the_answer_to_the_last_user_turn(monkeypatch):
    turns = [{"role": "user", "text": "q1"}, {"role": "assistant", "text": "a1"}, {"role": "user", "text": "q2"}]
    scenario, page, state = make_collect_scenario(turns=turns)
    fakes.install(monkeypatch, cdp, page)
    clock = Clock()
    monkeypatch.setattr(cdp.time, "monotonic", clock)

    original_locator = page.locator

    def locator(selector: str, scope: str | None = None):
        # after a few polls the model answers q2
        if state["polls"] >= 12 and page.turns[-1]["role"] == "user":
            page.turns.append({"role": "assistant", "text": "a2"})
        return original_locator(selector, scope)

    page.locator = locator  # type: ignore[assignment]
    result = cdp.collect(SITE, "http://127.0.0.1:0", url="https://example.test/app/abc123", out_dir=None, log=lambda _m: None, stable_sec=3, overall_sec=120)
    assert result.status == cdp.STATUS_OK
    assert result.answer == "a2"
    assert result.turns[-1]["role"] == "assistant"


def test_collect_deadline_is_partial_or_timeout_not_ok(monkeypatch):
    turns = [{"role": "user", "text": "q1"}, {"role": "assistant", "text": "a1"}, {"role": "user", "text": "q2"}]
    scenario, page, _state = make_collect_scenario(turns=turns)
    fakes.install(monkeypatch, cdp, page)
    monkeypatch.setattr(cdp.time, "monotonic", Clock())
    result = cdp.collect(SITE, "http://127.0.0.1:0", url="https://example.test/app/abc123", out_dir=None, log=lambda _m: None, stable_sec=3, overall_sec=15)
    assert result.status == cdp.STATUS_PARTIAL and result.exit_code == 2
    assert result.answer == "a1" and result.detection == "timeout"
    scenario2, page2, _ = make_collect_scenario(turns=[{"role": "user", "text": "q"}])
    fakes.install(monkeypatch, cdp, page2)
    monkeypatch.setattr(cdp.time, "monotonic", Clock())
    result2 = cdp.collect(SITE, "http://127.0.0.1:0", url="https://example.test/app/abc123", out_dir=None, log=lambda _m: None, stable_sec=3, overall_sec=10)
    assert result2.status == cdp.STATUS_TIMEOUT
