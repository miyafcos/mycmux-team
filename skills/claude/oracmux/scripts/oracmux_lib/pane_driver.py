"""Web-pane lane: consult / collect / probe through mycmux's own Web pane.

The conversation lives in a background Web tab of the caller's pane
(`web.open {background:true}`), the brief goes in through `web.push
{submit:true}`, and the answer comes back through `web.read`. Nothing leaves
mycmux: no Chrome, no CDP, no oracle CLI. Thinking modes cannot be switched
from here (the pane exposes no click API), so the lane always runs with the
mode the human last selected in that service's UI.

Failure semantics mirror the CDP lane (`cdp.Result`): timeouts are timeouts,
a signed-out pane is `needs_human` and the tab is left open for the human.
"""

from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Any, Callable

from . import pane
from .cdp import (
    STATUS_FAILED,
    STATUS_NEEDS_HUMAN,
    STATUS_OK,
    STATUS_PARTIAL,
    STATUS_PRECONDITION,
    STATUS_TIMEOUT,
    Result,
    clean_answer,
)
from .watcher import DETECT_ECHO, STATE_DONE, STATE_STREAMING, AnswerWatcher, WatchConfig

Log = Callable[[str], None]

READY_WAIT_SEC = 90.0
READY_POLL_SEC = 2.0
POLL_SEC = 5.0
TURNS_NOTE = "turns as rendered in the pane (web.read); long histories may be virtualised"


class PaneNotReady(RuntimeError):
    pass


def _values(site: dict[str, Any], key: str) -> list[str]:
    value = site.get(key, [])
    if isinstance(value, str):
        return [value]
    return [item for item in value if isinstance(item, str)]


def conversation_url(site: dict[str, Any], url: str) -> str:
    pattern = str(site.get("conversation_url_pattern", ""))
    return url if pattern and re.search(pattern, url or "") else ""


def read_state(tab: str) -> dict[str, Any] | None:
    """One `web.read`; None while the webview is still being created or is still
    navigating (about:blank / redirect). A redirect parked on an identity
    provider means the pane is signed out."""
    try:
        return pane.web_read(tab=tab)
    except pane.PaneError as exc:
        message = str(exc)
        if pane.is_signed_out_host(message):
            raise PaneNotReady("signed out: the pane is parked on " + str(pane.host_of_error(message)) + "; log in inside the pane and run again") from exc
        if pane.is_not_ready(message):
            return None
        raise


def wait_ready(tab: str, log: Log, *, seconds: float = READY_WAIT_SEC) -> dict[str, Any]:
    """Wait until the pane shows a composer and is not signed out."""
    deadline = time.monotonic() + seconds
    last: dict[str, Any] | None = None
    while time.monotonic() < deadline:
        state = read_state(tab)
        if state is not None:
            last = state
            if state.get("signedOut"):
                raise PaneNotReady("signed out: log in inside the pane (ペインの「別の窓でログイン」) and run again")
            if state.get("composerPresent"):
                return state
        time.sleep(READY_POLL_SEC)
    if last is None:
        raise PaneNotReady("the web pane never answered web.read (webview not created?)")
    raise PaneNotReady(
        "composer did not appear in the pane: url=" + str(last.get("url") or "") + " title=" + str(last.get("title") or "")[:60]
        + " (most likely not signed in on this pane profile; sign in inside the pane, or a slow load / interstitial)"
    )


def consult(
    site: dict[str, Any],
    prompt_file: Path,
    prompt_text: str,
    *,
    mode: str,
    out_dir: Path | None,
    log: Log,
    progress: Callable[[str, dict[str, Any]], None] | None = None,
    timeouts: dict[str, float] | None = None,
    tab_id: str | None = None,
    close_tab: bool = False,
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
    preset = str(site["pane_preset"])
    result = Result(status=STATUS_FAILED, mode_requested=mode, format="innertext")
    if mode != "current":
        result.trace.append(f"mode:{mode} requested but the pane lane cannot switch modes; using current")
    result.mode_actual = "current"

    def report(phase: str, **fields: Any) -> None:
        fields["elapsed_sec"] = int(time.monotonic() - started)
        if progress:
            progress(phase, fields)

    tab = tab_id
    watcher: AnswerWatcher | None = None
    keep_open = True
    try:
        report("connecting")
        if tab is None:
            opened = pane.web_open(preset, background=True, anchor=pane.anchor_session())
            tab = str(opened["tabId"])
            result.trace.append(f"tab_opened={tab} background={opened.get('background', True)}")
        else:
            result.trace.append(f"tab_reused={tab}")
        result.tab_id = tab
        state = wait_ready(tab, log)
        result.trace.append("ready")
        baseline = str(state.get("lastAssistant") or "")
        report("composing")
        pushed = pane.web_push(preset=preset, text_file=prompt_file, send=True, tab=tab)
        sent_at = time.monotonic()
        result.trace.append(f"pushed={pushed if isinstance(pushed, dict) else 'ok'}")
        report("waiting_answer")
        watcher = AnswerWatcher(cfg, baseline, [prompt_text], sent_at)
        last_report = 0.0
        while not watcher.finished:
            state = read_state(tab) or {}
            body = str(state.get("lastAssistant") or "")
            generating = bool(state.get("generating"))
            watcher.feed(body, generating, time.monotonic())
            result.answer = watcher.last_body
            url = str(state.get("url") or "")
            if url and not result.conversation_url:
                result.conversation_url = conversation_url(site, url)
            result.page_url = url or result.page_url
            if state.get("signedOut"):
                raise PaneNotReady("signed out while waiting; log in inside the pane")
            if watcher.state == STATE_STREAMING and time.monotonic() - last_report >= 30:
                report("answer_streaming", chars=len(result.answer), url=result.conversation_url)
                log(f"streaming: {len(result.answer)} chars, {int(time.monotonic() - started)}s")
                last_report = time.monotonic()
            if watcher.finished:
                break
            time.sleep(POLL_SEC)
        result.detection = watcher.detection
        result.trace.extend(watcher.trace)
        result.answer = clean_answer(watcher.last_body, strip_patterns)
        final = read_state(tab) or {}
        if final:
            result.page_url = str(final.get("url") or result.page_url)
            if not result.conversation_url:
                result.conversation_url = conversation_url(site, result.page_url)
        if watcher.state == STATE_DONE:
            result.status = STATUS_OK
            result.citations = [link for link in final.get("lastAssistantLinks", []) if isinstance(link, str)]
            result.turns = [turn for turn in final.get("turns", []) if isinstance(turn, dict)]
            result.turns_note = TURNS_NOTE + (" (truncated)" if final.get("truncated") else "")
            report("done", chars=len(result.answer), url=result.conversation_url)
        elif watcher.detection == DETECT_ECHO:
            result.status = STATUS_FAILED
            result.error = "echo_detected: web.read returned our own prompt as the last assistant turn"
        else:
            result.status = STATUS_PARTIAL if result.answer.strip() else STATUS_TIMEOUT
            result.error = watcher.detection
            report("failed", detection=watcher.detection, chars=len(result.answer))
        keep_open = not close_tab
    except PaneNotReady as exc:
        result.status = STATUS_NEEDS_HUMAN
        result.error = str(exc)
        report("needs_human", error=str(exc))
        log("needs human: " + str(exc))
    except pane.PaneUnavailable as exc:
        result.status = STATUS_PRECONDITION
        result.error = f"mycmux unavailable: {exc}"
        report("failed", error=result.error)
    except pane.PaneError as exc:
        result.status = STATUS_FAILED
        result.error = f"pane: {exc}"
        report("failed", error=result.error)
    except Exception as exc:  # noqa: BLE001
        result.status = STATUS_FAILED
        result.error = f"{type(exc).__name__}: {str(exc)[:200]}"
        report("failed", error=result.error)
    finally:
        if watcher is not None and not result.answer:
            result.answer = clean_answer(watcher.last_body, strip_patterns)
        result.tab_kept_open = tab is not None and keep_open
        if tab is not None and not keep_open:
            try:
                pane.web_close(tab)
                result.trace.append("tab_closed")
            except pane.PaneError as exc:
                result.trace.append(f"tab_close_failed:{str(exc)[:80]}")
        elif tab is not None:
            result.trace.append(f"tab_kept_open={tab}")
        result.elapsed_sec = int(time.monotonic() - started)
    return result


def collect(
    site: dict[str, Any],
    *,
    tab_id: str | None,
    url: str | None,
    log: Log,
    stable_sec: float = 20.0,
    overall_sec: float = 900.0,
    close_tab: bool = False,
) -> Result:
    """Harvest the conversation shown in a pane tab (by tab id, by preset's
    latest tab, or by opening a conversation URL in a background tab)."""
    started = time.monotonic()
    deadline = started + overall_sec
    strip_patterns = _values(site, "answer_strip_patterns")
    preset = str(site["pane_preset"])
    result = Result(status=STATUS_FAILED, mode_requested="collect", format="innertext")
    tab = tab_id
    opened_here = False
    keep_open = True
    last_good = ""
    try:
        if url:
            opened = pane.web_open(preset, url=url, background=True, anchor=pane.anchor_session())
            tab = str(opened["tabId"])
            opened_here = True
            result.trace.append(f"tab_opened={tab} url={url}")
        if tab is None:
            tabs = [item for item in pane.web_list() if item.get("presetId") == preset]
            if not tabs:
                raise PaneNotReady(f"no {preset} pane is open; pass --tab, --url, or open one from the launcher")
            tab = str(tabs[-1]["tabId"])
            result.trace.append(f"tab_latest={tab}")
        result.tab_id = tab
        state = wait_ready(tab, log, seconds=min(READY_WAIT_SEC, overall_sec))
        stable_since: float | None = None
        prev_body: str | None = None
        answered = False
        while time.monotonic() < deadline:
            state = read_state(tab) or state
            if state.get("signedOut"):
                raise PaneNotReady("signed out; log in inside the pane")
            body = str(state.get("lastAssistant") or "")
            now = time.monotonic()
            result.page_url = str(state.get("url") or result.page_url)
            if not result.conversation_url:
                result.conversation_url = conversation_url(site, result.page_url)
            if not body:
                stable_since = None
                time.sleep(POLL_SEC)
                continue
            last_good = body
            turns = [turn for turn in state.get("turns", []) if isinstance(turn, dict)]
            if bool(state.get("generating")) or body != prev_body:
                stable_since = None
            elif stable_since is None:
                stable_since = now
            elif now - stable_since >= stable_sec:
                if turns and turns[-1].get("role") == "user":
                    stable_since = None
                    prev_body = body
                    time.sleep(POLL_SEC)
                    continue
                answered = True
                result.turns = turns
                result.turns_note = TURNS_NOTE + (" (truncated)" if state.get("truncated") else "")
                result.citations = [link for link in state.get("lastAssistantLinks", []) if isinstance(link, str)]
                break
            prev_body = body
            time.sleep(POLL_SEC)
        result.answer = clean_answer(last_good, strip_patterns)
        if answered:
            result.detection = "collected_stable"
            result.status = STATUS_OK
        else:
            result.detection = "timeout"
            result.status = STATUS_PARTIAL if result.answer.strip() else STATUS_TIMEOUT
            result.error = "deadline reached before the conversation settled"
        keep_open = not (close_tab and opened_here)
    except PaneNotReady as exc:
        result.status = STATUS_NEEDS_HUMAN
        result.error = str(exc)
    except pane.PaneUnavailable as exc:
        result.status = STATUS_PRECONDITION
        result.error = f"mycmux unavailable: {exc}"
    except pane.PaneError as exc:
        result.status = STATUS_FAILED
        result.error = f"pane: {exc}"
    except Exception as exc:  # noqa: BLE001
        result.status = STATUS_FAILED
        result.error = f"{type(exc).__name__}: {str(exc)[:200]}"
    finally:
        if not result.answer and last_good:
            result.answer = clean_answer(last_good, strip_patterns)
        result.tab_kept_open = tab is not None and keep_open
        if tab is not None and not keep_open:
            try:
                pane.web_close(tab)
                result.trace.append("tab_closed")
            except pane.PaneError as exc:
                result.trace.append(f"tab_close_failed:{str(exc)[:80]}")
        result.elapsed_sec = int(time.monotonic() - started)
    return result


def probe(site: dict[str, Any], log: Log) -> dict[str, Any]:
    """Doctor row for one engine: the state of its open pane tabs (no tab is not an error)."""
    preset = str(site["pane_preset"])
    info: dict[str, Any] = {"ok": None, "status": "no_tab", "detail": f"no {preset} pane open (launcher or web-open)", "tabs": []}
    try:
        tabs = [item for item in pane.web_list() if item.get("presetId") == preset]
    except pane.PaneUnavailable as exc:
        return {"ok": False, "status": "mycmux_down", "detail": str(exc)[:160], "tabs": []}
    if not tabs:
        return info
    rows = []
    for item in tabs:
        tab = str(item.get("tabId"))
        try:
            state = pane.web_read(tab=tab)
            rows.append({
                "tabId": tab,
                "background": item.get("background"),
                "signedOut": bool(state.get("signedOut")),
                "composerPresent": bool(state.get("composerPresent")),
                "generating": bool(state.get("generating")),
                "url": state.get("url"),
                "turns": len(state.get("turns", [])),
            })
        except pane.PaneError as exc:
            rows.append({"tabId": tab, "error": str(exc)[:120]})
    info["tabs"] = rows
    healthy = [row for row in rows if row.get("composerPresent") and not row.get("signedOut")]
    if healthy:
        info.update(ok=True, status="ok", detail=f"{len(healthy)}/{len(rows)} tab(s) logged in with a composer")
    elif any(row.get("signedOut") for row in rows):
        info.update(ok=False, status="not_logged_in", detail="pane is signed out; use the pane's sign-in button")
    else:
        info.update(ok=False, status="composer_absent", detail="pane open but no composer (loading? error?)")
    return info
