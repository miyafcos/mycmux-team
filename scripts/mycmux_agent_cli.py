#!/usr/bin/env python3
"""Send one agent-oriented command to a running mycmux instance."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import secrets
import socket
import sys
from typing import Any, Sequence


TIMEOUT_SECONDS = 35.0


def runtime_dir() -> Path:
    """Return the app-provided runtime directory or the legacy default."""
    value = os.environ.get("MYCMUX_RUNTIME_DIR")
    return Path(value) if value else Path.home() / ".mycmux"


def port_file() -> Path:
    return runtime_dir() / "mycmux.port"


def token_file() -> Path:
    return runtime_dir() / "mycmux.token"


def prompt_dir() -> Path:
    return runtime_dir() / "agent-prompts"
AGENT_TARGETS = ("claude", "codex", "claude-codex", "grok", "shell")
AGENT_KINDS = ("claude", "codex", "claude-codex", "grok")


def read_port(path: Path | None = None) -> int:
    """Read and validate the loopback socket port."""
    path = path or port_file()
    try:
        value = path.read_text(encoding="utf-8").strip()
        port = int(value)
    except (OSError, ValueError) as exc:
        raise RuntimeError(f"cannot read mycmux port from {path}: {exc}") from exc
    if not 1 <= port <= 65535:
        raise RuntimeError(f"invalid mycmux port in {path}")
    return port


def read_token(path: Path | None = None) -> str | None:
    """Read the socket token mycmux writes next to the port file.

    A missing file means the running mycmux predates socket auth or was started
    with ``MYCMUX_SOCKET_AUTH=off``; the request then goes out unauthenticated
    exactly as before.
    """
    path = path or token_file()
    try:
        token = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return token or None


def send_request(cmd: str, args: dict[str, Any]) -> Any:
    """Send one newline-delimited request and return its result."""
    payload: dict[str, Any] = {"cmd": cmd, "args": args}
    token = read_token()
    if token is not None:
        payload["token"] = token
    request = json.dumps(payload, ensure_ascii=False) + "\n"
    port = read_port()
    try:
        with socket.create_connection(
            ("127.0.0.1", port), timeout=TIMEOUT_SECONDS
        ) as connection:
            connection.settimeout(TIMEOUT_SECONDS)
            connection.sendall(request.encode("utf-8"))
            with connection.makefile("rb") as reader:
                response_line = reader.readline()
    except OSError as exc:
        raise RuntimeError(f"mycmux socket request failed: {exc}") from exc

    if not response_line:
        raise RuntimeError("mycmux closed the socket without a response")
    try:
        response = json.loads(response_line.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("mycmux returned an invalid response") from exc
    if not isinstance(response, dict):
        raise RuntimeError("mycmux returned an invalid response object")
    error = response.get("error")
    if error == "unauthorized":
        raise RuntimeError(
            f"mycmux rejected the request as unauthorized: no valid token in {token_file()} "
            "(restart mycmux so it rewrites the token, or start it with "
            "MYCMUX_SOCKET_AUTH=off)"
        )
    if error is not None:
        raise RuntimeError(str(error))
    return response.get("result")


def write_prompt(text: str) -> Path:
    """Persist an inline prompt and return its absolute path."""
    directory = prompt_dir()
    directory.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = directory / f"{timestamp}-{secrets.token_hex(3)}.md"
    path.write_text(text, encoding="utf-8")
    return path.resolve()


def parse_json_object(value: str) -> dict[str, Any]:
    """Parse one JSON object without changing its fields."""
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise argparse.ArgumentTypeError(f"invalid JSON object: {exc.msg}") from exc
    if not isinstance(parsed, dict):
        raise argparse.ArgumentTypeError("value must be a JSON object")
    return parsed


def add_interactive_launch_arguments(
    parser: argparse.ArgumentParser, *, target_required: bool
) -> None:
    parser.add_argument("--target", choices=AGENT_TARGETS, required=target_required)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--prompt")
    mode.add_argument("--prompt-file", type=Path)
    mode.add_argument("--handoff-from-session")
    mode.add_argument("--resume-session")
    parser.add_argument("--handoff-from-kind", choices=AGENT_KINDS)


def add_spawn_arguments(parser: argparse.ArgumentParser) -> None:
    add_interactive_launch_arguments(parser, target_required=True)
    parser.add_argument("--cwd")
    parser.add_argument("--label")
    parser.add_argument(
        "--split",
        action="store_true",
        help="Force a new split pane instead of the default same-pane tab",
    )
    parser.add_argument("--workspace")
    parser.add_argument("--anchor-pane")
    parser.add_argument("--direction")
    activation = parser.add_mutually_exclusive_group()
    activation.add_argument(
        "--activate",
        action="store_true",
        help="Request internal activation without changing the operator foreground",
    )
    activation.add_argument("--no-activate", action="store_true")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Control visible mycmux panes through the local socket.",
        epilog="Safety: send types text into a live terminal; verify the session first.",
    )
    subparsers = parser.add_subparsers(dest="subcommand", required=True)

    subparsers.add_parser("workspaces", help="List workspaces")

    panes = subparsers.add_parser("panes", help="List panes")
    panes_scope = panes.add_mutually_exclusive_group()
    panes_scope.add_argument("--workspace")
    panes_scope.add_argument(
        "--all", action="store_true", help="List panes across all workspaces"
    )

    spawn = subparsers.add_parser(
        "spawn",
        help=(
            "Spawn an agent. Defaults to a background tab in the calling pane "
            "(MYCMUX_PANE_SESSION_ID); --activate permits internal activation only "
            "in a background workspace and never changes the operator foreground; "
            "use --split for a new split pane"
        ),
    )
    add_spawn_arguments(spawn)

    spawn_tab = subparsers.add_parser("spawn-tab", help="Spawn a tab in the owning pane")
    spawn_tab.add_argument("--anchor-session")
    spawn_tab.add_argument(
        "--detach",
        action="store_true",
        help="Put the new tab in its own pane, so closing the caller's pane cannot take it down.",
    )
    spawn_tab.add_argument("--cwd", default=os.getcwd())
    spawn_tab.add_argument("--label")
    spawn_tab_activation = spawn_tab.add_mutually_exclusive_group()
    spawn_tab_activation.add_argument(
        "--activate",
        action="store_true",
        help="Request internal activation without changing the operator foreground",
    )
    spawn_tab_activation.add_argument("--no-activate", action="store_true")
    add_interactive_launch_arguments(spawn_tab, target_required=False)
    spawn_tab.add_argument("command_argv", nargs=argparse.REMAINDER)

    declare_tab = subparsers.add_parser("declare-tab", help="Declare a tab without starting a PTY")
    declare_tab.add_argument("--session", required=True)
    declare_tab.add_argument("--label", required=True)
    declare_tab.add_argument("--prompt")
    declare_tab.add_argument("--target", choices=("claude", "codex", "grok"))
    declare_tab.add_argument(
        "--origin",
        choices=("agent", "human"),
        default="agent",
        help="Declaration origin (default: agent)",
    )

    activate_tab = subparsers.add_parser(
        "activate-tab",
        help="Activate a terminal tab internally without changing the operator foreground",
    )
    activate_tab.add_argument("--session", required=True)

    restore_activation = subparsers.add_parser(
        "restore-activation",
        help="Validate a prior activation token without changing the operator foreground",
    )
    restore_activation.add_argument("--token", required=True, type=parse_json_object)

    close_tab = subparsers.add_parser("close-tab", help="Close a terminal tab")
    close_tab.add_argument("--session", required=True)

    rename = subparsers.add_parser("rename", help="Rename a terminal tab")
    rename.add_argument("--session", required=True)
    rename.add_argument("--label", required=True)

    move = subparsers.add_parser("move", help="Move a pane within its workspace")
    move.add_argument("--session", required=True)
    move.add_argument("--column", required=True, type=int)
    move.add_argument("--row", required=True, type=int)

    send = subparsers.add_parser("send", help="Type text into a live terminal")
    send.add_argument("--session", required=True)
    send.add_argument("--text", default="")
    send_mode = send.add_mutually_exclusive_group()
    send_mode.add_argument("--enter", action="store_true")
    send_mode.add_argument(
        "--key",
        choices=("enter", "esc", "tab", "up", "down", "left", "right", "ctrl-c", "space", "backspace"),
    )
    send.add_argument("--expect-epoch", type=int)
    send.add_argument("--expect-attention-id")
    send.add_argument("--expect-revision", type=int)

    read = subparsers.add_parser("read", help="Read terminal buffer lines")
    read.add_argument("--session", required=True)
    read.add_argument("--lines", type=int)
    return parser


def optional_arg(args: dict[str, Any], name: str, value: Any) -> None:
    if value is not None:
        args[name] = value


def add_launch_mode_request_args(
    args: dict[str, Any], namespace: argparse.Namespace
) -> None:
    if namespace.handoff_from_kind and not namespace.handoff_from_session:
        raise RuntimeError("--handoff-from-kind requires --handoff-from-session")

    if namespace.prompt is not None:
        args["promptFile"] = str(write_prompt(namespace.prompt))
    elif namespace.prompt_file is not None:
        args["promptFile"] = str(namespace.prompt_file.expanduser().resolve())
    elif namespace.handoff_from_session is not None:
        args["handoffFromSessionId"] = namespace.handoff_from_session
        optional_arg(args, "handoffFromKind", namespace.handoff_from_kind)
    elif namespace.resume_session is not None:
        args["resumeSessionId"] = namespace.resume_session

    if "promptFile" in args:
        optional_arg(args, "fromSessionId", os.environ.get("MYCMUX_PANE_SESSION_ID"))


def spawn_wants_split(namespace: argparse.Namespace) -> bool:
    """Decide between a split pane and the default same-pane tab."""
    if namespace.split:
        return True
    if namespace.workspace or namespace.anchor_pane or namespace.direction:
        return True
    return not os.environ.get("MYCMUX_PANE_SESSION_ID")


def build_spawn_as_tab_request(namespace: argparse.Namespace) -> dict[str, Any]:
    args: dict[str, Any] = {
        "anchorSessionId": os.environ["MYCMUX_PANE_SESSION_ID"],
        "cwd": namespace.cwd if namespace.cwd is not None else os.getcwd(),
        "target": namespace.target,
        "activate": namespace.activate,
    }
    optional_arg(args, "label", namespace.label)
    add_launch_mode_request_args(args, namespace)
    return args


def build_spawn_request(namespace: argparse.Namespace) -> dict[str, Any]:
    args: dict[str, Any] = {
        "target": namespace.target,
        "cwd": namespace.cwd if namespace.cwd is not None else os.getcwd(),
        "activate": namespace.activate,
    }
    # Tells the frontend where the caller lives, so a split lands next to the
    # agent that asked for it instead of next to whatever the operator is
    # currently looking at.
    optional_arg(args, "anchorSessionId", os.environ.get("MYCMUX_PANE_SESSION_ID"))
    optional_arg(args, "label", namespace.label)
    optional_arg(args, "workspaceId", namespace.workspace)
    optional_arg(args, "anchorPaneId", namespace.anchor_pane)
    optional_arg(args, "direction", namespace.direction)
    add_launch_mode_request_args(args, namespace)
    return args


def build_spawn_tab_request(namespace: argparse.Namespace) -> dict[str, Any]:
    if namespace.detach and namespace.anchor_session:
        raise RuntimeError("spawn-tab --detach cannot be used with --anchor-session")
    anchor_session = namespace.anchor_session or os.environ.get("MYCMUX_PANE_SESSION_ID")
    if not anchor_session:
        if namespace.detach:
            return build_detached_spawn_request(namespace)
        raise RuntimeError(
            "spawn-tab requires --anchor-session or MYCMUX_PANE_SESSION_ID"
        )

    command_argv = list(namespace.command_argv)
    if command_argv and command_argv[0] == "--":
        command_argv = command_argv[1:]
    has_command = bool(command_argv)
    has_target = namespace.target is not None
    if has_command == has_target:
        raise RuntimeError("spawn-tab requires exactly one of command argv or --target")

    args: dict[str, Any] = {
        "anchorSessionId": anchor_session,
        "cwd": namespace.cwd,
        "activate": namespace.activate,
    }
    optional_arg(args, "label", namespace.label)
    if has_command:
        if any(
            value is not None
            for value in (
                namespace.prompt,
                namespace.prompt_file,
                namespace.handoff_from_session,
                namespace.handoff_from_kind,
                namespace.resume_session,
            )
        ):
            raise RuntimeError("spawn-tab command argv cannot use interactive launch options")
        args["commandArgv"] = command_argv
    else:
        args["target"] = namespace.target
        add_launch_mode_request_args(args, namespace)
    return args


def build_detached_spawn_request(namespace: argparse.Namespace) -> dict[str, Any]:
    command_argv = list(namespace.command_argv)
    if command_argv and command_argv[0] == "--":
        command_argv = command_argv[1:]
    has_command = bool(command_argv)
    has_target = namespace.target is not None
    if has_command == has_target:
        raise RuntimeError("spawn-tab requires exactly one of command argv or --target")

    args: dict[str, Any] = {
        "cwd": namespace.cwd,
        "activate": namespace.activate,
    }
    optional_arg(args, "anchorSessionId", os.environ.get("MYCMUX_PANE_SESSION_ID"))
    optional_arg(args, "label", namespace.label)
    if has_command:
        if any(value is not None for value in (namespace.prompt, namespace.prompt_file, namespace.handoff_from_session, namespace.handoff_from_kind, namespace.resume_session)):
            raise RuntimeError("spawn-tab command argv cannot use interactive launch options")
        args["commandArgv"] = command_argv
    else:
        args["target"] = namespace.target
        add_launch_mode_request_args(args, namespace)
    return args


def request_for(namespace: argparse.Namespace) -> tuple[str, dict[str, Any]]:
    if namespace.subcommand == "workspaces":
        return "workspace.list", {}
    if namespace.subcommand == "panes":
        if namespace.all:
            return "pane.list_all", {}
        args: dict[str, Any] = {}
        optional_arg(args, "workspaceId", namespace.workspace)
        return "pane.list", args
    if namespace.subcommand == "spawn":
        if spawn_wants_split(namespace):
            return "pane.spawn", build_spawn_request(namespace)
        return "pane.spawn_tab", build_spawn_as_tab_request(namespace)
    if namespace.subcommand == "spawn-tab":
        if namespace.detach:
            if namespace.anchor_session:
                raise RuntimeError("spawn-tab --detach cannot be used with --anchor-session")
            return "pane.spawn", build_detached_spawn_request(namespace)
        return "pane.spawn_tab", build_spawn_tab_request(namespace)
    if namespace.subcommand == "declare-tab":
        args = {
            "sessionId": namespace.session,
            "label": namespace.label,
            "origin": namespace.origin,
        }
        optional_arg(args, "declaredPrompt", namespace.prompt)
        optional_arg(args, "declaredTarget", namespace.target)
        return "pane.declare_tab", args
    if namespace.subcommand == "activate-tab":
        return "pane.activate_tab", {"sessionId": namespace.session}
    if namespace.subcommand == "restore-activation":
        return "pane.restore_activation", namespace.token
    if namespace.subcommand == "close-tab":
        return "pane.close_tab", {"sessionId": namespace.session}
    if namespace.subcommand == "rename":
        return "pane.rename_tab", {
            "sessionId": namespace.session,
            "label": namespace.label,
        }
    if namespace.subcommand == "move":
        return "pane.move", {
            "sessionId": namespace.session,
            "toColumn": namespace.column,
            "toRow": namespace.row,
        }
    if namespace.subcommand == "send":
        if not namespace.text and not namespace.enter and namespace.key is None:
            raise RuntimeError("send requires --text, --enter, or --key")
        args = {
            "sessionId": namespace.session,
            "text": namespace.text,
            "enter": namespace.enter,
        }
        optional_arg(args, "key", namespace.key)
        optional_arg(args, "expectedSessionEpoch", namespace.expect_epoch)
        optional_arg(args, "expectedAttentionId", namespace.expect_attention_id)
        optional_arg(args, "expectedSessionRevision", namespace.expect_revision)
        return "pane.send_text", args
    if namespace.subcommand == "read":
        args = {"sessionId": namespace.session}
        optional_arg(args, "lines", namespace.lines)
        return "pane.read", args
    raise RuntimeError(f"unsupported subcommand: {namespace.subcommand}")


def main(argv: Sequence[str] | None = None) -> int:
    # Windows consoles often default to cp932; pane content can contain any
    # Unicode, so force UTF-8 output instead of crashing on print.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")
    parser = build_parser()
    namespace = parser.parse_args(argv)
    try:
        cmd, args = request_for(namespace)
        result = send_request(cmd, args)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    failed = False
    if namespace.subcommand == "send":
        failed = isinstance(result, dict) and (
            result.get("ok") is False or result.get("sent") is False
        )
        verification_requested = namespace.enter or namespace.key is not None
        if verification_requested and not (
            isinstance(result, dict)
            and result.get("ok") is True
            and result.get("confirmed") is True
        ):
            failed = True
            if isinstance(result, dict) and not (
                result.get("ok") is False or result.get("sent") is False
            ):
                result = {
                    **result,
                    "ok": False,
                    "confirmed": False,
                    "reason": "confirmation_unavailable",
                }
            elif not isinstance(result, dict):
                result = {
                    "ok": False,
                    "confirmed": False,
                    "reason": "confirmation_unavailable",
                    "legacyResult": result,
                }
        if isinstance(result, dict) and result.get("unverified") is True:
            print(
                "warning: input was queued without delivery verification; use --enter or --key",
                file=sys.stderr,
            )
    print(json.dumps(result, ensure_ascii=False))
    if failed:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
