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

import json
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


UPLOAD_SETTLE_SEC = 3.0
UPLOAD_ACCEPT_SEC = 90.0
UPLOAD_POLL_SEC = 2.0
# Count matching file inputs without touching them. `web.eval` runs an async body.
# The placeholders are substituted, never `str.format`ed: these bodies are full of
# JS braces.
COUNT_INPUTS_JS = "return document.querySelectorAll(__SELECTOR__).length;"
# A service has taken the files once its own preview names them. Services differ
# in how they render the name: Grok and ChatGPT print it in full, Gemini prints
# the stem and puts the extension in a separate type badge ("TXT" + "report"), so
# matching only the full basename reported a false failure for every Gemini
# upload (2026-09-09). The file input itself is not evidence either way — Gemini
# unmounts it once it has taken the file.
ACCEPTED_JS = """
const names = __NAMES__;
const input = document.querySelector(__SELECTOR__);
const held = input && input.files ? input.files.length : 0;
const text = document.body ? (document.body.innerText || "") : "";
const shown = names.filter(entry => text.includes(entry.full) || text.includes(entry.stem));
return { held: held, shown: shown.map(entry => entry.full) };
"""


MODEL_SETTLE_SEC = 2.5
MODEL_MENU_SEC = 1.5
# Where the picker keeps the model name differs per service: ChatGPT and Grok put
# it in the button's own text, Gemini in its aria-label.
MODEL_READ_JS = """
const sels = __BUTTONS__;
for (const s of sels) {
  const el = document.querySelector(s);
  if (!el || el.getClientRects().length === 0) continue;
  const aria = el.getAttribute("aria-label") || "";
  const text = (el.innerText || "").trim().replace(/\\s+/g, " ");
  return { found: true, selector: s, aria: aria, text: text };
}
return { found: false, aria: "", text: "" };
"""
# Only real menu rows are candidates. Sidebar entries and the profile row also
# contain "Pro", so a looser query would click the wrong thing.
MODEL_PICK_JS = """
const want = __WANT__;
const seen = [];
for (const s of __ITEMS__) {
  for (const el of document.querySelectorAll(s)) {
    if (el.getClientRects().length === 0) continue;
    const t = (el.innerText || "").trim().replace(/\\s+/g, " ");
    if (!t) continue;
    seen.push(t.slice(0, 60));
    if (t.includes(want)) { el.click(); return { ok: true, clicked: t.slice(0, 60), seen: seen }; }
  }
}
return { ok: false, seen: seen };
"""

RESEARCH_STEP_SEC = 12.0
RESEARCH_SETTLE_SEC = 2.0
# One step of a research toggle: either a plain selector, or "the row whose text
# contains X" inside the given containers. Waits for the target to render, since
# each click opens the surface the next step needs.
RESEARCH_STEP_JS = """
const step = __STEP__;
const deadline = Date.now() + __WAIT_MS__;
const pick = () => {
  if (step.selector) {
    const el = document.querySelector(step.selector);
    return el && el.getClientRects().length ? el : null;
  }
  for (const container of (step.in || ["[role='menuitem']"])) {
    for (const el of document.querySelectorAll(container)) {
      if (!el.getClientRects().length) continue;
      if ((el.innerText || "").trim().includes(step.text)) return el;
    }
  }
  return null;
};
while (Date.now() < deadline) {
  const el = pick();
  if (el) { el.click(); return { ok: true, label: (el.innerText || step.selector || "").trim().slice(0, 50) }; }
  await new Promise(r => setTimeout(r, 300));
}
return { ok: false };
"""
# Is the research mode actually on? Either a composer chip carries the label
# (ChatGPT) or the menu row reads aria-checked (Gemini).
RESEARCH_ACTIVE_JS = """
const spec = __SPEC__;
if (spec.checked) {
  for (const container of (spec.in || ["[role='menuitemcheckbox']"])) {
    for (const el of document.querySelectorAll(container)) {
      if ((el.innerText || "").trim().includes(spec.checked))
        return { known: true, active: el.getAttribute("aria-checked") === "true" };
    }
  }
  return { known: false, active: false };
}
for (const container of (spec.in || ["form button"])) {
  for (const el of document.querySelectorAll(container)) {
    if (!el.getClientRects().length) continue;
    if ((el.innerText || "").trim() === spec.text) return { known: true, active: true };
  }
}
return { known: true, active: false };
"""

SUBMIT_CONFIRM_SEC = 75.0
SUBMIT_POLL_SEC = 3.0
SUBMIT_RETRY_LIMIT = 2
# Reads the composer without touching it. A service clears the composer when it
# accepts a submit, so text still sitting there means the send did not take.
COMPOSER_TEXT_JS = """
const selectors = __SELECTORS__;
for (const sel of selectors) {
  const el = document.querySelector(sel);
  if (el) return { found: true, text: (el.innerText || el.value || "").trim().slice(0, 400) };
}
return { found: false, text: "" };
"""


def _js(template: str, **values: Any) -> str:
    """Substitute __NAME__ placeholders with JSON literals (no str.format: the
    bodies contain JS object braces)."""
    script = template
    for key, value in values.items():
        script = script.replace("__" + key.upper() + "__", json.dumps(value))
    return script


def _first_present_input(tab: str, selectors: list[str], log: Log) -> str | None:
    """The first upload selector that matches something in the live DOM."""
    for selector in selectors:
        try:
            count = pane.web_eval(tab, _js(COUNT_INPUTS_JS, selector=selector))
        except pane.PaneError as exc:
            log(f"upload: probing {selector} failed: {str(exc)[:120]}")
            continue
        if isinstance(count, (int, float)) and int(count) > 0:
            return selector
    return None


def read_model(site: dict[str, Any], tab: str) -> dict[str, Any]:
    """What the service's own picker says is selected, right now."""
    buttons = _values(site, "model_button")
    if not buttons:
        return {"found": False, "name": "", "raw": ""}
    state = pane.web_eval(tab, _js(MODEL_READ_JS, buttons=buttons))
    if not isinstance(state, dict) or not state.get("found"):
        return {"found": False, "name": "", "raw": ""}
    source = str(site.get("model_read") or "text")
    raw = str(state.get("aria" if source == "aria" else "text") or "").strip()
    # A picker label can be a whole sentence ("モード選択ツールを開く（現在のモデル: Pro）").
    # `model_pattern` pulls the bare name out so reports stay readable; without a
    # match the raw label is kept, never dropped.
    name = raw
    pattern = site.get("model_pattern")
    if isinstance(pattern, str) and pattern:
        match = re.search(pattern, raw)
        if match and match.group(1).strip():
            name = match.group(1).strip()
    return {"found": True, "name": name, "raw": raw, "selector": state.get("selector", "")}


def ensure_model(
    site: dict[str, Any],
    tab: str,
    wanted: str,
    log: Log,
    *,
    settle_sec: float = MODEL_SETTLE_SEC,
) -> dict[str, Any]:
    """Read the picker, switch it if it is on the wrong model, and prove the result.

    The oracle lane prints a "Model selection evidence" line; the pane lane owes
    the same proof and then some, because a Web pane silently keeps whatever the
    human last picked. Measured 2026-09-09: Gemini was on Flash and Grok on Fast
    while every document said Pro / Expert, and nothing in the pipeline noticed.

    Never sends on the wrong model: an unverifiable picker raises PaneNotReady so
    the caller stops with the tab open instead of spending a turn on Flash.
    """
    label = str(site.get("label") or "")
    before = read_model(site, tab)
    if not before["found"]:
        raise PaneNotReady(
            f"{label}: the model picker was not found ({_values(site, 'model_button')}). "
            "Cannot prove which model would answer, so nothing was sent — check the pane "
            "(ChatGPT only shows its picker on a new chat), or pass --any-model."
        )
    if wanted in before["name"]:
        log(f"model: {label} is on {before['name']!r} (wanted {wanted!r})")
        return {"model": before["name"], "switched": False, "wanted": wanted,
                "evidence": f"{label} picker: {before['name']} (already selected)"}
    log(f"model: {label} is on {before['name']!r}, switching to {wanted!r}")
    for opener in _values(site, "model_button"):
        try:
            pane.web_click(tab, opener)
        except pane.PaneError:
            continue
        break
    time.sleep(MODEL_MENU_SEC)
    items = _values(site, "model_menu_item") or ["[role='menuitem']"]
    picked = pane.web_eval(tab, _js(MODEL_PICK_JS, want=wanted, items=items))
    seen = [row for row in (picked or {}).get("seen", []) if isinstance(row, str)] if isinstance(picked, dict) else []
    if not isinstance(picked, dict) or not picked.get("ok"):
        raise PaneNotReady(
            f"{label}: no menu row matched {wanted!r}; the picker offered {seen}. "
            f"Still on {before['name']!r}, so nothing was sent."
        )
    time.sleep(settle_sec)
    after = read_model(site, tab)
    if not after["found"] or wanted not in after["name"]:
        raise PaneNotReady(
            f"{label}: clicked {picked.get('clicked')!r} but the picker still reads "
            f"{after.get('name')!r}, not {wanted!r}. Nothing was sent — switch it in the pane."
        )
    log(f"model: {label} switched to {after['name']!r}")
    return {"model": after["name"], "switched": True, "wanted": wanted,
            "evidence": f"{label} picker: {after['name']} (switched from {before['name']})"}


def research_active(site: dict[str, Any], tab: str) -> dict[str, Any]:
    """Whether the service's deep-research mode is currently on."""
    cfg = site.get("research") or {}
    spec = cfg.get("active")
    if not isinstance(spec, dict):
        return {"known": False, "active": False}
    state = pane.web_eval(tab, _js(RESEARCH_ACTIVE_JS, spec=spec))
    if not isinstance(state, dict):
        return {"known": False, "active": False}
    return {"known": bool(state.get("known")), "active": bool(state.get("active"))}


def ensure_research(site: dict[str, Any], tab: str, log: Log, *, settle_sec: float = RESEARCH_SETTLE_SEC) -> dict[str, Any]:
    """Turn on the service's deep-research mode and prove it took.

    oracle has `--browser-research deep` for ChatGPT; this is the pane lane's
    equivalent, and it refuses to send when the toggle cannot be proven — a
    silently shallow answer that cost a Pro turn is worse than stopping.
    """
    label = str(site.get("label") or "")
    cfg = site.get("research") or {}
    if cfg.get("unavailable"):
        raise PaneNotReady(f"{label}: {cfg['unavailable']}")
    steps = cfg.get("steps") or []
    if not steps:
        raise PaneNotReady(f"{label} has no deep-research path in engines.json")
    before = research_active(site, tab)
    if before["known"] and before["active"]:
        log(f"research: {label} is already in deep research")
        return {"active": True, "switched": False, "evidence": f"{label}: deep research (already on)"}
    trail: list[str] = []
    for index, step in enumerate(steps, start=1):
        result = pane.web_eval(tab, _js(RESEARCH_STEP_JS, step=step, wait_ms=int(RESEARCH_STEP_SEC * 1000)))
        if not isinstance(result, dict) or not result.get("ok"):
            raise PaneNotReady(
                f"{label}: deep research step {index}/{len(steps)} not found "
                f"({step}). Reached: {trail}. Nothing was sent."
            )
        trail.append(str(result.get("label") or "")[:40])
        time.sleep(settle_sec)
    after = research_active(site, tab)
    if not after["active"]:
        raise PaneNotReady(
            f"{label}: walked the deep-research menu ({trail}) but the mode did not turn on"
            + ("" if after["known"] else " (and its state could not be read)")
            + ". Nothing was sent — turn it on in the pane and rerun with --tab."
        )
    log(f"research: {label} switched into deep research via {trail}")
    return {"active": True, "switched": True, "evidence": f"{label}: deep research (enabled via {' > '.join(trail)})"}


def follow_up(
    site: dict[str, Any],
    tab: str,
    prompt_file: Path,
    prompt_text: str,
    *,
    log: Log,
    progress: Callable[[str, dict[str, Any]], None] | None = None,
    timeouts: dict[str, float] | None = None,
) -> Result:
    """Ask again in a conversation that already exists (oracle's --browser-follow-up).

    Reuses `consult` on an open tab: the tab already holds the history, so the
    only differences are that no tab is opened and the model / research gates do
    not run again (the conversation's model is fixed once it has started).
    """
    return consult(
        site, prompt_file, prompt_text,
        mode="current", out_dir=None, log=log, progress=progress,
        timeouts=timeouts, tab_id=tab, close_tab=False,
    )


def attach_uploads(
    site: dict[str, Any],
    tab: str,
    uploads: list[Path],
    log: Log,
    *,
    settle_sec: float = UPLOAD_SETTLE_SEC,
    accept_sec: float = UPLOAD_ACCEPT_SEC,
) -> dict[str, Any]:
    """Attach real files to the service's composer before the brief is pushed.

    Services differ in when the file input exists: ChatGPT and Grok mount one at
    load, Gemini only after its "upload and tools" menu button is clicked
    (measured 2026-09-09). So probe first, click the opener only if needed, and
    never click the menu item that would raise the OS file picker — the files go
    straight onto the input element.

    Raises PaneNotReady when the service never shows the attachment, so the
    caller reports needs_human instead of sending a brief that cites a file the
    service does not have.
    """
    selectors = _values(site, "upload_input")
    if not selectors:
        raise PaneNotReady(f"{site.get('label')} has no upload_input selector in engines.json")
    pane.check_upload_size(uploads)
    selector = _first_present_input(tab, selectors, log)
    if selector is None:
        for opener in _values(site, "upload_open"):
            try:
                pane.web_click(tab, opener)
            except pane.PaneError as exc:
                log(f"upload: opener {opener} did not click: {str(exc)[:120]}")
                continue
            log(f"upload: opened the attach surface with {opener}")
            time.sleep(settle_sec)
            selector = _first_present_input(tab, selectors, log)
            if selector is not None:
                break
    if selector is None:
        raise PaneNotReady(
            f"no file input appeared in the {site.get('label')} pane "
            f"(tried {selectors}; openers {_values(site, 'upload_open')})"
        )
    result = pane.web_upload(tab, selector, uploads)
    names = [path.name for path in uploads]
    name_entries = [{"full": path.name, "stem": path.stem} for path in uploads]
    log(f"upload: set {len(uploads)} file(s) on {selector}")
    deadline = time.monotonic() + accept_sec
    shown: list[str] = []
    held = 0
    while time.monotonic() < deadline:
        try:
            state = pane.web_eval(tab, _js(ACCEPTED_JS, names=name_entries, selector=selector))
        except pane.PaneError as exc:
            log(f"upload: acceptance probe failed: {str(exc)[:120]}")
            state = None
        if isinstance(state, dict):
            held = int(state.get("held") or 0)
            shown = [item for item in state.get("shown", []) if isinstance(item, str)]
            if len(shown) == len(names):
                log(f"upload: {site.get('label')} shows all {len(names)} attachment(s)")
                return {"selector": selector, "files": names, "shown": shown, "result": result}
        time.sleep(UPLOAD_POLL_SEC)
    raise PaneNotReady(
        f"{site.get('label')} did not show the attachment(s) within {int(accept_sec)}s "
        f"(input holds {held}, shown {shown} of {names}); the file was set on {selector} "
        "but the service never rendered it — check the pane"
    )


def confirm_submitted(
    site: dict[str, Any],
    tab: str,
    baseline_turns: int,
    log: Log,
    *,
    confirm_sec: float = SUBMIT_CONFIRM_SEC,
    retries: int = SUBMIT_RETRY_LIMIT,
) -> str:
    """Make sure `web.push --send` really submitted, and press send again if not.

    A service can take the text and the files and still refuse the submit — 2026-09-09
    on ChatGPT an attachment that was still uploading swallowed the send, leaving the
    brief sitting in the composer with no turn and no error. Retrying is only safe
    while all three still say "not sent": the composer still holds text, the turn
    count has not grown, and the page has not moved to a conversation URL.
    """
    composer = _values(site, "composer")
    deadline = time.monotonic() + confirm_sec
    attempts = 0
    while time.monotonic() < deadline:
        state = read_state(tab) or {}
        turns = len(state.get("turns") or [])
        url = str(state.get("url") or "")
        if turns > baseline_turns or conversation_url(site, url) or state.get("generating"):
            return "submitted"
        try:
            probe = pane.web_eval(tab, _js(COMPOSER_TEXT_JS, selectors=composer))
        except pane.PaneError as exc:
            log(f"submit: composer probe failed: {str(exc)[:120]}")
            return "unverified"
        if not isinstance(probe, dict) or not probe.get("found"):
            return "unverified"
        if not str(probe.get("text") or "").strip():
            return "submitted"
        if attempts >= retries:
            break
        attempts += 1
        clicked = False
        for selector in _values(site, "send"):
            try:
                pane.web_click(tab, selector)
            except pane.PaneError:
                continue
            clicked = True
            log(f"submit: the brief was still in the composer; pressed {selector} (retry {attempts})")
            break
        if not clicked:
            log("submit: the brief is still in the composer and no send selector matched")
            break
        time.sleep(SUBMIT_POLL_SEC)
    state = read_state(tab) or {}
    if len(state.get("turns") or []) > baseline_turns or conversation_url(site, str(state.get("url") or "")):
        return "submitted"
    raise PaneNotReady(
        f"{site.get('label')} never accepted the submit: the brief is still in the composer after "
        f"{attempts} retry(ies). The tab is left open — press send in the pane, then rerun with --tab"
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
    uploads: list[Path] | None = None,
    enforce_model: str | None = None,
    research: bool = False,
    open_url: str | None = None,
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
            opened = pane.web_open(preset, url=open_url, background=True, anchor=pane.anchor_session())
            tab = str(opened["tabId"])
            result.trace.append(f"tab_opened={tab} background={opened.get('background', True)}")
        else:
            result.trace.append(f"tab_reused={tab}")
        result.tab_id = tab
        state = wait_ready(tab, log)
        result.trace.append("ready")
        baseline = str(state.get("lastAssistant") or "")
        if enforce_model:
            report("checking_model", wanted=enforce_model)
            chosen = ensure_model(site, tab, enforce_model, log)
            result.model = chosen["model"]
            result.model_evidence = chosen["evidence"]
            result.trace.append(f"model={chosen['model']} switched={chosen['switched']}")
        if research:
            report("enabling_research")
            deep = ensure_research(site, tab, log)
            result.research = True
            result.trace.append(f"research={deep['evidence']}")
            result.model_evidence = (result.model_evidence + " / " if result.model_evidence else "") + deep["evidence"]
        if uploads:
            report("attaching", files=[path.name for path in uploads])
            attached = attach_uploads(site, tab, uploads, log)
            result.uploads = list(attached["files"])
            result.trace.append(f"uploaded={attached['files']} via={attached['selector']}")
        report("composing")
        baseline_turns = len(state.get("turns") or [])
        pushed = pane.web_push(preset=preset, text_file=prompt_file, send=True, tab=tab)
        sent_at = time.monotonic()
        result.trace.append(f"pushed={pushed if isinstance(pushed, dict) else 'ok'}")
        submitted = confirm_submitted(site, tab, baseline_turns, log)
        result.trace.append(f"submit={submitted}")
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


# Selector groups worth checking against the live DOM, and what a healthy empty
# conversation looks like. `send` and `assistant` are legitimately absent before
# anything is typed, so they are reported but never fail the check.
SELFTEST_GROUPS = ("composer", "send", "assistant", "mode_label", "upload_input", "upload_open")
SELFTEST_REQUIRED = ("composer", "mode_label")
COUNT_GROUPS_JS = """
const groups = __GROUPS__;
const out = {};
for (const [name, selectors] of Object.entries(groups)) {
  let hits = 0, matched = null;
  for (const sel of selectors) {
    let n = 0;
    try { n = document.querySelectorAll(sel).length; } catch (e) { n = -1; }
    if (n > 0 && matched === null) matched = sel;
    if (n > 0) hits += n;
  }
  out[name] = { hits: hits, matched: matched };
}
const label = document.querySelector(__MODE__);
out.__modeLabel = label ? (label.getAttribute("aria-label") || label.innerText || "").trim().slice(0, 120) : "";
return out;
"""


def selftest(site: dict[str, Any], tab: str, log: Log, *, settle_sec: float = UPLOAD_SETTLE_SEC) -> dict[str, Any]:
    """Check engines.json against the service's live DOM without spending a turn.

    This is the only cheap way to catch selector drift: the pytest suite stops at
    the socket, so a service redesign is invisible to it until a real consult
    fails (2026-09-09). Reports every group's hit count, fails on the load-bearing
    ones, and surfaces the model picker's label — Gemini was silently on Flash
    while the docs said Pro.
    """
    groups = {name: _values(site, name) for name in SELFTEST_GROUPS}
    mode_selectors = _values(site, "mode_label")
    counts = pane.web_eval(
        tab,
        _js(COUNT_GROUPS_JS, groups=groups, mode=mode_selectors[0] if mode_selectors else "#__none__"),
    )
    if not isinstance(counts, dict):
        return {"ok": False, "failures": ["selftest script returned no object"], "groups": {}, "model_label": ""}
    model_label = str(counts.pop("__modeLabel", "") or "")
    failures = [
        f"{name}: no selector matched ({groups[name]})"
        for name in SELFTEST_REQUIRED
        if groups.get(name) and int((counts.get(name) or {}).get("hits") or 0) <= 0
    ]
    # The upload input is either mounted at load (ChatGPT / Grok) or appears only
    # after the opener is pressed (Gemini). Pressing the opener proves both halves.
    upload = dict(counts.get("upload_input") or {})
    if groups.get("upload_input") and int(upload.get("hits") or 0) <= 0:
        opened_with = None
        for opener in groups.get("upload_open") or []:
            try:
                pane.web_click(tab, opener)
            except pane.PaneError:
                continue
            opened_with = opener
            break
        if opened_with is None:
            failures.append(f"upload: no file input and no opener matched ({groups.get('upload_open')})")
        else:
            time.sleep(settle_sec)
            selector = _first_present_input(tab, groups["upload_input"], log)
            if selector is None:
                failures.append(f"upload: {opened_with} did not mount any of {groups['upload_input']}")
            else:
                upload = {"hits": 1, "matched": selector, "after_opener": opened_with}
    counts["upload_input"] = upload
    return {"ok": not failures, "failures": failures, "groups": counts, "model_label": model_label}


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
