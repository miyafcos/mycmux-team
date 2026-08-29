from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_ROOT))

from server.mycmux_control_server import (  # noqa: E402
    BridgeStore,
    DASHBOARD_URI,
    MycmuxClient,
    MycmuxControlService,
    SUPPORTED_PROTOCOL_VERSION,
    ToolFailure,
    dashboard_resource,
    tool_definitions,
)
import server.mycmux_control_server as control_server  # noqa: E402


FAKE_TAB_ID = "tab-1"
FAKE_SESSION_ID = "pty-workspace-pane-tab-1"


def write_fake_cli(root: Path) -> Path:
    path = root / "fake_mycmux_cli.py"
    path.write_text(
        """
import json
import sys

snapshot = {
    "activePaneId": "pty-workspace-pane-tab-1",
    "activeSessionId": "pty-workspace-pane-tab-1",
    "activeWorkspaceId": "workspace-1",
    "workspaces": [{
        "workspaceId": "workspace-1",
        "workspaceName": "Test workspace",
        "splitColumns": [["pane-1"]],
        "columnWidths": [1],
        "rowHeightsPerCol": [[1]],
    }],
    "panes": [{
        "workspaceId": "workspace-1",
        "workspaceName": "Test workspace",
        "id": "pane-1",
        "active": True,
        "activeTabId": "tab-1",
        "tabs": [{
            "id": "tab-1",
            "sessionId": "pty-workspace-pane-tab-1",
            "label": "Test Codex",
            "agentKind": "codex",
            "agentSessionId": "agent-session-1",
            "agentStatus": "working",
            "agentStatusStale": False,
            "processStatus": "working",
            "screenObserved": True,
        }],
    }],
}

if sys.argv[1:3] == ["panes", "--all"]:
    print(json.dumps(snapshot))
elif sys.argv[1] == "read":
    session = sys.argv[sys.argv.index("--session") + 1]
    lines = int(sys.argv[sys.argv.index("--lines") + 1])
    print(json.dumps({"sessionId": session, "lines": ["line one", "line two"][-lines:]}))
elif sys.argv[1] == "env":
    import os
    print(json.dumps({"secretPresent": "CONTROL_PLANE_API_KEY" in os.environ or "OPENAI_API_KEY" in os.environ}))
else:
    print("unsupported", file=sys.stderr)
    raise SystemExit(3)
""".lstrip(),
        encoding="utf-8",
    )
    return path


class BridgeStoreTests(unittest.TestCase):
    def test_pair_enqueue_list_and_acknowledge(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = BridgeStore(Path(temporary))
            pane = {"id": "pane-1", "workspaceId": "workspace-1", "workspaceName": "Workspace"}
            tab = {
                "id": FAKE_TAB_ID,
                "label": "Test Codex",
                "sessionId": FAKE_SESSION_ID,
                "agentSessionId": "agent-1",
            }
            first = store.pair("chat-key", tab, pane)
            second = store.pair("chat-key", tab, pane)
            self.assertEqual(first["bindingId"], second["bindingId"])
            self.assertEqual(second["revision"], 1)
            self.assertEqual(first["updatedAt"], second["updatedAt"])

            message = store.enqueue(
                second["bindingId"],
                "chatgpt_to_mycmux",
                "instruction",
                "Run the focused verification.",
                ["REPORT.md"],
                "request-1",
            )
            retried = store.enqueue(
                second["bindingId"],
                "chatgpt_to_mycmux",
                "instruction",
                "Run the focused verification.",
                ["REPORT.md"],
                "request-1",
            )
            self.assertEqual(message["messageId"], retried["messageId"])
            queued = store.messages(binding_id=second["bindingId"], status="queued")
            self.assertEqual([message["messageId"]], [item["messageId"] for item in queued])
            acknowledged = store.acknowledge(second["bindingId"], message["messageId"])
            self.assertEqual("consumed", acknowledged["status"])
            acknowledged_again = store.acknowledge(second["bindingId"], message["messageId"])
            self.assertEqual(acknowledged["updatedAt"], acknowledged_again["updatedAt"])
            self.assertEqual([], store.messages(binding_id=second["bindingId"], status="queued"))

    def test_unknown_binding_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = BridgeStore(Path(temporary))
            with self.assertRaisesRegex(ToolFailure, "not paired"):
                store.enqueue("missing", "mycmux_to_chatgpt", "checkpoint", "State")


class MycmuxClientTests(unittest.TestCase):
    def test_discovery_survives_codex_plugin_cache_copy(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cached_plugin_root = root / ".codex" / "plugins" / "cache" / "personal" / "mycmux-control" / "0.1.0"
            cached_plugin_root.mkdir(parents=True)
            checkout = root / "cmux-for-linux-dev-master"
            cli = checkout / "scripts" / "mycmux_agent_cli.py"
            cli.parent.mkdir(parents=True)
            cli.write_text("# test\n", encoding="utf-8")
            env = {
                "USERPROFILE": str(root),
                "MYCMUX_AGENT_CLI": "",
                "MYCMUX_REPO_ROOT": "",
            }
            with mock.patch.object(control_server, "PLUGIN_ROOT", cached_plugin_root), mock.patch.dict(
                os.environ, env, clear=False
            ):
                self.assertEqual(cli.resolve(), MycmuxClient._discover_cli().resolve())

    def test_read_validates_current_registry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            cli = write_fake_cli(Path(temporary))
            client = MycmuxClient(cli)
            result = client.read_screen(FAKE_SESSION_ID, 80)
            self.assertEqual(["line one", "line two"], result["lines"])
            self.assertEqual("logical_screen_not_transcript", result["completeness"])
            with self.assertRaisesRegex(ToolFailure, "not present"):
                client.read_screen("pty-missing", 80)

    def test_cli_child_does_not_inherit_tunnel_api_keys(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            client = MycmuxClient(write_fake_cli(Path(temporary)))
            with mock.patch.dict(
                os.environ,
                {"CONTROL_PLANE_API_KEY": "secret-control", "OPENAI_API_KEY": "secret-openai"},
                clear=False,
            ):
                self.assertFalse(client._run(["env"])["secretPresent"])


class ServiceTests(unittest.TestCase):
    def test_tool_surface_has_no_terminal_writes(self) -> None:
        names = {item["name"] for item in tool_definitions()}
        self.assertEqual(
            {
                "get_control_map",
                "open_mycmux_dashboard",
                "read_session_screen",
                "pair_session",
                "enqueue_handoff",
                "list_handoffs",
                "acknowledge_handoff",
            },
            names,
        )
        for forbidden in ("send", "spawn", "close", "move", "focus", "raw"):
            self.assertFalse(any(forbidden in name for name in names))

    def test_control_map_and_pairing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            service = MycmuxControlService(MycmuxClient(write_fake_cli(root)), BridgeStore(root / "state"))
            control_map = service.control_map()
            self.assertEqual(1, control_map["summary"]["tabCount"])
            self.assertNotIn("agentSessionId", control_map["panes"][0]["tabs"][0])
            paired = service.call_tool("pair_session", {"chatTaskKey": "chat-key", "tabId": FAKE_TAB_ID})
            self.assertEqual(FAKE_TAB_ID, paired["structuredContent"]["binding"]["tabId"])
            sanitized = service.control_map()["bindings"][0]
            self.assertNotIn("chatTaskKey", sanitized)
            self.assertNotIn("agentSessionId", sanitized)


class ProtocolTests(unittest.TestCase):
    def test_stdio_initialize_list_call_and_resource(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fake_cli = write_fake_cli(root)
            env = os.environ.copy()
            env["MYCMUX_AGENT_CLI"] = str(fake_cli)
            env["MYCMUX_CHATGPT_STATE_DIR"] = str(root / "state")
            requests = [
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
                {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
                {"jsonrpc": "2.0", "id": "two", "method": "tools/list", "params": {}},
                {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "get_control_map", "arguments": {}}},
                {"jsonrpc": "2.0", "id": 4, "method": "resources/read", "params": {"uri": DASHBOARD_URI}},
                {"jsonrpc": "2.0", "id": 5, "method": "unknown", "params": {}},
            ]
            completed = subprocess.run(
                [sys.executable, str(PLUGIN_ROOT / "server" / "mycmux_control_server.py")],
                input="".join(json.dumps(item) + "\n" for item in requests),
                capture_output=True,
                text=True,
                encoding="utf-8",
                env=env,
                timeout=15,
                check=False,
            )
            self.assertEqual(0, completed.returncode, completed.stderr)
            self.assertEqual("", completed.stderr)
            responses = [json.loads(line) for line in completed.stdout.splitlines()]
            self.assertEqual([1, "two", 3, 4, 5], [item["id"] for item in responses])
            self.assertEqual(SUPPORTED_PROTOCOL_VERSION, responses[0]["result"]["protocolVersion"])
            self.assertEqual(1, responses[2]["result"]["structuredContent"]["summary"]["tabCount"])
            self.assertEqual("text/html;profile=mcp-app", responses[3]["result"]["contents"][0]["mimeType"])
            self.assertEqual(-32601, responses[4]["error"]["code"])

    def test_stdio_rejects_malformed_and_invalid_requests_without_internal_details(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            env = os.environ.copy()
            env["MYCMUX_AGENT_CLI"] = str(write_fake_cli(root))
            env["MYCMUX_CHATGPT_STATE_DIR"] = str(root / "state")
            lines = [
                "{not-json}\n",
                json.dumps(["not", "an", "object"]) + "\n",
                json.dumps({"jsonrpc": "1.0", "id": 1, "method": "ping"}) + "\n",
                json.dumps({"jsonrpc": "2.0", "id": 2, "method": "ping", "params": []}) + "\n",
            ]
            completed = subprocess.run(
                [sys.executable, str(PLUGIN_ROOT / "server" / "mycmux_control_server.py")],
                input="".join(lines),
                capture_output=True,
                text=True,
                encoding="utf-8",
                env=env,
                timeout=15,
                check=False,
            )
            self.assertEqual(0, completed.returncode, completed.stderr)
            responses = [json.loads(line) for line in completed.stdout.splitlines()]
            self.assertEqual([-32700, -32600, -32600, -32602], [item["error"]["code"] for item in responses])
            self.assertNotIn("Traceback", completed.stderr)


class ManifestAndUiTests(unittest.TestCase):
    def test_manifests_and_paths(self) -> None:
        manifest = json.loads((PLUGIN_ROOT / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8"))
        mcp = json.loads((PLUGIN_ROOT / ".mcp.json").read_text(encoding="utf-8"))
        app = json.loads((PLUGIN_ROOT / ".app.json").read_text(encoding="utf-8"))
        self.assertEqual("mycmux-control", manifest["name"])
        self.assertIsInstance(manifest["interface"]["defaultPrompt"], list)
        server_config = mcp["mcpServers"]["mycmux-control"]
        self.assertEqual("python", server_config["command"])
        self.assertTrue((PLUGIN_ROOT / server_config["args"][0]).is_file())
        self.assertEqual({}, app["apps"])

    def test_dashboard_resource_is_safe_and_self_contained(self) -> None:
        resource = dashboard_resource()["contents"][0]
        html = resource["text"]
        self.assertEqual(DASHBOARD_URI, resource["uri"])
        self.assertEqual("text/html;profile=mcp-app", resource["mimeType"])
        self.assertEqual([], resource["_meta"]["ui"]["csp"]["connectDomains"])
        self.assertEqual([], resource["_meta"]["ui"]["csp"]["resourceDomains"])
        self.assertIn('callTool("read_session_screen"', html)
        self.assertIn("sendFollowUpMessage", html)
        self.assertIn("ui/notifications/tool-result", html)
        self.assertIn("textContent", html)
        self.assertNotIn("innerHTML", html)
        self.assertNotIn("fetch(", html)
        self.assertNotIn("WebSocket", html)
        self.assertNotIn("<script src=", html)

    def test_handoff_tool_contract_is_scoped_and_retry_safe(self) -> None:
        tools = {item["name"]: item for item in tool_definitions()}
        enqueue = tools["enqueue_handoff"]["inputSchema"]
        self.assertNotIn("direction", enqueue["properties"])
        self.assertIn("dedupeKey", enqueue["required"])
        self.assertIn("bindingId", tools["list_handoffs"]["inputSchema"]["required"])
        self.assertIn("bindingId", tools["acknowledge_handoff"]["inputSchema"]["required"])


@unittest.skipUnless(os.name == "nt", "PowerShell wrapper is Windows-specific")
class SecureTunnelWrapperTests(unittest.TestCase):
    def test_validate_never_prints_runtime_key_value(self) -> None:
        powershell = shutil.which("powershell") or shutil.which("pwsh")
        self.assertIsNotNone(powershell)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fake_client = root / "tunnel-client.cmd"
            fake_client.write_text(
                '@echo off\r\nif "%1"=="--version" echo tunnel-client version test\r\nexit /b 0\r\n',
                encoding="utf-8",
            )
            secret = "SECRET_SENTINEL_MUST_NOT_APPEAR"
            env = os.environ.copy()
            env["CONTROL_PLANE_API_KEY"] = secret
            script = PLUGIN_ROOT / "scripts" / "secure_mcp_tunnel.ps1"
            completed = subprocess.run(
                [
                    powershell,
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(script),
                    "-Mode",
                    "Validate",
                    "-TunnelClientPath",
                    str(fake_client),
                    "-ProfileDir",
                    str(root / "profiles"),
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=env,
                timeout=15,
                check=False,
            )
            self.assertEqual(0, completed.returncode, completed.stderr)
            self.assertNotIn(secret, completed.stdout + completed.stderr)
            report = json.loads(completed.stdout.strip())
            self.assertTrue(report["apiKeyPresent"])
            self.assertEqual("127.0.0.1:0", report["healthListenAddress"])
            self.assertEqual(1, report["maxConcurrentMcpRequests"])

    def test_plan_masks_tunnel_id_and_disables_remote_admin_surface(self) -> None:
        powershell = shutil.which("powershell") or shutil.which("pwsh")
        self.assertIsNotNone(powershell)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fake_client = root / "tunnel-client.cmd"
            fake_client.write_text("@echo off\r\nexit /b 0\r\n", encoding="utf-8")
            tunnel_id = "tunnel_ABCDEF123456"
            script = PLUGIN_ROOT / "scripts" / "secure_mcp_tunnel.ps1"
            completed = subprocess.run(
                [
                    powershell,
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(script),
                    "-Mode",
                    "Plan",
                    "-TunnelId",
                    tunnel_id,
                    "-TunnelClientPath",
                    str(fake_client),
                    "-ProfileDir",
                    str(root / "profiles"),
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=15,
                check=False,
            )
            self.assertEqual(0, completed.returncode, completed.stderr)
            self.assertNotIn(tunnel_id, completed.stdout + completed.stderr)
            report = json.loads(completed.stdout.strip())
            self.assertEqual("***123456", report["tunnelId"])
            self.assertFalse(report["remoteAdminUiEnabled"])
            self.assertFalse(report["rawHttpLoggingEnabled"])


if __name__ == "__main__":
    unittest.main()
