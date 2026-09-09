"""Singleton dispatch supervisor: ensure | run | once | stop | doctor."""
from __future__ import annotations
import argparse
from collections import Counter
from dataclasses import asdict
from datetime import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import dispatch_ledger as ledger
import dispatch_status
from dispatch_send import load_bridge, load_agent_cli
from guard_classify import Observation, Verdict, classify, current_input_line, input_body, screen_fingerprint, pending_matches
from guard_actions import (Actions, root_path, read_json, atomic_json, append_json, stamp,
                           json_rows, pending_by_session, resolve_pending, hidden_kwargs, OPS, append_json_capped)

AGENTS = {"claude", "codex", "grok"}

#: Actions that cannot change anything by being repeated. Re-running them only
#: re-writes audit rows: the escalation itself is deduplicated for 30 minutes
#: inside Actions.escalate, and mark_lost has already moved the ledger row.
#: Before this gate one dead-but-listed tab produced 2 audit rows every 15 s
#: forever -- 782 repeats for a single session on 2026-09-09.
TERMINAL_ACTIONS = {"mark_lost", "escalate", "block"}
#: Kept in step with the escalation dedup window so a session that is still
#: stuck is re-reported on the documented 30 minute cadence, not every cycle.
TERMINAL_TTL_SEC = 1800

class Singleton:
    """Readable PID lease. A short claim lock serializes writers, never guard.lock readers."""
    def __init__(self, root):
        self.root = Path(root)
        self.path = self.root / "guard.lock"
        self.token = None

    def acquire(self):
        import uuid
        self.root.mkdir(parents=True, exist_ok=True)
        # This lock is held for milliseconds during lease creation only.
        with (self.root / "guard.claim").open("a+b") as claim:
            if claim.seek(0, 2) == 0:
                claim.write(b" ")
                claim.flush()
            claim.seek(0)
            try:
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(claim.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(claim.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                return False
            if held(self.root):
                return False
            self.token = uuid.uuid4().hex
            atomic_json(self.path, {"pid": os.getpid(), "started_at": stamp(),
                "started_epoch": time.time(), "token": self.token})
            return True

    def owns(self):
        return lock_info(self.root).get("token") == self.token

    def close(self):
        if self.token and self.owns():
            info = lock_info(self.root)
            info["stopped_at"] = stamp()
            atomic_json(self.path, info)
        self.token = None

def lock_info(root):
    return read_json(Path(root) / "guard.lock", {}) or {}

def process_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        code = wintypes.DWORD()
        try:
            return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True

def held(root):
    info = lock_info(root)
    if info.get("stopped_at") or not process_alive(info.get("pid")):
        return False
    state = read_json(Path(root) / "state.json", {}) or {}
    updated = state.get("cycle_epoch") if state.get("lease_token") == info.get("token") else None
    return time.time() - (updated or info.get("started_epoch", 0)) <= 30

def doctor(root=None):
    root = Path(root or root_path())
    info = lock_info(root)
    state = read_json(root / "state.json", {}) or {}
    return {"alive": held(root) and process_alive(info.get("pid")), "pid": info.get("pid"),
            "last_cycle_at": state.get("last_cycle_at"), "targets": state.get("targets", {}),
            "verdict_counts": state.get("verdict_counts", {}),
            "escalations_24h": sum(r.get("at", 0) > time.time() - 86400
                                  for r in json_rows(root / "escalations.jsonl")),
            "input_scope": state.get("input_scope", "all"), "dry_run": state.get("dry_run", False),
            "cycle_duration_sec": state.get("cycle_duration_sec"), "last_once": state.get("last_once")}

def ensure(root=None, *, input_scope=None, dry_run=None, wait_sec=25):
    root = Path(root or root_path())
    if held(root):
        return {"alive": True, "pid": lock_info(root).get("pid"), "started": False}
    root.mkdir(parents=True, exist_ok=True)
    scope = input_scope or os.environ.get("DISPATCH_GUARD_INPUT_SCOPE", "all")
    if dry_run is None:
        dry_run = os.environ.get("DISPATCH_GUARD_DRY_RUN") == "1"
    env = dict(os.environ, DISPATCH_GUARD_DIR=str(root), PYTHONUTF8="1")
    with (root / "guard.log").open("ab") as output:
        proc = subprocess.Popen([sys.executable, "-X", "utf8", str(Path(__file__).resolve()),
            "run", "--input-scope", scope, *(["--dry-run"] if dry_run else [])], stdin=subprocess.DEVNULL,
            stdout=output, stderr=output, env=env, **hidden_kwargs())
    deadline = time.monotonic() + wait_sec
    while time.monotonic() < deadline:
        info = lock_info(root)
        state = read_json(root / "state.json", {}) or {}
        if held(root) and state.get("pid") == info.get("pid") and state.get("last_cycle_at"):
            return {"alive": True, "pid": info.get("pid"), "started": True}
        if proc.poll() is not None:
            break
        time.sleep(0.2)
    return {"alive": held(root), "pid": lock_info(root).get("pid"),
            "started": True, "warning": "First cycle not yet observed"}

def pending_asks():
    try:
        result = subprocess.run([sys.executable, "-X", "utf8", str(OPS), "list", "--asks"],
            capture_output=True, text=True, encoding="utf-8", timeout=10, **hidden_kwargs())
        if result.returncode:
            return None
        return {cols[2] for line in result.stdout.splitlines()[1:]
                if len(cols := line.split("\t")) >= 3 and cols[1] == "pending"}
    except (OSError, subprocess.TimeoutExpired):
        return None

def transcript_path(dispatch, tab=None):
    if dispatch is None:
        return None
    kind = (tab or {}).get("agent_kind", "claude")
    if kind == "codex":
        # Exact provider UUID and cwd from the first metadata row, never newest-file substitution.
        sid = dispatch.get("codex_session_id") or (tab or {}).get("agent_session_id")
        if not sid:
            return None
        for path in (Path.home() / ".codex" / "sessions").glob(f"*/*/*/rollout-*{sid}.jsonl"):
            try:
                with path.open(encoding="utf-8") as stream:
                    meta = json.loads(stream.readline()).get("payload", {})
                if (meta.get("id") == sid and os.path.normcase(os.path.normpath(meta.get("cwd", ""))) ==
                        os.path.normcase(os.path.normpath(str(dispatch.get("cwd") or "")))):
                    return path
            except (OSError, ValueError):
                continue
        return None
    directory = dispatch_status.project_dir(str(dispatch.get("cwd") or ""))
    sid, _ = dispatch_status.resolve_child_session_id(dispatch, pin=False)
    return directory / (sid + ".jsonl") if directory and sid else None

def transcript_observation(path):
    """Read at most 64 KiB from this exact child's log; no newest-file substitution."""
    if not path or not path.is_file():
        return None, False
    age = max(0, time.time() - path.stat().st_mtime)
    with path.open("rb") as stream:
        size = stream.seek(0, 2)
        stream.seek(max(0, size - 65536))
        raw = stream.read(65536).decode("utf-8", errors="replace")
    relevant = []
    for line in raw.splitlines():
        try:
            row = json.loads(line)
            if row.get("type") in {"assistant", "user"}:
                relevant.append(row)
        except ValueError:
            continue
    ended = bool(relevant and relevant[-1].get("type") == "assistant" and
                 relevant[-1].get("message", {}).get("stop_reason") == "end_turn")
    return age, ended


class Guard:
    def __init__(self, bridge, *, root=None, ledger_path=ledger.DEFAULT_LEDGER,
                 input_scope="all", dry_run=False, actions=None, now=time.time, asks=pending_asks):
        self.bridge = bridge
        self.root = Path(root or root_path())
        self.ledger_path = Path(ledger_path)
        self.input_scope = input_scope
        self.dry_run = dry_run
        self.now, self.asks = now, asks
        self.actions = actions or Actions(bridge, root=self.root, ledger_path=self.ledger_path,
                                         input_scope=input_scope, now=now)
        self.state = read_json(self.root / "state.json", {}) or {}
        self.state.setdefault("targets", {})

    def cycle(self, session=None, *, operate_once=False):
        cycle_start = time.monotonic()
        now = self.now()
        dry_run = self.dry_run and not operate_once
        self.actions.begin_cycle()
        # A failed inventory is NOT an empty inventory: propagate for outage retry.
        original_registry = getattr(self.bridge, "_registry", None)
        if original_registry:
            registry = original_registry()
            self.bridge._registry = lambda: registry
        try:
            inventory = self.bridge.list_tabs()
        finally:
            if original_registry:
                self.bridge._registry = original_registry
        if not isinstance(inventory, dict) or not isinstance(inventory.get("sessions"), list):
            raise RuntimeError("Invalid bridge inventory")
        all_tabs = {r["session_id"]: r for r in inventory["sessions"]}
        children = {d.tab_session_id: d for d in ledger.load_dispatches(self.ledger_path)
                    if d.status in ledger.ACTIVE_STATUSES and d.tab_session_id}
        targets = {sid for sid, tab in all_tabs.items() if tab.get("agent_kind") in AGENTS} | set(children)
        if session:
            targets &= {session}
        pending = pending_by_session(self.root)
        asks = set() if dry_run else self.asks()
        # Only tabs actually seen alive after monitoring started generate disappearance alerts.
        seen_alive = set(self.state.get("seen_alive_sessions", []))
        if "initial_alive_sessions" not in self.state:
            self.state["initial_alive_sessions"] = sorted(sid for sid, t in all_tabs.items()
                                                         if t.get("lifecycle", "alive") == "alive")
        seen_alive.update(sid for sid, t in all_tabs.items() if t.get("lifecycle", "alive") == "alive")
        records = dict(self.state["targets"]) if session else {}
        for sid in sorted(targets):
            tab, child = all_tabs.get(sid), children.get(sid)
            old = self.state["targets"].get(sid, {})
            counters = dict(old.get("counters", {}))
            obs = Observation(is_dispatch_child=child is not None, slug=child.slug if child else None,
                              counters=counters, present=tab is not None)
            if not tab:
                counters["missing"] = counters.get("missing", 0) + 1
            else:
                counters["missing"] = 0
                obs.agent_kind = tab.get("agent_kind", "claude")
                try:
                    if original_registry:
                        self.bridge._registry = lambda: registry
                    try:
                        canonical = self.bridge.status(sid)
                        lines = self.bridge.read(sid, lines=40)["lines"][-40:]
                    finally:
                        if original_registry:
                            self.bridge._registry = original_registry
                except (RuntimeError, OSError):
                    if tab.get("lifecycle") in {"exited", "orphaned", "closed"}:
                        canonical = {"input_revision": None,
                                     "view": {"lifecycle": tab["lifecycle"], "attention": {"kind": "none"}}}
                        lines = []
                    else:
                        records[sid] = {**old, "observed_at": stamp(), "error": "status/read unavailable"}
                        continue
                obs.state_view = dict(canonical["view"], input_revision=canonical.get("input_revision"))
                obs.screen_lines = lines
                obs.input_line = current_input_line(lines)
                fp = screen_fingerprint(lines)
                obs.screen_changed = fp != old.get("fingerprint")
                same_epoch = canonical["view"].get("session_epoch") == old.get("session_epoch")
                if not same_epoch:
                    counters.clear()
                    old = {k: v for k, v in old.items() if k != "terminal"}
                unchanged_since = old.get("unchanged_since", now) if not obs.screen_changed and same_epoch else now
                obs.unchanged_s = max(0, now - unchanged_since)
                revision = canonical.get("input_revision")
                active = canonical["view"].get("activity") == "streaming"
                idle_since = old.get("idle_since", now)
                # Screen chrome can move without indicating activity; input and transcript govern drafts.
                if revision != old.get("input_revision") or not same_epoch:
                    idle_since = now
                obs.pending_send = pending.get(sid)
                if child:
                    activity = dispatch_status.dispatch_activity(child, pin=False, ledger=self.ledger_path)
                    if activity.age_min >= 0:
                        obs.transcript_age_s = activity.age_min * 60
                    path = transcript_path(child, tab)
                    if path and path.is_file():
                        obs.transcript_age_s, obs.turn_ended = transcript_observation(path)
                    if active and not obs.turn_ended:
                        idle_since = now
                    obs.done_exists = bool(child.get("dir")) and (Path(child.get("dir")) / "DONE.md").is_file()
                    # On alert service failure fail closed for idle nudges.
                    obs.pending_ask = asks is None or sid in asks
                if (obs.pending_send and (not active or obs.turn_ended) and
                        pending_matches(input_body(obs.input_line), obs.pending_send,
                                        revision, canonical["view"].get("session_epoch"))):
                    sent_at = obs.pending_send.get("created_at")
                    if isinstance(sent_at, (int, float)) and sent_at <= now:
                        idle_since = min(idle_since, sent_at)
                obs.idle_since_s = max(0, now - idle_since)
                counters["idle_no_done_age_s"] = now - old.get("last_nudge_at", 0)
                if obs.pending_send and input_body(obs.input_line) == "":
                    baseline = obs.pending_send.get("baseline")
                    if baseline and load_bridge().state_transition_signature(canonical) != load_bridge().state_transition_signature(baseline):
                        resolve_pending(self.root, obs.pending_send, "empty_input_and_transition")
                        obs.pending_send = None
                old = {**old, "fingerprint": fp, "unchanged_since": unchanged_since,
                       "idle_since": idle_since, "input_revision": revision,
                       "session_epoch": canonical["view"].get("session_epoch")}
            verdict = classify(obs)
            if (old.get("result", {}).get("instruction_pending") and
                    input_body(obs.input_line) == "" and
                    verdict.cls in {"ok_waiting", "idle_no_done", "unknown", "ok_working"}):
                verdict = Verdict("permission_prompt", "permission_instruction",
                                  "Continue after the observed denial", [], {})
            if not tab and sid not in seen_alive:
                verdict = Verdict("tab_gone", "mark_lost", "Initial ledger reconciliation", [], {})
            terminal = old.get("terminal")
            settled = (terminal is not None
                       and terminal.get("cls") == verdict.cls
                       and terminal.get("action") == verdict.action
                       and now - terminal.get("at", 0) < TERMINAL_TTL_SEC)
            if dry_run:
                result = {"action": verdict.action, "dry_run": True}
            elif settled:
                result = {"action": verdict.action, "suppressed": "terminal"}
            elif verdict.action == "mark_lost" and not tab and sid not in seen_alive:
                self.actions.session, self.actions.dispatch = sid, child
                if child:
                    ledger.update_record(self.ledger_path, slug=child.slug, spawn_ts=child.spawn_ts,
                        tab_session_id=sid, status="lost", event="guard:reconcile", silent=True)
                result = {"reconciled": True, "silent": True, "alerts": 0}
                self.actions.audit("guard:reconcile", silent=True)
            else:
                if operate_once and (not child or not child.get("guard_canary")) and self.dry_run:
                    result = {"action": verdict.action, "suppressed": "dry_run_requires_canary"}
                else:
                    result = self.actions.execute(sid, verdict, obs, child)
            if verdict.action not in {"none", "escalate", "block", "mark_lost"} and not result.get("suppressed") and not dry_run:
                counters[verdict.cls] = counters.get(verdict.cls, 0) + 1
                if verdict.action == "nudge":
                    old["last_nudge_at"] = now
            if verdict.action in TERMINAL_ACTIONS and not dry_run and not result.get("suppressed"):
                old["terminal"] = {"cls": verdict.cls, "action": verdict.action, "at": now}
            records[sid] = {**old, "slug": obs.slug, "agent_kind": obs.agent_kind,
                "observed_at": stamp(), "verdict": asdict(verdict), "result": result,
                "counters": counters, "present": obs.present}
        alerts = {"cards": 0, "events": 0} if dry_run else self.actions.flush_escalations()
        current = read_json(self.root / "state.json", {}) or {}
        self.state.update(pid=os.getpid(), last_cycle_at=stamp(), cycle_epoch=now,
                          input_scope=self.input_scope, dry_run=self.dry_run, targets=records,
                          seen_alive_sessions=sorted(seen_alive), alerts=alerts,
                          cycle_duration_sec=round(time.monotonic() - cycle_start, 3),
                          verdict_counts=dict(Counter(r.get("verdict", {}).get("cls", "unavailable")
                                                      for r in records.values())),
                          stop_requested=current.get("stop_requested", False))
        if not self.actions.lease_check():
            raise RuntimeError("Lease changed; old supervisor must not commit state")
        atomic_json(self.root / "state.json", self.state)
        append_json(self.root / "guard.log", dict(ts=stamp(), event="guard:cycle",
                    targets=len(records), verdict_counts=self.state["verdict_counts"]))
        return self.state

def run(args):
    root = root_path()
    lock = Singleton(root)
    if not lock.acquire():
        return 0
    try:
        state = read_json(root / "state.json", {}) or {}
        state.update(stop_requested=False, pid=os.getpid(), last_cycle_at=None,
                     lease_token=lock.token, cycle_epoch=time.time())
        atomic_json(root / "state.json", state)
        cli = load_agent_cli()
        bridge = load_bridge().Bridge(cli.send_request)
        guard = Guard(bridge, input_scope=args.input_scope, dry_run=args.dry_run, ledger_path=Path(
            os.environ.get("DISPATCH_LEDGER", str(ledger.DEFAULT_LEDGER))))
        guard.actions.lease_check = lock.owns
        outage_since = None
        while True:
            if not lock.owns():
                return 0
            if (read_json(root / "state.json", {}) or {}).get("stop_requested"):
                return 0
            start = time.monotonic()
            try:
                requests = list(json_rows(root / "once_requests.jsonl"))
                last_id = guard.state.get("last_once", {}).get("id")
                unhandled = requests
                if last_id:
                    indexes = [i for i, row in enumerate(requests) if row.get("id") == last_id]
                    if indexes:
                        unhandled = requests[indexes[-1] + 1:]
                request = unhandled[0] if unhandled else None
                guard.cycle(args.session if args.command == "once" else request.get("session") if request else None,
                            operate_once=(bool(request) and not request.get("dry_run")) or
                                         (args.command == "once" and not args.dry_run))
                if request:
                    guard.state["last_once"] = dict(request, completed_at=stamp())
                    atomic_json(root / "state.json", guard.state)
                outage_since = None
                delay = max(0.1, args.poll_sec - (time.monotonic() - start))
            except (RuntimeError, OSError) as exc:
                outage_since = start if outage_since is None else outage_since
                append_json(root / "guard.log", dict(ts=stamp(), event="guard:socket-unavailable",
                                                    error=type(exc).__name__))
                if args.command == "once" or time.monotonic() - outage_since >= 300:
                    append_json(root / "guard.log", dict(ts=stamp(), event="guard:outage-exit"))
                    return 3
                delay = 60
            if args.command == "once":
                print(json.dumps(guard.state, ensure_ascii=False))
                return 0
            until = time.monotonic() + delay
            while time.monotonic() < until:
                if not lock.owns():
                    return 0
                if (read_json(root / "state.json", {}) or {}).get("stop_requested"):
                    return 0
                latest_requests = list(json_rows(root / "once_requests.jsonl"))
                if latest_requests and latest_requests[-1].get("id") != guard.state.get("last_once", {}).get("id"):
                    break
                time.sleep(min(0.5, max(0, until - time.monotonic())))
    finally:
        lock.close()

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("ensure", "run", "once", "stop", "doctor"))
    parser.add_argument("--session")
    parser.add_argument("--dry-run", action="store_true",
                        default=os.environ.get("DISPATCH_GUARD_DRY_RUN") == "1")
    parser.add_argument("--poll-sec", type=float, default=15)
    parser.add_argument("--input-scope", choices=("all", "canary"),
                        default=os.environ.get("DISPATCH_GUARD_INPUT_SCOPE", "all"))
    args = parser.parse_args(argv)
    if args.poll_sec <= 0:
        parser.error("--poll-sec must be positive")
    if args.command == "doctor":
        result = doctor()
    elif args.command == "ensure":
        result = ensure(input_scope=args.input_scope, dry_run=args.dry_run)
    elif args.command == "stop":
        path = root_path() / "state.json"
        result = read_json(path, {}) or {}
        result["stop_requested"] = True
        atomic_json(path, result)
        result = {"stop_requested": True, "pid": lock_info(root_path()).get("pid")}
    elif args.command == "once" and held(root_path()):
        if not args.session:
            parser.error("once with a running guard requires --session")
        import uuid
        request = {"id": uuid.uuid4().hex, "session": args.session,
                   "requested_at": stamp(), "dry_run": args.dry_run}
        append_json_capped(root_path() / "once_requests.jsonl", request)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            state = read_json(root_path() / "state.json", {}) or {}
            if state.get("last_once", {}).get("id") == request["id"]:
                print(json.dumps({"request": state["last_once"],
                    "target": state.get("targets", {}).get(args.session)}, ensure_ascii=False))
                return 0
            time.sleep(0.2)
        print(json.dumps({"queued": True, "request": request, "warning": "Cycle not observed yet"}))
        return 2
    else:
        return run(args)
    print(json.dumps(result, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    raise SystemExit(main())
