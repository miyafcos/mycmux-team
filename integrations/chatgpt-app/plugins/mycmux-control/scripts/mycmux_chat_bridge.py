from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_ROOT))

from server.mycmux_control_server import BridgeStore, ToolFailure  # noqa: E402


def print_json(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Read and write the mycmux/ChatGPT structured handoff store. Never writes to a PTY."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("bindings", help="List current tab bindings")

    inbox = subparsers.add_parser("inbox", help="List handoffs")
    inbox.add_argument("--binding-id")
    inbox.add_argument("--direction", choices=["mycmux_to_chatgpt", "chatgpt_to_mycmux"])
    inbox.add_argument("--status", choices=["queued", "consumed"], default="queued")

    send = subparsers.add_parser("send", help="Queue a structured handoff")
    send.add_argument("--binding-id", required=True)
    send.add_argument("--direction", choices=["mycmux_to_chatgpt", "chatgpt_to_mycmux"], required=True)
    send.add_argument(
        "--kind",
        choices=["checkpoint", "question", "answer", "instruction", "handoff", "evidence"],
        required=True,
    )
    send.add_argument("--summary", required=True)
    send.add_argument("--evidence", action="append", default=[])

    acknowledge = subparsers.add_parser("ack", help="Mark a handoff consumed")
    acknowledge.add_argument("--binding-id", required=True)
    acknowledge.add_argument("--message-id", required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    store = BridgeStore()
    try:
        if args.command == "bindings":
            print_json({"bindings": store.snapshot()["bindings"]})
        elif args.command == "inbox":
            items = store.messages(binding_id=args.binding_id, direction=args.direction, status=args.status)
            print_json({"messages": items, "count": len(items)})
        elif args.command == "send":
            print_json(
                {
                    "message": store.enqueue(
                        args.binding_id,
                        args.direction,
                        args.kind,
                        args.summary,
                        args.evidence,
                    )
                }
            )
        elif args.command == "ack":
            print_json({"message": store.acknowledge(args.binding_id, args.message_id)})
        else:
            raise ToolFailure(f"unsupported command: {args.command}")
    except ToolFailure as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
