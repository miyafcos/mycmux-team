"""Playwright-over-CDP driver: consult (send + wait + harvest) and collect (harvest an
existing conversation) on ChatGPT / Gemini / Grok inside OracleChrome.

Everything site-specific comes from engines.json. This module knows the shape of
a chat UI (composer, send, generating indicator, assistant turns, history) and
nothing about any one site.

Hardened after the 2026-09-07 audit: visibility search over several matches,
verified composer fill, positive send evidence, strict mode verification,
human-needed checks while waiting, partial answers and URLs preserved on
every failure path, the human-needed tab kept open, timeouts reported as
timeouts, and collect bounded by one deadline.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from . import chrome
from .watcher import DETECT_ECHO, STATE_DONE, STATE_STREAMING, AnswerWatcher, WatchConfig

Log = Callable[[str], None]

COMPOSER_WAIT_SEC = 30.0
MENU_SETTLE_MS = 700
SEND_CONFIRM_SEC = 12.0
POLL_SEC = 5.0
VISIBLE_SCAN_LIMIT = 10
ATTEMPTS_PER_STEP = 3

EXIT_OK = 0
EXIT_PARTIAL = 2
EXIT_NEEDS_HUMAN = 3
EXIT_UI_NOT_FOUND = 4
EXIT_PRECONDITION = 7

STATUS_OK = "ok"
STATUS_PARTIAL = "partial"
STATUS_FAILED = "failed"
STATUS_NEEDS_HUMAN = "needs_human"
STATUS_TIMEOUT = "timeout"
STATUS_PRECONDITION = "precondition"

STATUS_EXIT: dict[str, int] = {
    STATUS_OK: EXIT_OK,
    STATUS_PARTIAL: EXIT_PARTIAL,
    STATUS_TIMEOUT: EXIT_PARTIAL,
    STATUS_NEEDS_HUMAN: EXIT_NEEDS_HUMAN,
    STATUS_FAILED: EXIT_UI_NOT_FOUND,
    STATUS_PRECONDITION: EXIT_PRECONDITION,
}

CLICKABLE = (
    "button, a, [role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox'], "
    "[role='option'], [role='switch'], [role='checkbox']"
)
MENU_CONTAINERS = (
    "[role='menu'], [role='listbox'], [role='dialog'], [data-radix-popper-content-wrapper], "
    "[data-radix-menu-content], .mat-mdc-menu-panel, [role='menubar']"
)
TURNS_NOTE = "rendered turns only: the page shows what it has loaded; long histories may be virtualised"


class UiNotFound(RuntimeError):
    pass


class NeedsHuman(RuntimeError):
    pass


@dataclass
class Result:
    status: str
    answer: str = ""
    conversation_url: str = ""
    citations: list[str] = field(default_factory=list)
    mode_requested: str = ""
    mode_actual: str = ""
    detection: str = ""
    elapsed_sec: int = 0
    trace: list[str] = field(default_factory=list)
    error: str = ""
    turns: list[dict[str, str]] = field(default_factory=list)
    turns_note: str = ""
    page_url: str = ""
    tab_kept_open: bool = False
    format: str = "innertext"
    tab_id: str = ""

    @property
    def exit_code(self) -> int:
        return STATUS_EXIT.get(self.status, EXIT_UI_NOT_FOUND)


def pick_latest_history(entries: list[dict[str, Any]], skip_aria: list[str], landing_paths: tuple[str, ...] = ("/", "/app")) -> dict[str, Any] | None:
    """First history entry that is a real conversation and not pinned (pure)."""
    for entry in entries:
        href = str(entry.get("href") or "")
        stripped = href.rstrip("/") or "/"
        if not href or stripped in landing_paths or href.startswith("#"):
            continue
        aria = str(entry.get("aria") or "").casefold()
        if any(token.casefold() in aria for token in skip_aria):
            continue
        return entry
    return None


def clean_answer(text: str, patterns: list[str]) -> str:
    """Drop the UI caption lines a chat page renders above the answer
    ("Gemini の回答", "Worked for 3s", "Thought for 12s"). Only leading lines
    are touched, only whole lines that match a pattern, and never everything:
    when stripping would leave nothing, the original text is kept (audit F-54)."""
    compiled = [re.compile(pattern) for pattern in patterns]
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index].strip()
        if not line:
            index += 1
            continue
        if any(regex.fullmatch(line) for regex in compiled):
            index += 1
            continue
        break
    cleaned = "\n".join(lines[index:]).strip("\n")
    if not cleaned.strip() and text.strip():
        return text.strip("\n")
    return cleaned


def history_target(site_url: str, href: str) -> str:
    """Absolute URL for a sidebar href (pure)."""
    if href.startswith("http"):
        return href
    from urllib.parse import urlsplit

    parts = urlsplit(site_url)
    return f"{parts.scheme}://{parts.netloc}{href if href.startswith('/') else '/' + href}"


def _values(site: dict[str, Any], key: str) -> list[str]:
    value = site.get(key, [])
    if isinstance(value, str):
        return [value]
    return [item for item in value if isinstance(item, str)]


def _visible_in(locator: Any, *, last: bool) -> Any | None:
    """First visible element among up to VISIBLE_SCAN_LIMIT matches (audit F-21).
    `last=True` scans from the end (the newest assistant turn)."""
    try:
        count = int(locator.count())
    except Exception:  # noqa: BLE001
        return None
    if not count:
        return None
    indexes = range(count - 1, max(-1, count - 1 - VISIBLE_SCAN_LIMIT), -1) if last else range(min(count, VISIBLE_SCAN_LIMIT))
    for index in indexes:
        candidate = locator.nth(index)
        try:
            if candidate.is_visible():
                return candidate
        except Exception:  # noqa: BLE001
            continue
    return None


class SiteDriver:
    def __init__(self, page: Any, site: dict[str, Any], log: Log) -> None:
        self.page = page
        self.site = site
        self.log = log

    # -- locating ---------------------------------------------------------
    def first_of(self, selectors: list[str], *, last: bool = False, scope: Any | None = None) -> Any | None:
        root = scope if scope is not None else self.page
        for selector in selectors:
            try:
                found = _visible_in(root.locator(selector), last=last)
            except Exception:  # noqa: BLE001 - selector errors are "not found"
                found = None
            if found is not None:
                return found
        return None

    def first(self, key: str, *, last: bool = False) -> Any | None:
        return self.first_of(_values(self.site, key), last=last)

    def visible(self, key: str) -> bool:
        return self.first(key) is not None

    def wait_for(self, key: str, seconds: float) -> Any | None:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            found = self.first(key)
            if found is not None:
                return found
            time.sleep(0.5)
        return None

    # -- page state -------------------------------------------------------
    def body_text(self) -> str:
        try:
            return str(self.page.evaluate("() => document.body ? document.body.innerText : ''"))
        except Exception:  # noqa: BLE001
            return ""

    def limit_hit(self) -> str:
        """Usage-limit text on a page that holds no conversation yet (pre-send
        only: inside a conversation the same words may be the topic — F-20)."""
        texts = _values(self.site, "limit_texts")
        if not texts:
            return ""
        body = self.body_text()
        for text in texts:
            if text in body:
                return text
        return ""

    def mode_label(self) -> str:
        found = self.first("mode_label")
        if found is None:
            return ""
        try:
            return str(found.inner_text(timeout=1500)).strip().replace("\n", " ")[:60]
        except Exception:  # noqa: BLE001
            return ""

    def dismiss_overlays(self) -> list[str]:
        clicked: list[str] = []
        for selector in _values(self.site, "dismiss"):
            found = self.first_of([selector])
            if found is None:
                continue
            try:
                found.click(timeout=3000)
                clicked.append(selector)
                time.sleep(0.5)
            except Exception:  # noqa: BLE001
                continue
        return clicked

    def human_needed(self, *, check_limit: bool) -> str:
        if self.visible("captcha"):
            return "captcha challenge is visible"
        if self.visible("login"):
            return "login control is visible (signed out)"
        if check_limit:
            limit = self.limit_hit()
            if limit:
                return f"usage limit text on screen: {limit}"
        return ""

    def check_human_needed(self, *, check_limit: bool = True) -> None:
        reason = self.human_needed(check_limit=check_limit)
        if reason:
            raise NeedsHuman(reason)

    def ensure_ready(self, *, check_limit: bool = True) -> None:
        composer = self.wait_for("composer", COMPOSER_WAIT_SEC)
        if composer is None:
            self.dismiss_overlays()
            composer = self.wait_for("composer", 5.0)
        if composer is None:
            self.check_human_needed(check_limit=check_limit)
            raise UiNotFound("composer did not appear")
        self.check_human_needed(check_limit=check_limit)

    # -- conversation -----------------------------------------------------
    def conversation_url(self) -> str:
        pattern = str(self.site.get("conversation_url_pattern", ""))
        url = str(self.page.url)
        return url if pattern and re.search(pattern, url) else ""

    def new_chat(self) -> str:
        if not self.conversation_url() and self.page.url.rstrip("/") == str(self.site["url"]).rstrip("/"):
            return "landing"
        found = self.first("new_chat")
        if found is not None:
            try:
                found.click(timeout=5000)
                time.sleep(1.0)
                return "clicked"
            except Exception as exc:  # noqa: BLE001
                self.log(f"new_chat click failed: {str(exc)[:80]}")
        self.page.goto(str(self.site["url"]), wait_until="domcontentloaded", timeout=45000)
        return "url_fallback"

    def last_assistant_text(self) -> str | None:
        """Text of the newest assistant turn; "" when there is none; None when the
        page could not be read (the watcher treats both as bad reads while streaming)."""
        for selector in _values(self.site, "assistant"):
            try:
                locator = self.page.locator(selector)
                count = int(locator.count())
            except Exception:  # noqa: BLE001
                return None
            if count:
                try:
                    return str(locator.nth(count - 1).inner_text(timeout=3000))
                except Exception:  # noqa: BLE001
                    return None
        return ""

    def assistant_count(self) -> int:
        for selector in _values(self.site, "assistant"):
            try:
                count = int(self.page.locator(selector).count())
            except Exception:  # noqa: BLE001
                continue
            if count:
                return count
        return 0

    def generating(self) -> bool:
        return self.visible("generating")

    def citations(self) -> list[str]:
        found: list[str] = []
        for selector in _values(self.site, "assistant"):
            try:
                locator = self.page.locator(selector)
                count = int(locator.count())
                if not count:
                    continue
                hrefs = locator.nth(count - 1).locator("a[href]").evaluate_all(
                    "(nodes) => nodes.map((node) => node.getAttribute('href') || '')"
                )
                for href in hrefs:
                    if isinstance(href, str) and href.startswith("http") and href not in found:
                        found.append(href)
                break
            except Exception:  # noqa: BLE001
                continue
        return found

    def turns(self) -> tuple[list[dict[str, str]], str]:
        """(turns currently rendered, note). An empty list with a note that says
        why is not the same as "no turns" (audit F-46)."""
        user_selectors = _values(self.site, "user_turns")
        assistant_selectors = _values(self.site, "assistant")
        if not assistant_selectors:
            return [], "no assistant selector configured"
        combined = ", ".join(user_selectors + assistant_selectors)
        script = """
        ([combined, userSelectors]) => Array.from(document.querySelectorAll(combined)).map((node) => ({
          role: userSelectors.some((selector) => node.matches(selector)) ? 'user' : 'assistant',
          text: node.innerText || ''
        }))
        """
        try:
            raw = self.page.evaluate(script, [combined, user_selectors])
        except Exception as exc:  # noqa: BLE001
            return [], f"turn extraction failed: {str(exc)[:120]}"
        turns: list[dict[str, str]] = []
        for item in raw if isinstance(raw, list) else []:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                turns.append({"role": str(item.get("role", "assistant")), "text": item["text"]})
        return turns, TURNS_NOTE

    def composer_text(self) -> str | None:
        composer = self.first("composer")
        if composer is None:
            return None
        try:
            value = composer.evaluate("(node) => node.value !== undefined && node.tagName === 'TEXTAREA' ? node.value : (node.innerText || node.textContent || '')")
            return str(value)
        except Exception:  # noqa: BLE001
            return None

    # -- mode -------------------------------------------------------------
    def menu_scope(self) -> Any | None:
        return self.first_of([MENU_CONTAINERS])

    def click_label(self, labels: list[str]) -> str:
        """Click the best visible control whose text/aria matches a label. The
        search is confined to the open menu when one is visible (audit F-25)."""
        scope = self.menu_scope()
        candidates = (scope if scope is not None else self.page).locator(CLICKABLE)
        try:
            entries = candidates.evaluate_all(
                "(nodes) => nodes.map((node, index) => ({index, text: node.innerText || '', aria: node.getAttribute('aria-label') || ''}))"
            )
        except Exception as exc:  # noqa: BLE001
            raise UiNotFound(f"label scan failed: {str(exc)[:80]}") from exc
        ranked: dict[int, tuple[int, str]] = {}
        for entry in entries if isinstance(entries, list) else []:
            if not isinstance(entry, dict) or not isinstance(entry.get("index"), int):
                continue
            index = int(entry["index"])
            names = [str(entry.get("text", "")).strip(), str(entry.get("aria", "")).strip()]
            for label in labels:
                folded = label.casefold()
                if any(name.casefold() == folded for name in names):
                    score = 0
                elif any(name.casefold().startswith(folded) for name in names):
                    score = 1
                elif any(folded in name.casefold() for name in names):
                    score = 2
                else:
                    continue
                if index not in ranked or score < ranked[index][0]:
                    ranked[index] = (score, label)
        ordered = sorted(ranked.items(), key=lambda item: (item[1][0], item[0]))
        attempts = 0
        for index, (_score, label) in ordered:
            if attempts >= ATTEMPTS_PER_STEP:
                break
            attempts += 1
            candidate = candidates.nth(index)
            try:
                if candidate.is_visible():
                    candidate.click(timeout=3000)
                    return label
            except Exception:  # noqa: BLE001
                continue
        raise UiNotFound("label not found: " + " / ".join(labels))

    def mode_active(self, mode: dict[str, Any]) -> bool | None:
        selectors = _values(mode, "active")
        if not selectors:
            return None
        return self.first_of(selectors) is not None

    def close_menus(self) -> None:
        try:
            self.page.keyboard.press("Escape")
        except Exception:  # noqa: BLE001
            pass

    def select_mode(self, mode_id: str) -> tuple[str, str]:
        """Best effort, strictly verified (audit F-24). Returns (actual_mode, trace).
        Success needs the mode's `active` selector to match, or — when the mode
        defines none — a successful click on the actual item (a label or a
        step past the menu-opening one). Opening the menu is never enough."""
        modes = self.site.get("modes", {})
        mode = modes.get(mode_id)
        if not isinstance(mode, dict):
            return "current", f"unknown_mode:{mode_id}"
        steps = mode.get("steps", [])
        labels = _values(mode, "labels")
        if not steps and not labels:
            return "current", "no_change"
        trace: list[str] = []
        if self.mode_active(mode):
            return mode_id, "already_active"
        item_clicked = False
        for number, group in enumerate(steps, start=1):
            clicked = False
            for _attempt in range(ATTEMPTS_PER_STEP):
                found = self.first_of(list(group))
                if found is not None:
                    try:
                        found.click(timeout=3000)
                        clicked = True
                        break
                    except Exception as exc:  # noqa: BLE001
                        trace.append(f"step{number}_click_failed:{str(exc)[:60]}")
                time.sleep(1.0)
            trace.append(f"step{number}={'ok' if clicked else 'missing'}")
            if not clicked:
                break
            if number >= 2:
                item_clicked = True
            time.sleep(MENU_SETTLE_MS / 1000)
            if number == 1 and labels:
                try:
                    label = self.click_label(labels)
                    trace.append(f"label={label}")
                    item_clicked = True
                    time.sleep(0.7)
                    break
                except UiNotFound as exc:
                    trace.append(str(exc)[:80])
        active = self.mode_active(mode)
        if active is True:
            return mode_id, "; ".join(trace + ["active=true"])
        if active is None and item_clicked:
            return mode_id, "; ".join(trace + ["active=unverified", "item_clicked=true"])
        self.close_menus()
        return "current", "; ".join(trace + [f"active={active}", "fallback=current"])

    # -- sending ----------------------------------------------------------
    def _verify_filled(self, text: str) -> bool:
        current = self.composer_text()
        if current is None:
            return False
        want = re.sub(r"\s+", "", text)
        have = re.sub(r"\s+", "", current)
        if len(want) <= 2000:
            return have == want
        return have.startswith(want[:200]) and len(have) >= int(len(want) * 0.9)

    def fill_composer(self, text: str) -> str:
        composer = self.first("composer")
        if composer is None:
            raise UiNotFound("composer")
        composer.click(timeout=5000)
        try:
            composer.fill(text, timeout=60000)
            if self._verify_filled(text):
                return "fill"
            self.log("fill did not land the full text; retrying with insertText")
        except Exception as exc:  # noqa: BLE001
            self.log(f"fill failed ({str(exc)[:60]}); using insertText")
        composer = self.first("composer")
        if composer is None:
            raise UiNotFound("composer vanished during fill")
        composer.click(timeout=5000)
        self.page.evaluate(
            "(value) => { document.execCommand('selectAll', false, null); document.execCommand('insertText', false, value); }",
            text,
        )
        if self._verify_filled(text):
            return "insertText"
        raise UiNotFound("composer text does not match the brief after fill (audit F-22)")

    def send(self) -> str:
        """Click send (or press Enter) and demand positive evidence that the
        message left the composer (audit F-23): a generating indicator, a new
        assistant turn, or a readable, empty composer after a few seconds."""
        before = self.assistant_count()
        button = self.wait_for("send", 15.0)
        how = "button"
        if button is not None:
            button.click(timeout=5000)
        else:
            how = "enter"
            composer = self.first("composer")
            if composer is None:
                raise UiNotFound("composer vanished before send")
            composer.press("Enter")
        started = time.monotonic()
        deadline = started + SEND_CONFIRM_SEC
        while time.monotonic() < deadline:
            if self.generating() or self.assistant_count() > before:
                return how
            current = self.composer_text()
            if current is not None and not current.strip() and time.monotonic() - started >= 3.0:
                return how + "_composer_cleared"
            time.sleep(1.0)
        raise UiNotFound("send was not confirmed (no generating indicator, no new turn, composer not empty)")


def _connect(playwright: Any, endpoint: str) -> Any:
    alive, detail = chrome.cdp_alive(endpoint)
    if not alive:
        raise RuntimeError(f"CDP endpoint down: {detail}")
    browser = playwright.chromium.connect_over_cdp(endpoint, timeout=20000)
    context = browser.contexts[0] if browser.contexts else browser.new_context()
    page = context.new_page()
    page.set_default_timeout(5000)
    return page


def _screenshot(page: Any, out_dir: Path | None, name: str = "fail.png") -> None:
    if out_dir is None or page is None:
        return
    try:
        page.screenshot(path=str(out_dir / name))
    except Exception:  # noqa: BLE001
        pass


def _close(page: Any, keep_open: bool) -> None:
    if page is None or keep_open:
        return
    try:
        page.close()
    except Exception:  # noqa: BLE001
        pass


def consult(
    site: dict[str, Any],
    endpoint: str,
    prompt: str,
    *,
    mode: str,
    out_dir: Path | None,
    log: Log,
    progress: Callable[[str, dict[str, Any]], None] | None = None,
    timeouts: dict[str, float] | None = None,
) -> Result:
    started = time.monotonic()
    cfg_src = dict(site["timeouts"])
    if timeouts:
        cfg_src.update({k: v for k, v in timeouts.items() if v})
    cfg = WatchConfig(
        answer_appear_sec=float(cfg_src["answer_appear_sec"]),
        stable_sec=float(cfg_src["stable_sec"]),
        min_wait_sec=float(cfg_src["min_wait_sec"]),
        overall_sec=float(cfg_src["overall_min"]) * 60.0,
    )
    strip_patterns = _values(site, "answer_strip_patterns")
    result = Result(status=STATUS_FAILED, mode_requested=mode)

    def report(phase: str, **fields: Any) -> None:
        fields["elapsed_sec"] = int(time.monotonic() - started)
        if progress:
            progress(phase, fields)

    from playwright.sync_api import sync_playwright

    page: Any = None
    keep_open = False
    watcher: AnswerWatcher | None = None
    with sync_playwright() as playwright:
        try:
            report("connecting")
            page = _connect(playwright, endpoint)
        except Exception as exc:  # noqa: BLE001 (audit F-26)
            result.status = STATUS_PRECONDITION
            result.error = f"cdp: {type(exc).__name__}: {str(exc)[:200]}"
            result.elapsed_sec = int(time.monotonic() - started)
            report("failed", error=result.error)
            return result
        driver = SiteDriver(page, site, log)
        try:
            page.goto(str(site["url"]), wait_until="domcontentloaded", timeout=45000)
            driver.ensure_ready(check_limit=True)
            clicked = driver.dismiss_overlays()
            if clicked:
                result.trace.append("dismissed:" + ",".join(clicked))
            result.trace.append("new_chat=" + driver.new_chat())
            driver.ensure_ready(check_limit=True)
            report("composing", mode_label=driver.mode_label())
            actual, mode_trace = driver.select_mode(mode)
            result.mode_actual = actual
            result.trace.append("mode:" + mode_trace)
            if actual != mode:
                log(f"mode {mode} not reachable -> current ({mode_trace})")
            baseline = driver.last_assistant_text() or ""
            result.trace.append("filled_via=" + driver.fill_composer(prompt))
            how = driver.send()
            sent_at = time.monotonic()
            result.trace.append("sent_via=" + how)
            report("waiting_answer")
            watcher = AnswerWatcher(cfg, baseline, [prompt], sent_at)
            last_report = 0.0
            while not watcher.finished:
                body = driver.last_assistant_text()
                state = watcher.feed(body or "", driver.generating(), time.monotonic())
                result.answer = watcher.last_body
                if not result.conversation_url:
                    result.conversation_url = driver.conversation_url()
                reason = driver.human_needed(check_limit=False)  # audit F-19
                if reason:
                    raise NeedsHuman(reason)
                if state == STATE_STREAMING and time.monotonic() - last_report >= 30:
                    report("answer_streaming", chars=len(result.answer), url=result.conversation_url)
                    log(f"streaming: {len(result.answer)} chars, {int(time.monotonic() - started)}s")
                    last_report = time.monotonic()
                if watcher.finished:
                    break
                time.sleep(POLL_SEC)
            result.detection = watcher.detection
            result.trace.extend(watcher.trace)
            result.answer = clean_answer(watcher.last_body, strip_patterns)
            if not result.conversation_url:
                result.conversation_url = driver.conversation_url()
            if watcher.state == STATE_DONE:
                result.status = STATUS_OK
                result.citations = driver.citations()
                result.turns, result.turns_note = driver.turns()
                report("done", chars=len(result.answer), url=result.conversation_url)
            else:
                if watcher.detection == DETECT_ECHO:
                    result.status = STATUS_FAILED
                    result.error = "echo_detected: the assistant selector returned our own prompt"
                else:
                    result.status = STATUS_PARTIAL if result.answer.strip() else STATUS_TIMEOUT
                    result.error = watcher.detection
                _screenshot(page, out_dir)
                report("failed", detection=watcher.detection, chars=len(result.answer))
        except NeedsHuman as exc:
            result.status = STATUS_NEEDS_HUMAN
            result.error = str(exc)
            keep_open = True
            _screenshot(page, out_dir)
            report("needs_human", error=str(exc))
            log("needs human: " + str(exc) + " -> oracle-chrome show (tab kept open)")
            chrome.show()
        except UiNotFound as exc:
            result.status = STATUS_FAILED
            result.error = "ui_not_found: " + str(exc)
            _screenshot(page, out_dir)
            report("failed", error=result.error)
        except Exception as exc:  # noqa: BLE001
            result.status = STATUS_FAILED
            result.error = f"{type(exc).__name__}: {str(exc)[:200]}"
            _screenshot(page, out_dir)
            report("failed", error=result.error)
        finally:
            if watcher is not None and not result.answer:
                result.answer = clean_answer(watcher.last_body, strip_patterns)  # audit F-55
            try:
                result.page_url = str(page.url)
                if not result.conversation_url:
                    result.conversation_url = driver.conversation_url()
            except Exception:  # noqa: BLE001
                pass
            result.tab_kept_open = keep_open
            if keep_open:
                result.trace.append("tab_kept_open=" + result.page_url)
            result.elapsed_sec = int(time.monotonic() - started)
            _close(page, keep_open)
    return result


def collect(
    site: dict[str, Any],
    endpoint: str,
    *,
    url: str | None,
    out_dir: Path | None,
    log: Log,
    stable_sec: float = 20.0,
    overall_sec: float = 900.0,
) -> Result:
    """Harvest an existing conversation (by URL, or the latest in the sidebar).

    One deadline (`overall_sec`) bounds everything: opening, the first answer,
    and stability (audit F-14). Leaving by the deadline is a timeout / partial,
    never a success (audit F-12). A conversation whose last turn is the user's
    is not answered yet (audit F-18)."""
    started = time.monotonic()
    deadline = started + overall_sec
    strip_patterns = _values(site, "answer_strip_patterns")
    result = Result(status=STATUS_FAILED, mode_requested="collect")
    from playwright.sync_api import sync_playwright

    page: Any = None
    keep_open = False
    last_good = ""
    with sync_playwright() as playwright:
        try:
            page = _connect(playwright, endpoint)
        except Exception as exc:  # noqa: BLE001
            result.status = STATUS_PRECONDITION
            result.error = f"cdp: {type(exc).__name__}: {str(exc)[:200]}"
            result.elapsed_sec = int(time.monotonic() - started)
            return result
        driver = SiteDriver(page, site, log)
        try:
            page.goto(url or str(site["url"]), wait_until="domcontentloaded", timeout=45000)
            driver.ensure_ready(check_limit=not url)
            if not url:
                driver.dismiss_overlays()
                entries: list[dict[str, Any]] = []
                scan_deadline = min(deadline, time.monotonic() + 20)
                while time.monotonic() < scan_deadline and not entries:
                    for selector in _values(site, "history"):
                        try:
                            entries = page.locator(selector).evaluate_all(
                                "(nodes) => nodes.map((node) => ({href: node.getAttribute('href') || '', aria: node.getAttribute('aria-label') || '', text: (node.innerText || '').trim().slice(0, 80)}))"
                            )
                        except Exception:  # noqa: BLE001
                            entries = []
                        if entries:
                            break
                    if not entries:
                        time.sleep(1.0)
                latest = pick_latest_history(entries if isinstance(entries, list) else [], _values(site, "history_skip_aria"))
                if latest is None:
                    raise UiNotFound("no conversation in the sidebar history")
                target = history_target(str(site["url"]), str(latest["href"]))
                result.trace.append(f"latest={target} title={latest.get('text', '')}")
                page.goto(target, wait_until="domcontentloaded", timeout=45000)
            stable_since: float | None = None
            prev_body: str | None = None
            answered = False
            while time.monotonic() < deadline:
                reason = driver.human_needed(check_limit=False)
                if reason:
                    raise NeedsHuman(reason)
                body = driver.last_assistant_text()
                now = time.monotonic()
                if not result.conversation_url:
                    result.conversation_url = driver.conversation_url()
                if not body:
                    stable_since = None
                    time.sleep(POLL_SEC if body == "" else 1.0)
                    continue
                last_good = body
                if driver.generating() or body != prev_body:
                    stable_since = None
                elif stable_since is None:
                    stable_since = now
                elif now - stable_since >= stable_sec:
                    turns, note = driver.turns()
                    if turns and turns[-1].get("role") == "user":
                        stable_since = None  # the model has not answered the last message yet
                        prev_body = body
                        time.sleep(POLL_SEC)
                        continue
                    answered = True
                    result.turns, result.turns_note = turns, note
                    break
                prev_body = body
                time.sleep(POLL_SEC)
            result.answer = clean_answer(last_good, strip_patterns)
            result.conversation_url = driver.conversation_url() or str(page.url)
            result.mode_actual = driver.mode_label()
            if answered:
                result.citations = driver.citations()
                result.detection = "collected_stable"
                result.status = STATUS_OK
            else:
                result.detection = "timeout"
                result.status = STATUS_PARTIAL if result.answer.strip() else STATUS_TIMEOUT
                result.error = "deadline reached before the conversation settled"
                _screenshot(page, out_dir)
        except NeedsHuman as exc:
            result.status = STATUS_NEEDS_HUMAN
            result.error = str(exc)
            keep_open = True
            _screenshot(page, out_dir)
            chrome.show()
        except UiNotFound as exc:
            result.status = STATUS_FAILED
            result.error = "ui_not_found: " + str(exc)
            _screenshot(page, out_dir)
        except Exception as exc:  # noqa: BLE001
            result.status = STATUS_FAILED
            result.error = f"{type(exc).__name__}: {str(exc)[:200]}"
            _screenshot(page, out_dir)
        finally:
            if not result.answer and last_good:
                result.answer = clean_answer(last_good, strip_patterns)
            try:
                result.page_url = str(page.url)
            except Exception:  # noqa: BLE001
                pass
            result.tab_kept_open = keep_open
            if keep_open:
                result.trace.append("tab_kept_open=" + result.page_url)
            result.elapsed_sec = int(time.monotonic() - started)
            _close(page, keep_open)
    return result


def probe(site: dict[str, Any], endpoint: str, log: Log) -> dict[str, Any]:
    """Read-only readiness probe: login, composer, mode label, limit text."""
    from playwright.sync_api import sync_playwright

    info: dict[str, Any] = {"ok": False, "status": "error", "detail": "", "mode_label": ""}
    page: Any = None
    with sync_playwright() as playwright:
        try:
            page = _connect(playwright, endpoint)
        except Exception as exc:  # noqa: BLE001
            info.update(status="cdp_down", detail=f"{type(exc).__name__}: {str(exc)[:160]}")
            return info
        driver = SiteDriver(page, site, log)
        try:
            page.goto(str(site["url"]), wait_until="domcontentloaded", timeout=45000)
            composer = driver.wait_for("composer", 20.0)
            if composer is None:
                driver.dismiss_overlays()
                composer = driver.wait_for("composer", 5.0)
            if driver.visible("captcha"):
                info.update(status="captcha", detail="captcha challenge visible")
            elif driver.visible("login"):
                info.update(status="not_logged_in", detail="login control visible")
            elif composer is None:
                info.update(status="composer_absent", detail="composer did not appear (overlay? login?)")
            else:
                limit = driver.limit_hit()
                if limit:
                    info.update(status="limit", detail=f"usage limit text on screen: {limit}")
                else:
                    info.update(ok=True, status="ok", detail="logged in, composer available")
            info["mode_label"] = driver.mode_label()
        except Exception as exc:  # noqa: BLE001
            info.update(status="error", detail=f"{type(exc).__name__}: {str(exc)[:160]}")
        finally:
            _close(page, False)
    return info


def switch_chatgpt_to_chat(endpoint: str, log: Log) -> str:
    """Recovery for the Work weekly limit: press the `Chat` toggle (personal Pro)."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        page = _connect(playwright, endpoint)
        try:
            page.goto("https://chatgpt.com/", wait_until="domcontentloaded", timeout=45000)
            time.sleep(3)
            clicked = page.evaluate(
                "() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.innerText || '').trim() === 'Chat'); if (!b) return false; b.click(); return true; }"
            )
            time.sleep(3)
            body = str(page.evaluate("() => document.body.innerText"))
            still = any(text in body for text in ("Weekly limit", "Add credits"))
            return f"clicked={clicked} limit_text_still_visible={still}"
        finally:
            _close(page, False)
