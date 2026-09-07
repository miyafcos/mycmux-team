#!/usr/bin/env python3
"""Deterministic bridge between Claude Code and the mycmux PTY registry."""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
from typing import Any, Sequence

MAX_READ_LINES = 400


def _load_support():
    path = Path(__file__).with_name("mycmux_bridge_support.py")
    spec = importlib.util.spec_from_file_location("mycmux_bridge_support", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load mycmux bridge support")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_support = _load_support()
BridgeBase = _support.BridgeBase
BridgeError = _support.BridgeError
DEFAULT_OBSERVATIONS = _support.DEFAULT_OBSERVATIONS
DEFAULT_POLL_SECONDS = _support.DEFAULT_POLL_SECONDS
AGENT_KINDS = _support.AGENT_KINDS
RESULT_KINDS = _support.RESULT_KINDS
accepted_write = _support.accepted_write
confirmed_key_write = _support.confirmed_key_write
draft_visible = _support.draft_visible
current_input_line = _support.current_input_line
screen_fingerprint = _support.screen_fingerprint
state_transition_signature = _support.state_transition_signature
scan_ask_question = _support.scan_ask_question

def transport_error(_exc: BaseException) -> str:
    """Do not reflect socket errors because a peer may include authentication data."""
    return "mycmux request failed"

def resolve_agent_cli() -> Path:
    import os
    import sys
    explicit = os.environ.get("MYCMUX_AGENT_CLI")
    candidates = [Path(explicit).expanduser()] if explicit else []
    candidates.append(Path.home() / ".mycmux" / "bin" / "mycmux_agent_cli.py")
    candidates.extend(parent / "scripts" / "mycmux_agent_cli.py"
                      for parent in Path(__file__).resolve().parents)
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    print("mycmux agent CLI not found. From the mycmux checkout run: "
          "python scripts/install_claude_skills.py install", file=sys.stderr)
    raise SystemExit(7)

def load_agent_cli(repo: Path):
    path = repo  # already resolved CLI file
    spec = importlib.util.spec_from_file_location("mycmux_agent_cli_bridge", path)
    if spec is None or spec.loader is None:
        raise BridgeError("verification_unavailable", f"cannot load mycmux agent CLI: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
class Bridge(BridgeBase):
    def list_tabs(self) -> dict[str, Any]:
        registry = self._registry()
        state_by_session = self._state_map(self.request("session.state_view", {}), strict=False)
        sessions: list[dict[str, Any]] = []
        for item in registry:
            session_id = item["session_id"]
            state = state_by_session.get(session_id)
            view = state.get("view") if state else None
            view = view if isinstance(view, dict) else {}
            attention = view.get("attention")
            attention = attention if isinstance(attention, dict) else {}
            send_status, send_reason = "candidate", ""
            if item["tab_type"] != "terminal" or view.get("lifecycle") in {"closed", "exited"}:
                send_status, send_reason = "not_applicable", "target is not a live PTY terminal"
            elif state is None:
                send_status, send_reason = "unavailable", "canonical state is unavailable"
            else:
                try:
                    self._ensure_sendable(state, attention.get("kind"))
                    self._send_args(session_id, text="", state=state)
                except BridgeError as exc:
                    send_status, send_reason = "unavailable", str(exc)
            sessions.append(
                {
                    "source": "mycmux",
                    "workspace": {
                        "id": item["workspace_id"],
                        "name": item["workspace_name"],
                    },
                    "pane": {"id": item["pane_id"], "label": item["pane_label"]},
                    "tab": {"id": item["tab_id"], "type": item["tab_type"]},
                    "session_id": session_id,
                    "label": item["label"],
                    "agent_kind": item["agent_kind"],
                    "agent_id": item["agent_id"],
                    "agent_session_id": item["agent_session_id"],
                    "claude_session_id": item["claude_session_id"],
                    "lifecycle": view.get("lifecycle", item["tab_lifecycle"]),
                    "activity": view.get("activity", "unknown"),
                    "attention": attention.get("kind", "none"),
                    "attention_id": attention.get("attention_id"),
                    "health": view.get("health", "stale"),
                    "input_revision": state.get("input_revision") if state else None,
                    "send_status": send_status,
                    "send_reason": send_reason,
                    "ui_state": state.get("ui_state", "unknown") if state else "unknown",
                }
            )
        return {"source": "mycmux", "sessions": sessions}
    def read(self, session_id: str, lines: int = MAX_READ_LINES) -> dict[str, Any]:
        self._exact_registry_entry(session_id)
        requested_lines = max(1, min(MAX_READ_LINES, lines))
        result = self.request("pane.read", {"sessionId": session_id, "lines": requested_lines})
        if not isinstance(result, dict) or result.get("sessionId") != session_id:
            raise BridgeError("verification_unavailable", "pane.read returned an invalid schema")
        screen_lines = result.get("lines")
        if not isinstance(screen_lines, list) or any(not isinstance(line, str) for line in screen_lines):
            raise BridgeError("verification_unavailable", "pane.read returned invalid screen lines")
        if len(screen_lines) > MAX_READ_LINES:
            raise BridgeError("verification_unavailable", "pane.read exceeded the 400-line contract")
        return {
            "source": "mycmux",
            "session_id": session_id,
            "lines": screen_lines,
            "metadata": {
                "kind": "logical_screen_snapshot",
                "transcript": False,
                "max_lines": MAX_READ_LINES,
            },
        }
    def status(self, session_id: str) -> dict[str, Any]:
        self._exact_registry_entry(session_id)
        return self._status_entry(session_id)
    def resolve_target(self, *, session_id: str | None, target: str | None) -> str:
        registry = [item for item in self._registry() if item["tab_type"] == "terminal"]
        if bool(session_id) == bool(target):
            raise BridgeError("stale_target", "specify exactly one of session_id or target")
        if session_id:
            matches = [item for item in registry if item["session_id"] == session_id]
        else:
            assert target is not None
            matches = [item for item in registry if target in item["selectors"]]
        if len(matches) != 1:
            raise BridgeError(
                "stale_target",
                f"target must resolve to exactly one PTY session; matched {len(matches)}",
            )
        return matches[0]["session_id"]
    def send(
        self,
        text: str,
        *,
        session_id: str | None = None,
        target: str | None = None,
        expected_attention: str = "none",
        expected_state: dict[str, Any] | None = None,
        enter_only: bool = False,
    ) -> dict[str, Any]:
        if not text and not enter_only:
            raise BridgeError("write_failed", "send requires non-empty text")
        resolved = self.resolve_target(session_id=session_id, target=target)
        enter_sent = False

        def send_result(kind: str, detail: str) -> dict[str, Any]:
            return {**self._result(kind, resolved, detail), "enter_sent": enter_sent}

        initial_state = self._status_entry(resolved)
        if expected_state is not None:
            self._ensure_same_target(expected_state, initial_state)
            self._ensure_input_revision(initial_state, self._input_revision(expected_state))
        self._ensure_sendable(initial_state, expected_attention)
        initial_screen = self.read(resolved)["lines"]
        initial_fingerprint = screen_fingerprint(initial_screen)
        current_state = self._status_entry(resolved)
        try:
            self._ensure_same_target(initial_state, current_state)
            self._ensure_input_revision(current_state, self._input_revision(initial_state))
            self._ensure_sendable(current_state, expected_attention)
        except BridgeError as exc:
            return send_result(exc.kind, str(exc))
        current_screen = self.read(resolved)["lines"]
        if screen_fingerprint(current_screen) != initial_fingerprint:
            return send_result("prompt_changed", "screen changed before text send")
        expected_enter_input_revision = self._input_revision(current_state)
        draft_state = current_state
        draft_fingerprint = initial_fingerprint
        if text:
            try:
                write_result = self.request(
                    "pane.send_text",
                    self._send_args(resolved, text=text, state=current_state),
                )
            except (RuntimeError, OSError) as exc:
                return send_result("write_failed", transport_error(exc))
            if not accepted_write(write_result):
                return send_result("write_failed", "text write was rejected")
            expected_enter_input_revision = self._input_revision(current_state) + 1
            draft_lines: list[str] | None = None
            draft_state: dict[str, Any] | None = None
            draft_fingerprint: str | None = None
            changed_without_draft = False
            for _ in range(self.observations):
                try:
                    observed_state = self._status_entry(resolved)
                    self._ensure_same_target(current_state, observed_state)
                    self._ensure_input_revision(observed_state, expected_enter_input_revision)
                    observed_lines = self.read(resolved)["lines"]
                except (BridgeError, RuntimeError, OSError) as exc:
                    detail = str(exc) if isinstance(exc, BridgeError) else transport_error(exc)
                    kind = exc.kind if isinstance(exc, BridgeError) else "verification_unavailable"
                    return send_result(kind, detail)
                observed_fingerprint = screen_fingerprint(observed_lines)
                if draft_visible(observed_lines, text, baseline=current_screen):
                    if draft_fingerprint == observed_fingerprint:
                        draft_lines = observed_lines
                        draft_state = observed_state
                        break
                    draft_fingerprint = observed_fingerprint
                elif observed_fingerprint != initial_fingerprint and current_input_line(observed_lines) is None:
                    changed_without_draft = True
                self.sleep(self.poll_seconds)
            if draft_lines is None or draft_state is None:
                kind = "screen_changed_ambiguously" if changed_without_draft else "draft_not_observed"
                return send_result(kind, "draft was not stably observed in the input area; Enter was not sent")
        try:
            self._ensure_sendable(draft_state, expected_attention)
            latest_state = self._status_entry(resolved)
            self._ensure_same_target(draft_state, latest_state)
            self._ensure_input_revision(latest_state, expected_enter_input_revision)
            self._ensure_sendable(latest_state, expected_attention)
            latest_lines = self.read(resolved)["lines"]
        except (BridgeError, RuntimeError, OSError) as exc:
            kind = exc.kind if isinstance(exc, BridgeError) else "verification_unavailable"
            detail = str(exc) if isinstance(exc, BridgeError) else transport_error(exc)
            return send_result(kind, detail)
        if screen_fingerprint(latest_lines) != draft_fingerprint or (text and not draft_visible(
            latest_lines,
            text,
            baseline=current_screen,
        )):
            return send_result("prompt_changed", "draft screen changed before Enter")
        enter_args = self._send_args(
            resolved,
            text="",
            key="enter",
            state=latest_state,
            expected_input_revision=expected_enter_input_revision,
        )
        # Once issued, a lost reply is not proof that Enter was never written.
        enter_sent = True
        try:
            enter_result = self.request("pane.send_text", enter_args)
        except (RuntimeError, OSError) as exc:
            return send_result("write_failed", "Enter request outcome is unknown; " + transport_error(exc))
        if isinstance(enter_result, dict) and enter_result.get("sent") is False:
            enter_sent = False
            return send_result("write_failed", "Enter write was explicitly rejected")
        enter_detail = (
            "single Enter confirmed"
            if confirmed_key_write(enter_result)
            else "single Enter request issued; frontend confirmation unavailable"
        )
        residue_seen = False
        verification_seen = False
        detail = "post-Enter verification failed"
        before_transition = state_transition_signature(latest_state)
        for _ in range(self.observations):
            try:
                after_state = self._status_entry(resolved)
                self._ensure_same_session(latest_state, after_state)
                after_lines = self.read(resolved)["lines"]
                verification_seen = True
            except (BridgeError, RuntimeError, OSError):
                self.sleep(self.poll_seconds)
                continue
            screen_changed = screen_fingerprint(after_lines) != draft_fingerprint
            input_line = current_input_line(after_lines)
            if input_line is None:
                residue_seen = not screen_changed
                detail = "input line not identified; post-Enter fingerprint " + (
                    "changed" if screen_changed else "unchanged"
                )
                delivered = screen_changed
            else:
                number, kind, _body = input_line
                residue_seen = draft_visible(after_lines, text)
                transition_seen = state_transition_signature(after_state) != before_transition
                detail = f"last {kind} input line {number}: " + (
                    "body remains" if residue_seen else "body absent"
                )
                detail += "; post-Enter fingerprint " + ("changed" if screen_changed else "unchanged")
                detail += "; canonical state " + ("transitioned" if transition_seen else "unchanged")
                delivered = not residue_seen and (screen_changed or transition_seen)
            if delivered:
                return send_result("observed_delivered", detail + "; " + enter_detail)
            self.sleep(self.poll_seconds)
        if not verification_seen:
            return send_result("verification_unavailable", detail + "; " + enter_detail)
        if residue_seen:
            return send_result("residue_remains", detail + "; " + enter_detail)
        return send_result("verification_unavailable", detail + "; " + enter_detail)

def parse_answers(value: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise argparse.ArgumentTypeError(f"invalid answer JSON: {exc.msg}") from exc
    if not isinstance(parsed, dict):
        raise argparse.ArgumentTypeError("answers must be a JSON object")
    return parsed
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="subcommand", required=True)
    subparsers.add_parser("list", help="List normalized mycmux PTY sessions")
    read = subparsers.add_parser("read", help="Read a logical screen snapshot")
    read.add_argument("--session", required=True)
    read.add_argument("--lines", type=int, default=MAX_READ_LINES)
    status = subparsers.add_parser("status", help="Read canonical state for one PTY session")
    status.add_argument("--session", required=True)
    send = subparsers.add_parser("send", help="Safely type and submit one general message")
    send_target = send.add_mutually_exclusive_group(required=True)
    send_target.add_argument("--session")
    send_target.add_argument("--target")
    send.add_argument("--text", required=True)
    send.add_argument("--expect-attention", default="none", choices=("none",))
    answer = subparsers.add_parser("answer-ask", help="Answer a visible AskUserQuestion")
    answer.add_argument("--session", required=True)
    answer.add_argument("--answers-json", required=True, type=parse_answers)
    return parser
def main(argv: Sequence[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")
    args = build_parser().parse_args(argv)
    try:
        repo = resolve_agent_cli()
        cli = load_agent_cli(repo)
        bridge = Bridge(cli.send_request)
        if args.subcommand == "list":
            result = bridge.list_tabs()
        elif args.subcommand == "read":
            result = bridge.read(args.session, args.lines)
        elif args.subcommand == "status":
            result = bridge.status(args.session)
        elif args.subcommand == "send":
            result = bridge.send(
                args.text,
                session_id=args.session,
                target=args.target,
                expected_attention=args.expect_attention,
            )
        elif args.subcommand == "answer-ask":
            result = bridge.answer_ask(args.session, args.answers_json)
        else:  # pragma: no cover
            raise BridgeError("verification_unavailable", f"unsupported command: {args.subcommand}")
    except BridgeError as exc:
        print(json.dumps({"result": exc.kind, "error": str(exc),
                          **({"enter_sent": False} if args.subcommand == "send" else {})},
                         ensure_ascii=False), file=sys.stderr)
        return 1
    except (RuntimeError, OSError) as exc:
        print(
            json.dumps({"result": "verification_unavailable", "error": transport_error(exc),
                        **({"enter_sent": False} if args.subcommand == "send" else {})}, ensure_ascii=False),
            file=sys.stderr,
        )
        return 1
    print(json.dumps(result, ensure_ascii=False))
    if isinstance(result, dict) and result.get("result") in RESULT_KINDS - {"observed_delivered"}:
        return 1
    return 0
if __name__ == "__main__":
    raise SystemExit(main())
