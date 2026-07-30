from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import pytest


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "mycmux_doctor_lite.py"
SPEC = importlib.util.spec_from_file_location("mycmux_doctor_lite", SCRIPT_PATH)
assert SPEC and SPEC.loader
doctor = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = doctor
SPEC.loader.exec_module(doctor)


def pane_payload() -> dict:
    return {
        "activeWorkspaceId": "workspace-1",
        "activePaneId": "pane-1",
        "activeSessionId": "session-1",
        "workspaces": [{"id": "workspace-1", "name": "開発"}],
        "panes": [
            {
                "workspaceId": "workspace-1",
                "workspaceName": "開発",
                "id": "pane-1",
                "label": "計測",
                "active": True,
                "activeTabId": "tab-1",
                "tabs": [
                    {
                        "id": "tab-1",
                        "sessionId": "session-1",
                        "label": "Codex",
                        "agentKind": "codex",
                        "agentStatus": "working",
                        "processStatus": "running",
                        "lastOutputAt": "2026-07-29T00:00:00Z",
                    }
                ],
            }
        ],
    }


def gpu_payload() -> dict:
    return {
        "mycmux_pid": 100,
        "gpu_pid": 200,
        "sample_count": 3,
        "actual_duration_seconds": 3.0,
        "avg_cpu_percent_all_cores": 4.5,
        "max_cpu_percent_all_cores": 6.0,
        "csv_path": "C:/tmp/doctor.csv",
    }


def paint_payload() -> dict:
    return {
        "layers": {
            "inputParse": {
                "ptyReceivedBytes": 128,
                "batchBytes": {"count": 2, "min": 48, "avg": 64, "max": 80},
                "writeCalls": 2,
                "writeCallbackMs": {"p50": 1.5, "p95": 4.0},
                "pendingBytes": 0,
                "maxPendingBytes": 80,
                "onWriteParsedCalls": 2,
            },
            "render": {
                "onRenderCalls": 2,
                "renderedRows": 20,
                "fullScreenRenders": 1,
                "renderer": "webgl",
                "webglContextLosses": 0,
            },
            "surrounding": {
                "approvalScanMs": {"count": 2, "avg": 0.5},
                "resyncBytes": 0,
                "resyncMs": {"avg": None},
                "reactCommits": 4,
                "mountedXterms": 1,
                "focusedXterms": 1,
                "cursorBlinkingXterms": 1,
                "documentFocused": True,
                "documentVisibility": "visible",
            },
        }
    }


def session_state_payload() -> dict:
    return {
        "sessions": [{
            "session_id": "session-1",
            "view": {
                "session_id": "session-1",
                "lifecycle": "alive",
                "activity": "running_silent",
                "attention": {
                    "kind": "approval",
                    "detail": "Proceed?",
                    "sources": ["screen_scan", "hook"],
                },
                "health": "fresh",
            },
            "recent_evidence": [{
                "observed_at": 123,
                "source": "screen_scan",
                "signal": {"kind": "screen_scan", "detail": "Proceed?"},
            }],
        }],
    }


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def test_flatten_tabs_preserves_runtime_status() -> None:
    rows = doctor.flatten_tabs(pane_payload())
    assert rows == [
        {
            "workspace": "開発",
            "pane": "計測",
            "active": True,
            "session": "session-1",
            "tab": "Codex",
            "agent": "codex",
            "agent_status": "working",
            "process_status": "running",
            "last_output_at": "2026-07-29T00:00:00Z",
        }
    ]


def test_render_report_combines_runtime_gpu_and_three_layers() -> None:
    report = doctor.render_report(
        pane_payload(),
        gpu_payload(),
        paint_payload(),
        [],
        session_state_payload(),
    )
    assert "Workspaces: 1 / Panes: 1 / Tabs: 1" in report
    assert "Codex" in report
    assert "CPU avg all cores %" in report
    assert "PTY received bytes | 128" in report
    assert "React commits / mounted / focused | 4 / 1 / 1" in report
    assert "alive | running_silent | approval | fresh" in report
    assert "screen_scan, hook" in report
    assert "Proceed?" in report
    assert "Tab working set: unavailable" in report


def test_render_report_tolerates_malformed_offline_collection_shapes() -> None:
    report = doctor.render_report({"workspaces": None, "panes": None}, None, None, [])
    assert "Workspaces: 0 / Panes: 0 / Tabs: 0" in report
    assert "Runtime pane data: unavailable" in report


def test_collect_gpu_summary_uses_doctor_label_and_utf8_sig(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(doctor, "PERF_RESULTS_DIR", tmp_path)

    def fake_runner(command, **kwargs):
        assert "doctor" == command[command.index("-StateLabel") + 1]
        assert "2" == command[command.index("-SampleSeconds") + 1]
        summary_path = Path(command[command.index("-SummaryPath") + 1])
        summary_path.write_text(json.dumps(gpu_payload()), encoding="utf-8-sig")
        return subprocess.CompletedProcess(command, 0, stdout="ok", stderr="")

    result = doctor.collect_gpu_summary(2, 500, 100, runner=fake_runner)
    assert result["gpu_pid"] == 200


def test_collect_panes_falls_back_to_read_only_legacy_commands(monkeypatch) -> None:
    calls = []

    def fake_send(command, args):
        calls.append((command, args))
        if command == "pane.list_all":
            raise RuntimeError("unknown command: pane.list_all")
        if command == "workspace.list":
            return {"activeWorkspaceId": "workspace-1", "workspaces": [{"id": "workspace-1", "name": "開発"}]}
        return {"activePaneId": "session-1", "panes": pane_payload()["panes"]}

    monkeypatch.setattr(doctor, "send_request", fake_send)
    result = doctor.collect_panes()
    assert result["activeWorkspaceId"] == "workspace-1"
    assert len(result["panes"]) == 1
    assert calls == [
        ("pane.list_all", {}),
        ("workspace.list", {}),
        ("pane.list", {"workspaceId": "workspace-1"}),
    ]


def test_collect_session_state_uses_read_only_socket_command(monkeypatch) -> None:
    calls = []

    def fake_send(command, args):
        calls.append((command, args))
        return session_state_payload()

    monkeypatch.setattr(doctor, "send_request", fake_send)
    assert doctor.collect_session_state() == session_state_payload()
    assert calls == [("session.state_view", {})]


def test_main_offline_report_and_broken_paint_input(tmp_path, capsys) -> None:
    panes = tmp_path / "panes.json"
    gpu = tmp_path / "gpu.json"
    paint = tmp_path / "paint.json"
    session_state = tmp_path / "session-state.json"
    write_json(panes, pane_payload())
    write_json(gpu, gpu_payload())
    write_json(paint, paint_payload())
    write_json(session_state, session_state_payload())

    assert doctor.main([
        "--panes-json", str(panes),
        "--gpu-summary", str(gpu),
        "--paint-stats", str(paint),
        "--session-state-json", str(session_state),
    ]) == 0
    assert "# mycmux doctor-lite" in capsys.readouterr().out

    paint.write_text("not-json", encoding="utf-8")
    assert doctor.main([
        "--panes-json", str(panes),
        "--gpu-summary", str(gpu),
        "--paint-stats", str(paint),
    ]) == 1
    output = capsys.readouterr().out
    assert "Collection warnings" in output
    assert "paint stats:" in output


def test_main_rejects_non_positive_pid() -> None:
    with pytest.raises(SystemExit, match="--pid must be a positive integer"):
        doctor.main(["--pid", "0", "--skip-gpu"])
