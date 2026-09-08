"""dispatch_send.py — 子タブへの状態検査・本文投入・Enter 1回をまとめる。

epoch / attention id (JSON null を含む) / session revision / input revision を
canonical state から取得し、bridge の構造化送信で本文の入力改訂番号を追跡する。
observed_delivered は配送の観測までで、受信者の実行・適用を意味しない。
Enter 要求後は再送防止のため exit 0。確度は result / confirmed、送信有無は enter_sent を見る。

usage:
  python dispatch_send.py --slug 260813-foo --text "..."
  python dispatch_send.py --session <tab_session_id> --text "" --enter
  python dispatch_send.py --slug 260813-foo --show
  python dispatch_send.py --session <tab_session_id> --text "..." --dry-run
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import time
from functools import lru_cache
import sys
from pathlib import Path
from typing import Any

from dispatch_ledger import DEFAULT_LEDGER, INACTIVE_STATUSES, find_dispatches, load_dispatches


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

AGENT_CLI = resolve_agent_cli()

BRIDGE_SCRIPT = Path(__file__).resolve().parents[2] / "mycmux-bridge" / "scripts" / "mycmux_bridge.py"


@lru_cache(maxsize=1)
def load_bridge():
    spec = importlib.util.spec_from_file_location("dispatch_mycmux_bridge", BRIDGE_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load mycmux bridge: {BRIDGE_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_agent_cli(path: Path = AGENT_CLI):
    """mycmux_agent_cli を読み取り専用で import する (リポジトリは変更しない)."""
    spec = importlib.util.spec_from_file_location("mycmux_agent_cli", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load mycmux agent CLI: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def extract_view(state_view: Any, session_id: str) -> dict[str, Any] | None:
    """session.state_view の応答から当該セッションの view を取り出す."""
    if not isinstance(state_view, dict):
        return None
    for entry in state_view.get("sessions") or []:
        if not isinstance(entry, dict):
            continue
        if entry.get("session_id") != session_id:
            continue
        view = entry.get("view")
        return view if isinstance(view, dict) else None
    return None


def build_expectations(
    state_view: Any, session_id: str, *, include_attention: bool = False
) -> dict[str, Any]:
    """Build all four expectations; include_attention remains a compatibility flag."""
    bridge = load_bridge().Bridge(lambda *_args: None)
    states = bridge._state_map(state_view)
    if set(states) != {session_id}:
        raise RuntimeError(f"canonical state did not return exactly one session: {session_id}")
    state = states[session_id]
    attention = state["view"].get("attention")
    kind = attention.get("kind") if isinstance(attention, dict) else None
    bridge._ensure_sendable(state, kind)
    request = bridge._send_args(session_id, text="", state=state)
    return {
        "expect_epoch": request["expectedSessionEpoch"],
        "expect_attention_id": request["expectedAttentionId"],
        "expect_revision": request["expectedSessionRevision"],
        "expect_input_revision": request["expectedInputRevision"],
    }


def build_send_argv(
    session_id: str, text: str, *, enter: bool, expectations: dict[str, Any]
) -> list[str]:
    argv = [
        sys.executable,
        str(AGENT_CLI),
        "send",
        "--session",
        session_id,
        "--text",
        text,
    ]
    if enter:
        argv.append("--enter")
    if "expect_epoch" in expectations:
        argv += ["--expect-epoch", str(expectations["expect_epoch"])]
    if "expect_attention_id" in expectations:
        attention_id = expectations["expect_attention_id"]
        argv += ["--expect-attention-id", "null" if attention_id is None else str(attention_id)]
    if "expect_revision" in expectations:
        argv += ["--expect-revision", str(expectations["expect_revision"])]
    if "expect_input_revision" in expectations:
        argv += ["--expect-input-revision", str(expectations["expect_input_revision"])]
    return argv


def resolve_session_id(ledger: Path, slug: str, spawn_ts: str | None) -> str:
    matches = find_dispatches(load_dispatches(ledger), slug, spawn_ts)
    if not matches:
        raise RuntimeError(f"台帳に slug がありません: {slug}")
    active = [dispatch for dispatch in matches if dispatch.status not in INACTIVE_STATUSES]
    if not active:
        statuses = ", ".join(sorted({dispatch.status for dispatch in matches}))
        raise RuntimeError(f"クローズ済み dispatch には send しません (status={statuses}): {slug}")
    if len(active) > 1:
        spawn_list = ", ".join(dispatch.spawn_ts for dispatch in active)
        raise RuntimeError(
            f"同じ slug に active な dispatch が複数あります: {slug} "
            f"(spawn_ts: {spawn_list}) — --spawn-ts で特定してください"
        )
    session_id = active[0].tab_session_id
    if not session_id:
        raise RuntimeError(f"tab_session_id が台帳にありません: {slug}")
    return session_id


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--slug")
    target.add_argument("--session")
    parser.add_argument("--spawn-ts")
    parser.add_argument("--text", default="")
    parser.add_argument("--enter", action="store_true", help="本文は既定で送信。空本文なら Enter 1回")
    parser.add_argument(
        "--expect-attention",
        action="store_true",
        help="今見えている ask/待ち状態が変わっていないときだけ送る",
    )
    parser.add_argument("--show", action="store_true", help="期待値の表示のみ (送信しない)")
    parser.add_argument("--dry-run", action="store_true", help="状態・期待値4点・本文の表示のみ")
    parser.add_argument("--ledger", default=str(DEFAULT_LEDGER))
    return parser.parse_args(argv)


def refuse_send(detail: str, *, kind: str = "verification_unavailable",
                code: int = 3, session_id: str | None = None) -> int:
    print(f"SEND-REFUSED: {detail}", file=sys.stderr)
    print(json.dumps({
        "sessionId": session_id, "ok": False, "confirmed": False,
        "result": kind, "detail": detail, "enter_sent": False,
    }, ensure_ascii=False))
    return code


def ensure_guard():
    from dispatch_guard import ensure
    return ensure()


def confirm_delivery(bridge, session_id, baseline, **kwargs):
    from guard_actions import observe_delivery
    return observe_delivery(bridge, session_id, baseline, **kwargs)


def handoff_pending(session_id, text, **kwargs):
    from guard_actions import register_pending
    return register_pending(session_id, text, **kwargs)


def transcript_mtime_for(ledger_path, session_id):
    from dispatch_guard import transcript_path
    records = [d for d in load_dispatches(ledger_path) if d.tab_session_id == session_id
               and d.status not in INACTIVE_STATUSES]
    if len(records) != 1:
        return None
    path = transcript_path(records[0])
    return path.stat().st_mtime if path and path.is_file() else None


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not args.text and not args.enter and not args.show and not args.dry_run:
        return refuse_send("--text か --enter が必要です", kind="write_failed", code=2)
    try:
        session_id = args.session or resolve_session_id(
            Path(args.ledger), args.slug, args.spawn_ts
        )
    except RuntimeError as exc:
        return refuse_send(str(exc), kind="stale_target")
    bridge_module = load_bridge()
    try:
        cli = load_agent_cli()
        writes = []
        def transport(command, payload):
            if command == "pane.send_text":
                entry = {"payload": dict(payload)}
                writes.append(entry)
                try:
                    response = cli.send_request(command, payload)
                    entry["response"] = response
                    return response
                except (RuntimeError, OSError):
                    entry["unknown"] = True
                    raise
            return cli.send_request(command, payload)
        bridge = bridge_module.Bridge(transport)
        state = bridge.status(session_id)
        expectations = build_expectations(
            {"sessions": [state]}, session_id, include_attention=args.expect_attention
        )
        if args.show:
            print(json.dumps({"session_id": session_id, **expectations, "enter_sent": False}, ensure_ascii=False))
            return 0
        expected_attention = (
            state["view"]["attention"]["kind"]
            if args.expect_attention or (not args.text and args.enter)
            else "none"
        )
        bridge._ensure_sendable(state, expected_attention)
        if args.dry_run:
            request = bridge._send_args(
                session_id, text=args.text, state=state,
                key="enter" if not args.text and args.enter else None,
            )
            print(json.dumps({
                "session_id": session_id,
                "state": state,
                "expectations": {k: v for k, v in request.items() if k.startswith("expected")},
                "request": request,
                "submit_after_stable_draft": bool(args.text),
                "enter_sent": False,
            }, ensure_ascii=False, indent=2))
            return 0
        before_mtime = transcript_mtime_for(Path(args.ledger), session_id)
        result = bridge.send(
            args.text, session_id=session_id,
            expected_attention=expected_attention, expected_state=state,
            enter_only=not args.text and args.enter,
        )
    except bridge_module.BridgeError as exc:
        return refuse_send(str(exc), kind=exc.kind, session_id=session_id)
    except (RuntimeError, OSError):
        return refuse_send("mycmux request failed", session_id=session_id)
    delivered = result.get("result") == "observed_delivered"
    enter_sent = result["enter_sent"]
    output = {"sessionId": session_id, "ok": delivered, "confirmed": delivered, **result}
    if enter_sent and not delivered:
        output["warning"] = (
            "Enter was sent or its outcome is unknown; delivery is not confirmed. "
            "Do not resend automatically; inspect the current input line."
        )
    text_writes = [w for w in writes if w["payload"].get("text")]
    accepted_text = bool(text_writes and text_writes[-1].get("response", {}).get("sent") is not False
                         and text_writes[-1].get("response", {}).get("ok") is not False)
    baseline = state
    enter_writes = [w for w in writes if w["payload"].get("key") == "enter"]
    if enter_writes:
        payload = enter_writes[-1]["payload"]
        baseline = {"session_id": session_id, "input_revision": payload["expectedInputRevision"],
                    "view": {**state["view"], "session_epoch": payload["expectedSessionEpoch"],
                             "session_revision": payload["expectedSessionRevision"]}}
    check = {"delivered_confirmed": False}
    if enter_sent:
        check = confirm_delivery(bridge, session_id, baseline,
            transcript_mtime=lambda: transcript_mtime_for(Path(args.ledger), session_id),
            before_mtime=before_mtime)
    output["delivered_confirmed"] = check["delivered_confirmed"]
    output["delivery_observation"] = check
    if args.text and accepted_text and not check["delivered_confirmed"]:
        last = writes[-1]["payload"]
        response = writes[-1].get("response", {})
        own_revision = last["expectedInputRevision"] + (0 if response.get("sent") is False else 1)
        handoff_pending(session_id, args.text, slug=args.slug,
                        input_revision_after=own_revision,
                        session_epoch=last["expectedSessionEpoch"], baseline=baseline)
        output["guard_pending"] = True
        output["warning"] = ("Delivery is not confirmed; guard owns the pending machine send. "
                             "Do not resend automatically; inspect the current input line.")
    if accepted_text or enter_sent:
        try:
            output["guard"] = ensure_guard()
        except (RuntimeError, OSError):
            output["guard"] = {"alive": False, "warning": "Guard startup unavailable"}
    print(json.dumps(output, ensure_ascii=False))
    return 0 if delivered or enter_sent else 1


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
