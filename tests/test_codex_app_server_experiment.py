"""Version-pinned stdio probe tests; no real CLI, auth changes or paid turns."""
from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
import subprocess
import uuid

import pytest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("s5_stdio_probe", ROOT / "scripts/verify_codex_app_server_experiment.py")
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


def test_live_evidence_has_one_unique_send_and_independent_receipt_events():
    evidence = json.loads((ROOT / "tests/fixtures/codex-app-server/0.160.0-roundtrip.json").read_text(encoding="utf-8"))
    assert evidence["cliVersion"] == "0.160.0" and evidence["success"] is True
    assert evidence["reply"].strip() == probe.REPLY and evidence["toolItems"] == []
    assert evidence["ownedProcessExit"] == 0
    events = evidence["events"]
    sends = [e for e in events if e["direction"] == "send" and e["method"] == "turn/start"]
    assert len(sends) == 1 and sends[0]["id"] == evidence["requestId"]
    assert evidence["requestId"] == "send:" + evidence["operationId"]
    receipt = [e for e in events if e["direction"] == "receive" and e["id"] == evidence["requestId"] and e.get("accepted")]
    assert len(receipt) == 1 and receipt[0]["turnId"] == evidence["turnId"]
    for method in ["turn/started", "turn/completed"]:
        observed = [e for e in events if e["method"] == method]
        assert len(observed) == 1
        assert observed[0]["threadId"] == evidence["threadId"] and observed[0]["turnId"] == evidence["turnId"]
        assert observed[0]["at"]
    assert set(evidence["configuration"]["requested"]) == {"cwd", "ephemeral"}
    assert "serviceTier" in evidence["configuration"]["effective"]


def test_child_environment_isolated_without_mutating_the_parent(monkeypatch):
    monkeypatch.setenv("MYCMUX_SESSION_ID", "test-owned-pane")
    monkeypatch.setenv("mycmux_control_marker", "test-marker")
    monkeypatch.setenv("__CMUX_ATTACH", "test-attach")
    monkeypatch.setenv("S5_INHERITED_SETTING", "test-inherited")
    inherited = probe.child_environment()
    assert not any(key.upper().startswith(("MYCMUX_", "__CMUX_")) for key in inherited)
    assert inherited["S5_INHERITED_SETTING"] == "test-inherited"
    assert probe.os.environ["MYCMUX_SESSION_ID"] == "test-owned-pane"


class CapturedInput(io.BytesIO):
    captured = b""

    def close(self):
        self.captured = self.getvalue()
        super().close()


def fake_server(monkeypatch, frames, version="0.160.0"):
    class Server:
        stdin = CapturedInput()
        stdout = io.BytesIO(b"".join(json.dumps(frame).encode("ascii") + b"\n" for frame in frames))
        returncode = 0

        def wait(self, timeout):
            return 0

    server = Server()
    calls = []

    def spawn(args, **kwargs):
        calls.append((args, kwargs))
        return server

    monkeypatch.setattr(probe.subprocess, "run", lambda *args, **kwargs: subprocess.CompletedProcess(args, 0, f"codex-cli {version}\n".encode(), b""))
    monkeypatch.setattr(probe.subprocess, "Popen", spawn)
    monkeypatch.setattr(probe.uuid, "uuid4", lambda: uuid.UUID("00000000-0000-4000-8000-000000000001"))
    return server, calls


def test_probe_handles_completion_before_the_receipt_and_writes_only_selected_evidence(monkeypatch, tmp_path):
    operation = "00000000-0000-4000-8000-000000000001"
    thread, turn = "thread-fixture", "turn-fixture"
    frames = [
        {"id": "initialize", "result": {"userAgent": "mycmux_openai_probe/0.160.0 (0.1.0)"}},
        {"id": "thread:start", "result": {"thread": {"id": thread}, "model": "fixture-model", "reasoningEffort": "max"}},
        {"method": "turn/started", "params": {"threadId": thread, "turn": {"id": turn, "status": "inProgress"}}},
        {"method": "item/agentMessage/delta", "params": {"threadId": thread, "turnId": turn, "delta": probe.REPLY}},
        {"method": "item/commandExecution/requestApproval", "id": 77, "params": {"threadId": thread, "command": "private-fixture-content"}},
        {"method": "turn/completed", "params": {"threadId": thread, "turn": {"id": turn, "status": "completed"}}},
        {"id": "send:" + operation, "result": {"turn": {"id": turn}}},
    ]
    server, calls = fake_server(monkeypatch, frames)
    output = tmp_path / "roundtrip.json"
    result = probe.run_probe(Path("test-native-codex"), tmp_path, output)
    assert result["success"] and result["started"] and result["completed"]
    messages = [json.loads(line) for line in server.stdin.captured.splitlines()]
    assert [m.get("method") for m in messages] == ["initialize", "initialized", "thread/start", "turn/start", None]
    assert messages[2]["params"] == {"cwd": str(tmp_path), "ephemeral": True}
    assert messages[3]["params"]["clientUserMessageId"] == operation
    assert messages[4] == {"id": 77, "error": {"code": -32601, "message": "unsupported by mycmux one-turn experiment"}}
    assert calls[0][0][1:] == ["app-server", "--listen", "stdio://"]
    saved = output.read_text(encoding="utf-8")
    assert "private-fixture-content" not in saved and "\ufffd" not in saved
    assert json.loads(saved) == result


def test_probe_rejects_another_version_without_launch_or_retry(monkeypatch, tmp_path):
    _, calls = fake_server(monkeypatch, [], version="0.161.0")
    result = probe.run_probe(Path("test-native-codex"), tmp_path, tmp_path / "failure.json")
    assert result["success"] is False and result["failure"] == "unsupported CLI version"
    assert calls == [] and result["events"] == []


def test_probe_wire_contract_does_not_override_account_or_execution_settings():
    assert set(probe.thread_start_params("C:/trial")) == {"cwd", "ephemeral"}
    assert probe.turn_start_params("thread", "hello", "operation") == {
        "threadId": "thread", "clientUserMessageId": "operation", "input": [{"type": "text", "text": "hello"}],
    }


@pytest.mark.parametrize("kind", ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall",
                                  "collabAgentToolCall", "webSearch", "imageView", "unknown-item"])
def test_probe_cannot_certify_a_tool_or_unknown_item_as_a_text_only_trial(monkeypatch, tmp_path, kind):
    operation = "00000000-0000-4000-8000-000000000001"
    thread, turn = "thread-fixture", "turn-fixture"
    frames = [
        {"id": "initialize", "result": {"userAgent": "probe/0.160.0"}},
        {"id": "thread:start", "result": {"thread": {"id": thread}}},
        {"id": "send:" + operation, "result": {"turn": {"id": turn}}},
        {"method": "turn/started", "params": {"threadId": thread, "turn": {"id": turn}}},
        {"method": "item/started", "params": {"threadId": thread, "turnId": turn, "item": {"type": kind}}},
        {"method": "item/agentMessage/delta", "params": {"threadId": thread, "turnId": turn, "delta": probe.REPLY}},
        {"method": "turn/completed", "params": {"threadId": thread, "turn": {"id": turn, "status": "completed"}}},
    ]
    fake_server(monkeypatch, frames)
    result = probe.run_probe(Path("test-native-codex"), tmp_path, tmp_path / "non-conversation-item.json")
    assert result["toolItems"] == [kind]
    assert result["started"] and result["completed"] and result["reply"] == probe.REPLY
    assert result["success"] is False
