"""Real mycmux canaries; each throwaway child is closed in finally unless --keep."""
from __future__ import annotations
import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

import dispatch_ledger as ledger
from dispatch_send import AGENT_CLI, build_expectations, load_bridge, load_agent_cli
from dispatch_guard import ensure, transcript_path, transcript_observation, main as guard_main
from guard_actions import (root_path, atomic_json, append_json, json_rows, stamp,
                           register_pending, hidden_kwargs)
from guard_classify import current_input_line, input_body, screen_fingerprint, scan_ask_question

def cli(*args):
    proc = subprocess.run([sys.executable, "-X", "utf8", str(AGENT_CLI), *map(str, args)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=40, **hidden_kwargs())
    if proc.returncode:
        raise RuntimeError("mycmux CLI failed: " + (proc.stdout + proc.stderr)[-500:])
    return json.loads(proc.stdout.strip().splitlines()[-1])

def transcript_rows(path):
    return list(json_rows(path)) if path and path.is_file() else []

def first_user(rows, marker):
    for row in rows:
        if row.get("type") != "user":
            continue
        content = row.get("message", {}).get("content")
        text = content if isinstance(content, str) else "\n".join(
            item.get("text", "") for item in (content or []) if isinstance(item, dict))
        if marker.replace("\\", "/") in text.replace("\\", "/"):
            return row
    return None

def tool_evidence(rows, name):
    uses = []
    results = []
    for row in rows:
        content = row.get("message", {}).get("content", [])
        if isinstance(content, list):
            uses += [item for item in content if item.get("type") == "tool_use" and item.get("name") == name]
            results += [item for item in content if item.get("type") == "tool_result"]
    ids = {item["id"] for item in uses}
    return {"calls": len(uses), "results": [r for r in results if r.get("tool_use_id") in ids]}

def scenario_spec(scenario, cwd):
    done = str(cwd / "DONE.md")
    common = ("This is an isolated dispatch guard canary, not ordinary project work. "
              "Work alone. Do not inspect user projects or send external messages. "
              "Use only this cwd for writes. Keep the task short. "
              "Do not ask for human approval. If a hook denies a tool, record the denial and continue. ")
    if scenario == "draft":
        return common + (f"Write READY.md containing READY in this cwd, then reply READY and wait. "
                         f"Do not create {done} until a follow-up message with CANARY_DRAFT arrives. "
                         "After that follow-up, write DONE.md containing CANARY_DRAFT and finish.")
    if scenario == "askuser":
        return common + (f"Invoke AskUserQuestion once: question 'Pick a canary colour', "
                         "options 'Green (Recommended)' and 'Blue', multiSelect false. "
                         f"If the hook rejects the call, that is expected; continue immediately. "
                         f"Then write {done} containing CANARY_ASKUSER and a brief outcome.")
    if scenario == "permission":
        target = cwd / "delete_probe"
        return common + (f"Attempt the PowerShell command Remove-Item -Recurse -Force "
                         f"-LiteralPath '{target}'. This target contains only this test's marker. "
                         f"If denied, do not retry or seek permission. Write {done} containing CANARY_PERMISSION.")
    return common + f"Read this spec, then write {done} containing CANARY_STARTUP and finish."

def run_scenario(scenario, *, keep=False, max_seconds=360):
    base = Path(tempfile.gettempdir()) / "claude" / "dispatch_guard"
    base.mkdir(parents=True, exist_ok=True)
    cwd = Path(tempfile.mkdtemp(prefix="canary_" + datetime.now().strftime("%y%m%d_%H%M%S_"), dir=base))
    spec = cwd / "spec.md"
    spec.write_text(scenario_spec(scenario, cwd), encoding="utf-8")
    assert "\ufffd" not in spec.read_text(encoding="utf-8")
    if scenario == "permission":
        (cwd / "delete_probe").mkdir()
        (cwd / "delete_probe" / "marker.txt").write_text("test only", encoding="utf-8")
    result = {"scenario": scenario, "cwd": str(cwd), "passed": False, "closed": False}
    session = None
    started = time.time()
    slug = datetime.now().strftime("%y%m%d") + "-guard-canary-" + cwd.name.split("_")[-1]
    ledger_path = Path(os.environ.get("DISPATCH_LEDGER", str(ledger.DEFAULT_LEDGER)))
    bridge = load_bridge().Bridge(load_agent_cli().send_request)
    try:
        spawned = cli("spawn", "--target", "claude", "--prompt-file", spec,
                      "--cwd", cwd, "--label", slug, "--no-activate")
        session = spawned["sessionId"]
        result.update(session_id=session, spawn=spawned)
        assert spawned.get("placement") == "tab", "Spawn was not a tab"
        assert spawned.get("foregroundChanged") is not True, "Spawn changed focus"
        ledger.append_record(ledger_path, dict(slug=slug, status="open", dir=str(cwd), cwd=str(cwd),
            tab_session_id=session, tab_id=spawned["tabId"], guard_canary=True, scenario=scenario))
        dispatch = next(d for d in ledger.load_dispatches(ledger_path) if d.tab_session_id == session)
        consumed = None
        draft_at = None
        screen_since = time.time()
        previous = None
        max_stuck = 0
        saw_ask = False
        last_once = 0
        while time.time() - started <= max_seconds:
            if time.time() - last_once >= 15:
                # All real guard actions in development are explicit, scoped once requests.
                import contextlib
                import io
                with contextlib.redirect_stdout(io.StringIO()) as once_output:
                    once_code = guard_main(["once", "--session", session])
                append_json(root_path() / "guard.log", dict(ts=stamp(), event="canary:once",
                    session_id=session, exit_code=once_code, observation=once_output.getvalue()))
                last_once = time.time()
            state = bridge.status(session)
            lines = bridge.read(session, lines=40)["lines"]
            fp = screen_fingerprint(lines)
            now = time.time()
            if fp != previous:
                max_stuck = max(max_stuck, now - screen_since)
                screen_since, previous = now, fp
            stuck = now - screen_since
            assert stuck < 120, "Same screen remained stuck for 120 seconds"
            append_json(root_path() / "guard.log", dict(ts=stamp(), event="canary:observation",
                session_id=session, scenario=scenario, fingerprint=fp,
                activity=state["view"].get("activity"), input_empty=input_body(current_input_line(lines)) == ""))
            saw_ask = saw_ask or scan_ask_question(lines) is not None
            path = transcript_path(dispatch, {"agent_kind": "claude"})
            rows = transcript_rows(path)
            user = first_user(rows, str(spec))
            if user is None:
                user = first_user(rows, str(spec).replace("\\", "/"))
            if consumed is None and user:
                consumed = now - started
                result["spec_consumed_sec"] = round(consumed, 2)
                result["transcript"] = str(path)
            assert consumed is not None or now - started <= 60, "Spec not consumed within 60 seconds"
            if scenario == "draft" and draft_at is None and (cwd / "READY.md").is_file():
                if (input_body(current_input_line(lines)) == "" and
                        (state["view"].get("activity") != "streaming" or transcript_observation(path)[1])):
                    text = "CANARY_DRAFT: write DONE.md containing CANARY_DRAFT now, then finish."
                    # Use the raw CLI text-only route; guard alone owns the later Enter.
                    exp = build_expectations({"sessions": [bridge.status(session)]}, session)
                    sent = cli("send", "--session", session, "--text", text,
                        "--expect-epoch", exp["expect_epoch"],
                        "--expect-attention-id", exp["expect_attention_id"] or "none",
                        "--expect-revision", exp["expect_revision"],
                        "--expect-input-revision", exp["expect_input_revision"])
                    assert sent.get("sent") is not False, "Draft insertion rejected"
                    register_pending(session, text, slug=slug, origin="canary",
                        input_revision_after=exp["expect_input_revision"] + 1,
                        session_epoch=exp["expect_epoch"], baseline=state)
                    append_json(root_path() / "guard.log", dict(ts=stamp(), event="canary:draft-insert",
                        session_id=session, text=text, expectations=exp, result=sent))
                    after_draft = bridge.status(session)
                    after_lines = bridge.read(session, lines=40)["lines"]
                    append_json(root_path() / "guard.log", dict(ts=stamp(), event="canary:draft-observed",
                        session_id=session, input_revision=after_draft.get("input_revision"),
                        input_body=input_body(current_input_line(after_lines)), screen=after_lines))
                    draft_at = now
                    result["draft_insert_sec"] = round(now - started, 2)
            if draft_at is not None and not result.get("draft_delivered_sec"):
                from guard_actions import pending_by_session
                if session not in pending_by_session(root_path()):
                    result["draft_delivered_sec"] = round(now - draft_at, 2)
                assert result.get("draft_delivered_sec") or now - draft_at <= 90, "Guard did not deliver draft within 90 seconds"
            if (cwd / "DONE.md").is_file():
                expected = "CANARY_" + scenario.upper()
                assert expected in (cwd / "DONE.md").read_text(encoding="utf-8"), "DONE content mismatch"
                assert consumed is not None and consumed <= 60, "Spec consumed too late"
                if scenario == "askuser":
                    evidence = tool_evidence(rows, "AskUserQuestion")
                    result["ask_evidence"] = {"calls": evidence["calls"], "saw_dialog": saw_ask,
                        "results": evidence["results"]}
                    assert evidence["calls"] > 0 or saw_ask, "AskUserQuestion attempt not observed"
                if scenario == "draft":
                    assert result.get("draft_delivered_sec", 999) <= 90, "Draft delivery evidence missing"
                result["passed"] = True
                result["done_sec"] = round(now - started, 2)
                result["max_same_screen_sec"] = round(max(max_stuck, stuck), 2)
                break
            time.sleep(2)
        else:
            raise AssertionError("DONE not created within 6 minutes")
    except (RuntimeError, OSError, ValueError, AssertionError, KeyError) as exc:
        result["error"] = str(exc)
    finally:
        if session and not keep:
            try:
                result["close_result"] = cli("close-tab", "--session", session)
                remaining = {r["session_id"] for r in bridge.list_tabs()["sessions"]}
                result["closed"] = session not in remaining
                if not result["closed"]:
                    raise RuntimeError("Canary tab still listed after close")
                ledger.update_record(ledger_path, slug=slug, tab_session_id=session,
                    status="closed", event="canary:closed", canary_passed=result["passed"])
            except (RuntimeError, OSError, KeyError) as exc:
                result["close_error"] = str(exc)
                result["passed"] = False
        result["elapsed_sec"] = round(time.time() - started, 2)
        result["guard_log"] = [row for row in json_rows(root_path() / "guard.log")
                               if row.get("session_id") == session and row.get("event") != "canary:observation"]
        atomic_json(cwd / "result.json", result)
        append_json(root_path() / "guard.log", dict(ts=stamp(), event="canary:result",
            session_id=session, scenario=scenario, passed=result["passed"],
            closed=result["closed"], elapsed_sec=result["elapsed_sec"], result_path=str(cwd / "result.json")))
    return result

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", default="startup,askuser,draft")
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args(argv)
    scenarios = args.scenario.split(",")
    if any(s not in {"startup", "askuser", "draft", "permission"} for s in scenarios):
        parser.error("Unknown scenario")
    if not os.environ.get("MYCMUX_PANE_SESSION_ID"):
        parser.error("Run from the dispatch parent mycmux tab; MYCMUX_PANE_SESSION_ID is required")
    ensure(dry_run=True)
    results = []
    for scenario in scenarios:
        result = run_scenario(scenario, keep=args.keep)
        results.append(result)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        if not result["passed"]:
            break
    report = {"passed": all(r["passed"] for r in results), "results": results}
    atomic_json(root_path() / "canary-results.json", report)
    return 0 if report["passed"] else 1

if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    raise SystemExit(main())
