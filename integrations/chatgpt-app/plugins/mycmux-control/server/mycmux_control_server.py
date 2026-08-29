from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4


SERVER_NAME = "mycmux-control"
SERVER_VERSION = "0.2.0"
SUPPORTED_PROTOCOL_VERSION = "2025-06-18"
DASHBOARD_URI = "ui://mycmux-control/dashboard-v1.html"
PLUGIN_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_STATE_DIR = Path.home() / ".mycmux" / "chatgpt-bridge"
ALLOWED_DIRECTIONS = {"mycmux_to_chatgpt", "chatgpt_to_mycmux"}
ALLOWED_KINDS = {"checkpoint", "question", "answer", "instruction", "handoff", "evidence"}
SENSITIVE_ENV_SUFFIXES = ("_API_KEY", "_ACCESS_TOKEN", "_AUTH_TOKEN", "_SECRET", "_PASSWORD")
SENSITIVE_ENV_NAMES = {
    "CONTROL_PLANE_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_ADMIN_KEY",
    "CLOUDFLARED_TUNNEL_TOKEN",
}


class ToolFailure(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def require_text(value: Any, field: str, *, maximum: int = 20_000) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ToolFailure(f"{field} must be a non-empty string")
    normalized = value.strip()
    if len(normalized) > maximum:
        raise ToolFailure(f"{field} exceeds {maximum} characters")
    return normalized


def state_directory() -> Path:
    configured = os.environ.get("MYCMUX_CHATGPT_STATE_DIR")
    return Path(configured).expanduser().resolve() if configured else DEFAULT_STATE_DIR


class BridgeStore:
    def __init__(self, root: Path | None = None) -> None:
        self.root = (root or state_directory()).resolve()
        self.path = self.root / "state.json"
        self._lock = threading.Lock()

    @staticmethod
    def empty_state() -> dict[str, Any]:
        return {"version": 1, "bindings": [], "messages": []}

    def _load_unlocked(self) -> dict[str, Any]:
        if not self.path.exists():
            return self.empty_state()
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ToolFailure(f"bridge state is unreadable: {exc}") from exc
        if not isinstance(data, dict) or data.get("version") != 1:
            raise ToolFailure("bridge state has an unsupported schema")
        if not isinstance(data.get("bindings"), list) or not isinstance(data.get("messages"), list):
            raise ToolFailure("bridge state is missing bindings or messages")
        return data

    def _save_unlocked(self, state: dict[str, Any]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        handle, temporary_name = tempfile.mkstemp(prefix="state-", suffix=".json", dir=self.root)
        temporary_path = Path(temporary_name)
        try:
            with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
                json.dump(state, stream, ensure_ascii=False, indent=2)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_path, self.path)
        finally:
            if temporary_path.exists():
                temporary_path.unlink()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return json.loads(json.dumps(self._load_unlocked(), ensure_ascii=False))

    def pair(self, chat_task_key: str, tab: dict[str, Any], pane: dict[str, Any]) -> dict[str, Any]:
        chat_task_key = require_text(chat_task_key, "chatTaskKey", maximum=256)
        tab_id = require_text(tab.get("id"), "tab.id", maximum=256)
        digest = hashlib.sha256(f"{chat_task_key}\0{tab_id}".encode("utf-8")).hexdigest()[:24]
        binding_id = f"bind_{digest}"
        now = utc_now()
        with self._lock:
            state = self._load_unlocked()
            existing = next((item for item in state["bindings"] if item.get("bindingId") == binding_id), None)
            current_values = {
                "bindingId": binding_id,
                "chatTaskKey": chat_task_key,
                "workspaceId": pane.get("workspaceId"),
                "workspaceName": pane.get("workspaceName"),
                "paneId": pane.get("id"),
                "tabId": tab_id,
                "tabLabel": tab.get("label"),
                "ptySessionId": tab.get("sessionId"),
                "agentSessionId": tab.get("agentSessionId"),
                "status": "paired",
            }
            if existing and all(existing.get(key) == value for key, value in current_values.items()):
                return dict(existing)
            binding = {
                **current_values,
                "updatedAt": now,
                "revision": int(existing.get("revision", 0)) + 1 if existing else 1,
                "createdAt": existing.get("createdAt", now) if existing else now,
            }
            if existing:
                state["bindings"][state["bindings"].index(existing)] = binding
            else:
                state["bindings"].append(binding)
            self._save_unlocked(state)
            return binding

    def enqueue(
        self,
        binding_id: str,
        direction: str,
        kind: str,
        summary: str,
        evidence_refs: list[str] | None = None,
        dedupe_key: str | None = None,
    ) -> dict[str, Any]:
        binding_id = require_text(binding_id, "bindingId", maximum=128)
        direction = require_text(direction, "direction", maximum=64)
        kind = require_text(kind, "kind", maximum=64)
        summary = require_text(summary, "summary")
        if direction not in ALLOWED_DIRECTIONS:
            raise ToolFailure(f"direction must be one of {sorted(ALLOWED_DIRECTIONS)}")
        if kind not in ALLOWED_KINDS:
            raise ToolFailure(f"kind must be one of {sorted(ALLOWED_KINDS)}")
        refs = evidence_refs or []
        if not isinstance(refs, list) or len(refs) > 20 or any(not isinstance(item, str) for item in refs):
            raise ToolFailure("evidenceRefs must be an array of at most 20 strings")
        normalized_refs = [item.strip() for item in refs if item.strip()]
        normalized_dedupe_key = (
            require_text(dedupe_key, "dedupeKey", maximum=256) if dedupe_key is not None else None
        )
        now = utc_now()
        with self._lock:
            state = self._load_unlocked()
            if not any(item.get("bindingId") == binding_id for item in state["bindings"]):
                raise ToolFailure("bindingId is not paired")
            if normalized_dedupe_key:
                existing = next(
                    (
                        item
                        for item in state["messages"]
                        if item.get("bindingId") == binding_id
                        and item.get("direction") == direction
                        and item.get("dedupeKey") == normalized_dedupe_key
                    ),
                    None,
                )
                if existing:
                    same_payload = (
                        existing.get("kind") == kind
                        and existing.get("summary") == summary
                        and existing.get("evidenceRefs") == normalized_refs
                    )
                    if not same_payload:
                        raise ToolFailure("dedupeKey is already used for a different handoff")
                    return dict(existing)
            message = {
                "messageId": f"msg_{uuid4().hex}",
                "bindingId": binding_id,
                "direction": direction,
                "kind": kind,
                "summary": summary,
                "evidenceRefs": normalized_refs,
                "dedupeKey": normalized_dedupe_key,
                "status": "queued",
                "createdAt": now,
                "updatedAt": now,
            }
            state["messages"].append(message)
            self._save_unlocked(state)
            return message

    def messages(
        self,
        *,
        binding_id: str | None = None,
        direction: str | None = None,
        status: str | None = None,
    ) -> list[dict[str, Any]]:
        state = self.snapshot()
        items = state["messages"]
        if binding_id:
            items = [item for item in items if item.get("bindingId") == binding_id]
        if direction:
            if direction not in ALLOWED_DIRECTIONS:
                raise ToolFailure(f"direction must be one of {sorted(ALLOWED_DIRECTIONS)}")
            items = [item for item in items if item.get("direction") == direction]
        if status:
            items = [item for item in items if item.get("status") == status]
        return list(reversed(items[-200:]))

    def acknowledge(self, binding_id: str, message_id: str) -> dict[str, Any]:
        binding_id = require_text(binding_id, "bindingId", maximum=128)
        message_id = require_text(message_id, "messageId", maximum=128)
        with self._lock:
            state = self._load_unlocked()
            item = next((entry for entry in state["messages"] if entry.get("messageId") == message_id), None)
            if not item:
                raise ToolFailure("messageId was not found")
            if item.get("bindingId") != binding_id:
                raise ToolFailure("messageId does not belong to bindingId")
            if item.get("status") == "consumed":
                return dict(item)
            item["status"] = "consumed"
            item["updatedAt"] = utc_now()
            self._save_unlocked(state)
            return dict(item)


class MycmuxClient:
    def __init__(self, cli_path: Path | None = None) -> None:
        self.cli_path = (cli_path or self._discover_cli()).resolve()

    @staticmethod
    def _discover_cli() -> Path:
        configured = os.environ.get("MYCMUX_AGENT_CLI")
        if configured:
            candidate = Path(configured).expanduser()
            if candidate.is_file():
                return candidate
            raise ToolFailure(f"MYCMUX_AGENT_CLI does not exist: {candidate}")

        repo_root = os.environ.get("MYCMUX_REPO_ROOT")
        if repo_root:
            candidate = Path(repo_root).expanduser() / "scripts" / "mycmux_agent_cli.py"
            if candidate.is_file():
                return candidate
            raise ToolFailure(f"MYCMUX_REPO_ROOT does not contain scripts/mycmux_agent_cli.py: {repo_root}")

        search_roots = [PLUGIN_ROOT]
        search_roots.extend(PLUGIN_ROOT.parents)
        for parent in search_roots:
            candidate = parent / "scripts" / "mycmux_agent_cli.py"
            if candidate.is_file():
                return candidate

        user_profile = os.environ.get("USERPROFILE")
        if user_profile:
            for checkout_name in ("cmux-for-linux-dev-master", "mycmux"):
                candidate = Path(user_profile) / checkout_name / "scripts" / "mycmux_agent_cli.py"
                if candidate.is_file():
                    return candidate

        search_roots = [Path.cwd()]
        search_roots.extend(Path.cwd().parents)
        for parent in search_roots:
            candidate = parent / "scripts" / "mycmux_agent_cli.py"
            if candidate.is_file():
                return candidate

        raise ToolFailure(
            "scripts/mycmux_agent_cli.py was not found; set MYCMUX_AGENT_CLI or MYCMUX_REPO_ROOT"
        )

    def _run(self, arguments: list[str]) -> dict[str, Any]:
        command = [sys.executable, str(self.cli_path), *arguments]
        child_env = os.environ.copy()
        for name in list(child_env):
            upper_name = name.upper()
            if upper_name in SENSITIVE_ENV_NAMES or upper_name.endswith(SENSITIVE_ENV_SUFFIXES):
                child_env.pop(name, None)
        try:
            completed = subprocess.run(
                command,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=15,
                check=False,
                env=child_env,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ToolFailure(f"mycmux CLI could not be executed: {exc}") from exc
        if completed.returncode != 0:
            raise ToolFailure(f"mycmux CLI failed with exit code {completed.returncode}")
        try:
            result = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise ToolFailure("mycmux CLI returned invalid JSON") from exc
        if not isinstance(result, dict):
            raise ToolFailure("mycmux CLI returned a non-object response")
        return result

    def panes(self) -> dict[str, Any]:
        return self._run(["panes", "--all"])

    @staticmethod
    def find_session(snapshot: dict[str, Any], session_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        session_id = require_text(session_id, "sessionId", maximum=512)
        matches: list[tuple[dict[str, Any], dict[str, Any]]] = []
        for pane in snapshot.get("panes", []):
            for tab in pane.get("tabs", []):
                if tab.get("sessionId") == session_id:
                    matches.append((pane, tab))
        if not matches:
            raise ToolFailure("sessionId is not present in the current mycmux registry")
        if len(matches) != 1:
            raise ToolFailure("sessionId is duplicated in the current mycmux registry")
        return matches[0]

    @staticmethod
    def find_tab(snapshot: dict[str, Any], tab_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        tab_id = require_text(tab_id, "tabId", maximum=256)
        matches: list[tuple[dict[str, Any], dict[str, Any]]] = []
        for pane in snapshot.get("panes", []):
            for tab in pane.get("tabs", []):
                if tab.get("id") == tab_id:
                    matches.append((pane, tab))
        if not matches:
            raise ToolFailure("tabId is not present in the current mycmux registry")
        if len(matches) != 1:
            raise ToolFailure("tabId is duplicated in the current mycmux registry")
        return matches[0]

    def read_screen(self, session_id: str, lines: int) -> dict[str, Any]:
        snapshot = self.panes()
        pane, tab = self.find_session(snapshot, session_id)
        line_count = max(1, min(int(lines), 400))
        screen = self._run(["read", "--session", session_id, "--lines", str(line_count)])
        return {
            "source": "mycmux_pty",
            "observedAt": utc_now(),
            "sessionId": session_id,
            "tabId": tab.get("id"),
            "tabLabel": tab.get("label"),
            "paneId": pane.get("id"),
            "workspaceId": pane.get("workspaceId"),
            "workspaceName": pane.get("workspaceName"),
            "lines": screen.get("lines", []),
            "lineCount": len(screen.get("lines", [])),
            "completeness": "logical_screen_not_transcript",
        }


class MycmuxControlService:
    def __init__(self, client: MycmuxClient | None = None, store: BridgeStore | None = None) -> None:
        self.client = client or MycmuxClient()
        self.store = store or BridgeStore()

    def control_map(self) -> dict[str, Any]:
        snapshot = self.client.panes()
        panes = [sanitize_pane(pane) for pane in snapshot.get("panes", [])]
        tabs = [tab for pane in panes for tab in pane.get("tabs", [])]
        states = {"working": 0, "waiting": 0, "done": 0, "idle": 0, "unknown": 0}
        for tab in tabs:
            state = (
                tab.get("processStatus")
                if tab.get("agentStatusStale")
                else tab.get("agentStatus") or tab.get("processStatus")
            ) or "unknown"
            states[state if state in states else "unknown"] += 1
        bridge_state = self.store.snapshot()
        return {
            "source": "mycmux_registry",
            "observedAt": utc_now(),
            "activeWorkspaceId": snapshot.get("activeWorkspaceId"),
            "activePtySessionId": snapshot.get("activeSessionId") or snapshot.get("activePaneId"),
            "summary": {
                "workspaceCount": len(snapshot.get("workspaces", [])),
                "paneCount": len(panes),
                "tabCount": len(tabs),
                "states": states,
                "bindingCount": len(bridge_state["bindings"]),
                "queuedMessageCount": sum(1 for item in bridge_state["messages"] if item.get("status") == "queued"),
            },
            "workspaces": [sanitize_workspace(item) for item in snapshot.get("workspaces", [])],
            "panes": panes,
            "bindings": [sanitize_binding(item) for item in bridge_state["bindings"]],
        }

    def dashboard(self) -> dict[str, Any]:
        data = self.control_map()
        data["handoffs"] = []
        data["screenMode"] = "on_demand_logical_screen"
        data["semanticEventsAvailable"] = False
        return data

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if name == "get_control_map":
            data = self.control_map()
            return tool_result(data, f"mycmux has {data['summary']['paneCount']} panes and {data['summary']['tabCount']} tabs.")
        if name == "open_mycmux_dashboard":
            data = self.dashboard()
            result = tool_result(data, "Opened the mycmux session dashboard.")
            result["_meta"] = {"ui": {"resourceUri": DASHBOARD_URI}}
            return result
        if name == "read_session_screen":
            session_id = require_text(arguments.get("sessionId"), "sessionId", maximum=512)
            lines = arguments.get("lines", 120)
            if not isinstance(lines, int):
                raise ToolFailure("lines must be an integer")
            data = self.client.read_screen(session_id, lines)
            return tool_result(data, f"Read {data['lineCount']} logical screen lines from {data['tabLabel']}.")
        if name == "pair_session":
            snapshot = self.client.panes()
            pane, tab = self.client.find_tab(snapshot, arguments.get("tabId"))
            binding = self.store.pair(arguments.get("chatTaskKey"), tab, pane)
            return tool_result({"binding": binding}, f"Paired {binding['tabLabel']} with the ChatGPT view key.")
        if name == "enqueue_handoff":
            message = self.store.enqueue(
                arguments.get("bindingId"),
                "chatgpt_to_mycmux",
                arguments.get("kind"),
                arguments.get("summary"),
                arguments.get("evidenceRefs"),
                arguments.get("dedupeKey"),
            )
            return tool_result({"message": message}, f"Queued {message['kind']} as {message['messageId']}.")
        if name == "list_handoffs":
            binding_id = require_text(arguments.get("bindingId"), "bindingId", maximum=128)
            messages = self.store.messages(
                binding_id=binding_id,
                direction=arguments.get("direction"),
                status=arguments.get("status"),
            )
            return tool_result({"messages": messages, "count": len(messages)}, f"Found {len(messages)} handoffs.")
        if name == "acknowledge_handoff":
            message = self.store.acknowledge(arguments.get("bindingId"), arguments.get("messageId"))
            return tool_result({"message": message}, f"Marked {message['messageId']} as consumed.")
        raise ToolFailure(f"unknown tool: {name}")


def tool_result(structured_content: dict[str, Any], message: str) -> dict[str, Any]:
    return {
        "structuredContent": structured_content,
        "content": [{"type": "text", "text": message}],
    }


def sanitize_workspace(workspace: dict[str, Any]) -> dict[str, Any]:
    allowed = (
        "workspaceId",
        "workspaceName",
        "splitColumns",
        "columnWidths",
        "rowHeightsPerCol",
    )
    return {key: workspace.get(key) for key in allowed if key in workspace}


def sanitize_tab(tab: dict[str, Any]) -> dict[str, Any]:
    allowed = (
        "id",
        "sessionId",
        "label",
        "agentKind",
        "agentStatus",
        "agentStatusStale",
        "agentStatusAt",
        "processStatus",
        "processStatusAt",
        "screenObserved",
        "lastOutputAt",
    )
    return {key: tab.get(key) for key in allowed if key in tab}


def sanitize_pane(pane: dict[str, Any]) -> dict[str, Any]:
    allowed = ("workspaceId", "workspaceName", "id", "active", "activeTabId")
    sanitized = {key: pane.get(key) for key in allowed if key in pane}
    sanitized["tabs"] = [sanitize_tab(tab) for tab in pane.get("tabs", []) if isinstance(tab, dict)]
    return sanitized


def sanitize_binding(binding: dict[str, Any]) -> dict[str, Any]:
    allowed = (
        "bindingId",
        "workspaceId",
        "workspaceName",
        "paneId",
        "tabId",
        "tabLabel",
        "status",
        "updatedAt",
        "createdAt",
        "revision",
    )
    return {key: binding.get(key) for key in allowed if key in binding}


def tool_definitions() -> list[dict[str, Any]]:
    no_input = {"type": "object", "properties": {}, "additionalProperties": False}
    return [
        {
            "name": "get_control_map",
            "title": "Get mycmux control map",
            "description": "List current mycmux workspaces, panes, tabs, status, stable IDs, and pairing counts without reading terminal contents.",
            "inputSchema": no_input,
            "annotations": {"readOnlyHint": True, "openWorldHint": False, "destructiveHint": False},
        },
        {
            "name": "open_mycmux_dashboard",
            "title": "Open mycmux session dashboard",
            "description": "Render an interactive dashboard for selecting mycmux tabs and reading a selected logical screen on demand.",
            "inputSchema": no_input,
            "annotations": {"readOnlyHint": True, "openWorldHint": False, "destructiveHint": False},
            "_meta": {
                "ui": {"resourceUri": DASHBOARD_URI},
                "openai/outputTemplate": DASHBOARD_URI,
                "openai/toolInvocation/invoking": "Opening mycmux…",
                "openai/toolInvocation/invoked": "mycmux dashboard ready.",
            },
        },
        {
            "name": "read_session_screen",
            "title": "Read mycmux session screen",
            "description": "Read 1 to 400 lines from the current logical screen of an exact PTY session ID returned by get_control_map. This is not a full transcript.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sessionId": {"type": "string"},
                    "lines": {"type": "integer", "minimum": 1, "maximum": 400, "default": 120},
                },
                "required": ["sessionId"],
                "additionalProperties": False,
            },
            "annotations": {"readOnlyHint": True, "openWorldHint": False, "destructiveHint": False},
        },
        {
            "name": "pair_session",
            "title": "Pair ChatGPT view with mycmux tab",
            "description": "Create or refresh a durable local binding between a ChatGPT UI key and an exact current mycmux tab ID. Does not write to the PTY.",
            "inputSchema": {
                "type": "object",
                "properties": {"chatTaskKey": {"type": "string"}, "tabId": {"type": "string"}},
                "required": ["chatTaskKey", "tabId"],
                "additionalProperties": False,
            },
            "annotations": {"readOnlyHint": False, "idempotentHint": True, "openWorldHint": False, "destructiveHint": False},
        },
        {
            "name": "enqueue_handoff",
            "title": "Queue structured handoff",
            "description": "Store a structured handoff for a paired tab. This writes only to the local bridge inbox/outbox and never to a terminal.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "bindingId": {"type": "string"},
                    "kind": {"type": "string", "enum": sorted(ALLOWED_KINDS)},
                    "summary": {"type": "string", "maxLength": 20000},
                    "evidenceRefs": {"type": "array", "items": {"type": "string"}, "maxItems": 20},
                    "dedupeKey": {"type": "string", "maxLength": 256},
                },
                "required": ["bindingId", "kind", "summary", "dedupeKey"],
                "additionalProperties": False,
            },
            "annotations": {"readOnlyHint": False, "idempotentHint": True, "openWorldHint": False, "destructiveHint": False},
        },
        {
            "name": "list_handoffs",
            "title": "List structured handoffs",
            "description": "List queued or consumed handoffs from the local bridge store.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "bindingId": {"type": "string"},
                    "direction": {"type": "string", "enum": sorted(ALLOWED_DIRECTIONS)},
                    "status": {"type": "string", "enum": ["queued", "consumed"]},
                },
                "required": ["bindingId"],
                "additionalProperties": False,
            },
            "annotations": {"readOnlyHint": True, "openWorldHint": False, "destructiveHint": False},
        },
        {
            "name": "acknowledge_handoff",
            "title": "Acknowledge structured handoff",
            "description": "Mark one local bridge handoff as consumed. Does not affect the mycmux terminal session.",
            "inputSchema": {
                "type": "object",
                "properties": {"bindingId": {"type": "string"}, "messageId": {"type": "string"}},
                "required": ["bindingId", "messageId"],
                "additionalProperties": False,
            },
            "annotations": {"readOnlyHint": False, "idempotentHint": True, "openWorldHint": False, "destructiveHint": False},
        },
    ]


def dashboard_resource() -> dict[str, Any]:
    html_path = PLUGIN_ROOT / "web" / "dashboard.html"
    try:
        html = html_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ToolFailure(f"dashboard resource is unavailable: {exc}") from exc
    return {
        "contents": [
            {
                "uri": DASHBOARD_URI,
                "mimeType": "text/html;profile=mcp-app",
                "text": html,
                "_meta": {
                    "ui": {
                        "prefersBorder": False,
                        "csp": {"connectDomains": [], "resourceDomains": []},
                    }
                },
            }
        ]
    }


def rpc_error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def handle_request(service: MycmuxControlService, request: dict[str, Any]) -> dict[str, Any] | None:
    request_id = request.get("id")
    if request.get("jsonrpc") != "2.0" or not isinstance(request.get("method"), str):
        return None if "id" not in request else rpc_error(request_id, -32600, "invalid JSON-RPC request")
    if "params" in request and not isinstance(request["params"], dict):
        return None if "id" not in request else rpc_error(request_id, -32602, "params must be an object")
    if "id" not in request:
        return None

    method = request["method"]
    params = request.get("params", {})
    if method == "initialize":
        requested = params.get("protocolVersion")
        if requested is not None and not isinstance(requested, str):
            return rpc_error(request_id, -32602, "protocolVersion must be a string")
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": SUPPORTED_PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}, "resources": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            },
        }
    if method == "ping":
        return {"jsonrpc": "2.0", "id": request_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": tool_definitions()}}
    if method == "tools/call":
        name = params.get("name")
        arguments = params.get("arguments", {})
        if not isinstance(name, str) or not name.strip() or not isinstance(arguments, dict):
            return rpc_error(request_id, -32602, "tools/call requires a tool name and object arguments")
        try:
            result = service.call_tool(name, arguments)
        except ToolFailure as exc:
            result = {"isError": True, "content": [{"type": "text", "text": str(exc)}]}
        return {"jsonrpc": "2.0", "id": request_id, "result": result}
    if method == "resources/list":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "resources": [
                    {"uri": DASHBOARD_URI, "name": "mycmux session dashboard", "mimeType": "text/html;profile=mcp-app"}
                ]
            },
        }
    if method == "resources/read":
        uri = params.get("uri")
        if uri != DASHBOARD_URI:
            return rpc_error(request_id, -32602, "unknown resource URI")
        try:
            result = dashboard_resource()
        except ToolFailure as exc:
            return rpc_error(request_id, -32000, "dashboard resource is unavailable")
        return {"jsonrpc": "2.0", "id": request_id, "result": result}
    return rpc_error(request_id, -32601, "method not found")


def run_stdio(service: MycmuxControlService | None = None) -> int:
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    active_service = service or MycmuxControlService()
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request: Any = None
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            response = rpc_error(None, -32700, "parse error")
        else:
            if not isinstance(request, dict):
                response = rpc_error(None, -32600, "invalid JSON-RPC request")
            else:
                try:
                    response = handle_request(active_service, request)
                except Exception as exc:  # Fail closed without returning sensitive details.
                    print(f"{SERVER_NAME}: internal request failure ({type(exc).__name__})", file=sys.stderr)
                    response = rpc_error(request.get("id"), -32603, "internal server error")
        if response is not None:
            sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    return 0


def self_test() -> int:
    definitions = tool_definitions()
    names = {item["name"] for item in definitions}
    forbidden = {"send", "spawn", "close", "move", "focus"}
    if names & forbidden:
        raise RuntimeError("unsafe tools are exposed")
    dashboard_resource()
    print(json.dumps({"ok": True, "tools": sorted(names), "dashboard": DASHBOARD_URI}, ensure_ascii=False))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="mycmux Control MCP server")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    return self_test() if args.self_test else run_stdio()


if __name__ == "__main__":
    raise SystemExit(main())
