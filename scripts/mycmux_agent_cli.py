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
import time
from typing import Any, Sequence


TIMEOUT_SECONDS = 35.0
WEB_PUSH_NO_MATCH_ERROR = "web.push found no matching web tab in the target workspace"
WEB_PUSH_OPEN_WAIT_SECONDS = 15.0
WEB_PUSH_OPEN_RETRY_SECONDS = 0.2


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
# "web" is not an agent: it opens a web tab (no PTY, no process). It shares the
# spawn command because where a tab lands is the same question either way.
AGENT_TARGETS = ("claude", "codex", "claude-codex", "grok", "shell", "web")
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
    parser.add_argument("--preset", help="web タブのプリセット id (--target web のとき)")
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

    subparsers.add_parser(
        "usage",
        help="Report how much of each registered CLI account's window is used",
    )

    status = subparsers.add_parser("status", help="Read canonical session state")
    status.add_argument("--session")

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
        help=(
            "Opt-in: open a NEW PANE (same as spawn --split) instead of the default "
            "background tab in the caller's pane. Not recommended; the pane-close "
            "confirmation dialog already protects long-running tabs."
        ),
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
    send.add_argument("--expect-attention-id", help="Attention ID, or null/none for no attention")
    send.add_argument("--expect-revision", type=int)
    send.add_argument("--expect-input-revision", type=int)

    read = subparsers.add_parser("read", help="Read terminal buffer lines")
    read.add_argument("--session", required=True)
    read.add_argument("--lines", type=int)

    web_open = subparsers.add_parser("web-open", help="Open a web pane tab")
    web_open.add_argument("--preset", default="chatgpt")
    web_open.add_argument("--anchor-session")
    web_open.add_argument("--replace-anchor", action="store_true")
    web_open.add_argument("--url")
    web_open.add_argument("--background", action="store_true")

    web_read = subparsers.add_parser("web-read", help="Read a web pane conversation")
    web_read_target = web_read.add_mutually_exclusive_group()
    web_read_target.add_argument("--tab")
    web_read_target.add_argument("--preset")
    web_close = subparsers.add_parser("web-close", help="Close a web pane tab")
    web_close.add_argument("--tab", required=True)
    web_focus = subparsers.add_parser("web-focus", help="Explicitly bring a web pane tab to the foreground")
    web_focus.add_argument("--tab", required=True)

    subparsers.add_parser("web-list", help="List web pane tabs")

    web_push = subparsers.add_parser("web-push", help="Push text into a web pane composer")
    web_push_text = web_push.add_mutually_exclusive_group()
    web_push_text.add_argument("--text")
    web_push_text.add_argument("--text-file", type=Path)
    web_push_target = web_push.add_mutually_exclusive_group()
    web_push_target.add_argument("--tab")
    web_push_target.add_argument("--preset")
    web_push.add_argument("--send", action="store_true")

    for command, help_text in (
        ("navigate", "Navigate a web pane"),
        ("wait", "Wait for page readiness"),
        ("eval", "Evaluate an async JavaScript body"),
        ("snapshot", "Read an AX or text snapshot"),
        ("find", "Find visible page elements"),
        ("click", "Click a page element or point"),
        ("type", "Type into an editable element"),
        ("key", "Send a page key"),
        ("scroll", "Scroll a page or element"),
        ("upload", "Attach local files"),
        ("screenshot", "Save a web pane screenshot"),
        ("downloads", "List completed downloads"),
        ("dialogs", "Read recorded browser dialogs"),
    ):
        web = subparsers.add_parser("web-" + command, help=help_text)
        target = web.add_mutually_exclusive_group()
        target.add_argument("--tab")
        target.add_argument("--preset")
        if command == "navigate":
            mode = web.add_mutually_exclusive_group(required=True)
            mode.add_argument("--url")
            for action in ("back", "forward", "reload"):
                mode.add_argument("--" + action, action="store_true")
        if command in ("wait", "eval"):
            web.add_argument("--timeout-ms", type=int)
        if command == "wait":
            web.add_argument("--state", choices=("load", "idle", "selector"), default="load")
            web.add_argument("--selector")
            web.add_argument("--interval-ms", type=int)
        if command == "eval":
            source = web.add_mutually_exclusive_group(required=True)
            source.add_argument("--script")
            source.add_argument("--script-file", type=Path)
        if command == "snapshot":
            web.add_argument("--mode", choices=("ax", "text"))
            web.add_argument("--max-bytes", type=int)
        if command == "find":
            for key in ("text", "role", "selector"):
                web.add_argument("--" + key)
            web.add_argument("--exact", action="store_true")
            web.add_argument("--limit", type=int)
        if command in ("click", "type", "scroll", "upload"):
            element = web.add_mutually_exclusive_group(required=command != "scroll")
            element.add_argument("--ref")
            element.add_argument("--selector")
            if command == "click":
                element.add_argument("--x", type=float)
                web.add_argument("--y", type=float)
                web.add_argument("--button", choices=("left", "right", "middle"))
                web.add_argument("--click-count", type=int)
        if command in ("click", "type", "key", "upload"):
            web.add_argument("--trusted", action="store_true")
        if command == "type":
            source = web.add_mutually_exclusive_group(required=True)
            source.add_argument("--text")
            source.add_argument("--text-file", type=Path)
            web.add_argument("--append", action="store_true")
            web.add_argument("--submit", action="store_true")
        if command == "key":
            web.add_argument("--key", required=True)
            web.add_argument("--code")
            web.add_argument("--mod")
            web.add_argument("--ref")
        if command == "scroll":
            web.add_argument("--delta-x", type=float)
            web.add_argument("--delta-y", type=float)
        if command == "upload":
            web.add_argument("--file", type=Path, action="append", required=True)
            web.add_argument("--drop", action="store_true")
        if command == "screenshot":
            web.add_argument("--out", type=Path)
        if command == "dialogs":
            web.add_argument("--clear", action="store_true")
    return parser


def optional_arg(args: dict[str, Any], name: str, value: Any) -> None:
    if value is not None:
        args[name] = value


def read_utf8_text(path: Path) -> str:
    """Read composer input without inheriting the Windows console encoding."""
    resolved = path.expanduser().resolve()
    try:
        return resolved.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise RuntimeError(f"cannot read UTF-8 text from {resolved}: {exc}") from exc


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
    """Decide between a split pane and the default same-pane tab.

    Only an explicit ``--split`` opens a new pane. Placement options without
    ``--split`` are an error, and a missing caller pane id is an error too:
    there is no silent fallback to a split pane (2026-08-21 ruling).
    """
    if namespace.split:
        return True
    if namespace.workspace or namespace.anchor_pane or namespace.direction:
        raise RuntimeError(
            "--workspace/--anchor-pane/--direction require --split "
            "(spawn defaults to a background tab in the calling pane)"
        )
    if not os.environ.get("MYCMUX_PANE_SESSION_ID"):
        raise RuntimeError(
            "spawn requires MYCMUX_PANE_SESSION_ID (run from inside a mycmux pane); "
            "pass --split to open a new pane instead"
        )
    return False


def build_spawn_as_tab_request(namespace: argparse.Namespace) -> dict[str, Any]:
    args: dict[str, Any] = {
        "anchorSessionId": os.environ["MYCMUX_PANE_SESSION_ID"],
        "cwd": namespace.cwd if namespace.cwd is not None else os.getcwd(),
        "target": namespace.target,
        "activate": namespace.activate,
    }
    optional_arg(args, "label", namespace.label)
    optional_arg(args, "preset", getattr(namespace, "preset", None))
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
    if namespace.subcommand == "usage":
        return "account.usage", {}
    if namespace.subcommand == "panes":
        if namespace.all:
            return "pane.list_all", {}
        args: dict[str, Any] = {}
        optional_arg(args, "workspaceId", namespace.workspace)
        return "pane.list", args
    if namespace.subcommand == "status":
        args: dict[str, Any] = {}
        optional_arg(args, "session_id", namespace.session)
        return "session.state_view", args
    if namespace.subcommand == "spawn":
        if spawn_wants_split(namespace):
            return "pane.spawn", build_spawn_request(namespace)
        return "pane.spawn_tab", build_spawn_as_tab_request(namespace)
    if namespace.subcommand == "spawn-tab":
        if namespace.detach:
            if namespace.anchor_session:
                raise RuntimeError("spawn-tab --detach cannot be used with --anchor-session")
            print(
                "[mycmux] --detach opens a NEW PANE (opt-in, same as spawn --split); "
                "the default is a background tab in the caller's pane",
                file=sys.stderr,
            )
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
        if namespace.expect_attention_id is not None:
            value = namespace.expect_attention_id
            args["expectedAttentionId"] = None if value.lower() in {"null", "none"} else value
        optional_arg(args, "expectedSessionRevision", namespace.expect_revision)
        optional_arg(args, "expectedInputRevision", namespace.expect_input_revision)
        return "pane.send_text", args
    if namespace.subcommand == "read":
        args = {"sessionId": namespace.session}
        optional_arg(args, "lines", namespace.lines)
        return "pane.read", args
    if namespace.subcommand == "web-open":
        args = {"presetId": namespace.preset}
        optional_arg(
            args,
            "anchorSessionId",
            namespace.anchor_session or os.environ.get("MYCMUX_PANE_SESSION_ID"),
        )
        if namespace.replace_anchor:
            args["replaceAnchor"] = True
        optional_arg(args, "url", namespace.url)
        if namespace.background:
            args["background"] = True
        return "web.open", args
    if namespace.subcommand == "web-read":
        if namespace.tab:
            return "web.read", {"tabId": namespace.tab}
        args = {"presetId": namespace.preset or "chatgpt"}
        optional_arg(args, "anchorSessionId", os.environ.get("MYCMUX_PANE_SESSION_ID"))
        return "web.read", args
    if namespace.subcommand in {"web-close", "web-focus"}:
        return namespace.subcommand.replace("-", ".", 1), {"tabId": namespace.tab}
    if namespace.subcommand == "web-list":
        return "web.list", {}
    if namespace.subcommand == "web-push":
        if namespace.text is None and namespace.text_file is None and not namespace.send:
            raise RuntimeError("web-push requires --text, --text-file, or --send")
        args = {"submit": namespace.send}
        if namespace.text is not None:
            args["text"] = namespace.text
        elif namespace.text_file is not None:
            args["text"] = read_utf8_text(namespace.text_file)
        if namespace.tab:
            args["tabId"] = namespace.tab
        else:
            args["presetId"] = namespace.preset or "chatgpt"
            optional_arg(
                args,
                "anchorSessionId",
                os.environ.get("MYCMUX_PANE_SESSION_ID"),
            )
        return "web.push", args

    if namespace.subcommand in {
        "web-navigate", "web-wait", "web-eval", "web-snapshot", "web-find",
        "web-click", "web-type", "web-key", "web-scroll", "web-upload",
        "web-screenshot", "web-downloads", "web-dialogs",
    }:
        return web_automation_request(namespace)
    raise RuntimeError(f"unsupported subcommand: {namespace.subcommand}")



def web_automation_request(namespace: argparse.Namespace) -> tuple[str, dict[str, Any]]:
    """Translate the automation CLI into the camelCase socket contract."""
    command = namespace.subcommand.removeprefix("web-")
    args: dict[str, Any] = {}
    if namespace.tab:
        args["tabId"] = namespace.tab
    else:
        args["presetId"] = namespace.preset or "chatgpt"
        optional_arg(args, "anchorSessionId", os.environ.get("MYCMUX_PANE_SESSION_ID"))
    for attr, field in (
        ("url", "url"), ("state", "state"), ("selector", "selector"), ("ref", "ref"),
        ("timeout_ms", "timeoutMs"), ("interval_ms", "intervalMs"),
        ("mode", "mode"), ("max_bytes", "maxBytes"), ("role", "role"),
        ("limit", "limit"), ("x", "x"), ("y", "y"), ("button", "button"),
        ("click_count", "clickCount"), ("key", "key"), ("code", "code"),
        ("delta_x", "deltaX"), ("delta_y", "deltaY"),
    ):
        optional_arg(args, field, getattr(namespace, attr, None))
    if command in ("wait", "eval") and namespace.timeout_ms is not None:
        if namespace.timeout_ms > 25000:
            raise RuntimeError(f"web.{command} timeoutMs must be <= 25000 (socket response deadline is 30s); poll again instead")
        if namespace.timeout_ms < 0:
            raise RuntimeError(f"web.{command} timeoutMs must be nonnegative")
    if command == "click" and namespace.click_count is not None and not 1 <= namespace.click_count <= 3:
        raise RuntimeError("web.click clickCount must be between 1 and 3")
    if command == "snapshot" and namespace.max_bytes is not None and not 4096 <= namespace.max_bytes <= 524288:
        raise RuntimeError("web.snapshot maxBytes must be between 4096 and 524288")
    if command == "navigate":
        for action in ("back", "forward", "reload"):
            if getattr(namespace, action):
                args["action"] = action
    if command == "eval":
        args["script"] = namespace.script if namespace.script is not None else read_utf8_text(namespace.script_file)
        if len(args["script"].encode("utf-8")) > 256 * 1024:
            raise RuntimeError("web.eval script exceeds 256 KB")
    if command == "type":
        args["text"] = namespace.text if namespace.text is not None else read_utf8_text(namespace.text_file)
        args["mode"] = "append" if namespace.append else "replace"
        args["submit"] = namespace.submit
    if command == "find":
        optional_arg(args, "text", namespace.text)
        args["exact"] = namespace.exact
        if not any(key in args for key in ("text", "role", "selector")):
            raise RuntimeError("web-find requires --text, --role, or --selector")
    if command == "click":
        if (namespace.x is None) != (namespace.y is None):
            raise RuntimeError("web-click requires both --x and --y")
        if namespace.y is not None and (namespace.ref is not None or namespace.selector is not None):
            raise RuntimeError("web-click coordinates cannot be combined with --ref or --selector")
    if command == "wait":
        if namespace.state == "selector" and namespace.selector is None:
            raise RuntimeError("web-wait --state selector requires --selector")
        if namespace.state != "selector" and namespace.selector is not None:
            raise RuntimeError("web-wait --selector requires --state selector")
    if command == "key" and namespace.mod is not None:
        modifiers = namespace.mod.split(",")
        if any(mod not in ("ctrl", "shift", "alt", "meta") for mod in modifiers):
            raise RuntimeError("web-key --mod requires comma-separated ctrl,shift,alt,meta")
        args["modifiers"] = modifiers
    if command == "upload":
        args["paths"] = [str(path.expanduser().resolve()) for path in namespace.file]
        args["mode"] = "drop" if namespace.drop else "input"
        if namespace.drop and namespace.trusted:
            raise RuntimeError("web-upload --trusted does not support --drop")
    if command == "screenshot" and namespace.out is not None:
        args["path"] = str(namespace.out.expanduser().resolve())
    if command == "dialogs":
        args["clear"] = namespace.clear
    if command in ("click", "type", "key", "upload"):
        args["trusted"] = namespace.trusted
    return "web." + command, args


def send_web_push_with_open(args: dict[str, Any]) -> Any:
    """Open a matching preset only when the socket reports the no-tab condition."""
    try:
        return send_request("web.push", args)
    except RuntimeError as exc:
        if str(exc) != WEB_PUSH_NO_MATCH_ERROR or "tabId" in args:
            raise

    open_args = {"presetId": args.get("presetId", "chatgpt"), "background": True}
    optional_arg(open_args, "anchorSessionId", args.get("anchorSessionId"))
    opened = send_request("web.open", open_args)
    tab_id = opened.get("tabId") if isinstance(opened, dict) else None
    if not isinstance(tab_id, str) or not tab_id:
        raise RuntimeError("web.open returned an invalid tabId")
    retry_args = {
        key: value
        for key, value in args.items()
        if key not in ("presetId", "anchorSessionId")
    }
    retry_args["tabId"] = tab_id
    deadline = time.monotonic() + WEB_PUSH_OPEN_WAIT_SECONDS
    while True:
        try:
            return send_request("web.push", retry_args)
        except RuntimeError as exc:
            message = str(exc)
            transient = (
                message.startswith("web pane does not exist:")
                or message == "ChatGPT composer #prompt-textarea was not found"
                or message == "web pane push timed out waiting for the composer"
            )
            if not transient or time.monotonic() >= deadline:
                raise
            time.sleep(WEB_PUSH_OPEN_RETRY_SECONDS)


def validate_status_result(result: Any, expected_session: str | None) -> Any:
    """Validate the canonical state response and reject ambiguous targeting."""
    if not isinstance(result, dict) or not isinstance(result.get("sessions"), list):
        raise RuntimeError("mycmux returned an invalid session.state_view schema")
    lifecycle_values = {"alive", "exited", "orphaned", "unknown"}
    activity_values = {"streaming", "running_silent", "idle", "unknown"}
    attention_values = {"none", "input", "approval", "rate_limited", "error", "done"}
    health_values = {"fresh", "stale", "degraded"}
    ui_state_values = {"working", "idle", "waiting", "done", "unknown"}

    def non_negative_int(value: Any) -> bool:
        return isinstance(value, int) and not isinstance(value, bool) and value >= 0

    seen: set[str] = set()
    matches: list[dict[str, Any]] = []
    for entry in result["sessions"]:
        if not isinstance(entry, dict):
            raise RuntimeError("mycmux returned an invalid session.state_view entry")
        session_id = entry.get("session_id")
        view = entry.get("view")
        if not isinstance(session_id, str) or not session_id or not isinstance(view, dict):
            raise RuntimeError("mycmux returned an invalid session.state_view entry")
        if view.get("session_id") != session_id:
            raise RuntimeError("mycmux returned mismatched session.state_view identifiers")
        epoch = view.get("session_epoch")
        attention = view.get("attention")
        if (
            "session_epoch" not in view
            or (epoch is not None and not non_negative_int(epoch))
            or not non_negative_int(view.get("session_revision"))
            or not non_negative_int(entry.get("input_revision"))
            or view.get("lifecycle") not in lifecycle_values
            or view.get("activity") not in activity_values
            or not isinstance(attention, dict)
            or attention.get("kind") not in attention_values
            or "attention_id" not in attention
            or not (
                attention.get("attention_id") is None
                or isinstance(attention.get("attention_id"), str)
            )
            or view.get("health") not in health_values
            or entry.get("ui_state") not in ui_state_values
        ):
            raise RuntimeError("mycmux returned an incomplete canonical session state")
        if session_id in seen:
            raise RuntimeError(f"mycmux returned duplicate session state: {session_id}")
        seen.add(session_id)
        if session_id == expected_session:
            matches.append(entry)
    if expected_session is not None:
        if len(matches) != 1:
            raise RuntimeError(
                f"session.state_view did not return exactly one session: {expected_session}"
            )
        return {**result, "sessions": matches}
    return result


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
        result = (
            send_web_push_with_open(args)
            if namespace.subcommand == "web-push"
            else send_request(cmd, args)
        )
        if namespace.subcommand == "status":
            result = validate_status_result(result, namespace.session)
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
    if namespace.subcommand in ("spawn", "spawn-tab") and isinstance(result, dict):
        # Record where the agent landed so ledgers can audit placement.
        result = {**result, "placement": "pane" if cmd == "pane.spawn" else "tab"}
    print(json.dumps(result, ensure_ascii=False))
    if failed:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
