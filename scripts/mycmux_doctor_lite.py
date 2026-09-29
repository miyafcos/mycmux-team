#!/usr/bin/env python3
"""Print a compact read-only mycmux runtime and paint diagnostics report."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Any, Callable, Mapping, Sequence
import uuid


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
PERF_SCRIPT = SCRIPT_DIR / "perf" / "measure-paint-stats.ps1"
PERF_RESULTS_DIR = SCRIPT_DIR / "perf" / "results"

if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from mycmux_agent_cli import send_request  # noqa: E402


JsonObject = dict[str, Any]
Runner = Callable[..., subprocess.CompletedProcess[str]]


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def load_paint_stats(source: str | None) -> JsonObject | None:
    if source is None:
        return None
    if source == "-":
        value = json.load(sys.stdin)
    else:
        value = read_json(Path(source).expanduser())
    if not isinstance(value, dict):
        raise ValueError("paint stats must be a JSON object")
    return value


def collect_panes() -> JsonObject:
    try:
        result = send_request("pane.list_all", {})
    except RuntimeError as exc:
        message = str(exc).lower()
        if "unknown" not in message and "unsupported" not in message:
            raise
        workspace_result = send_request("workspace.list", {})
        if not isinstance(workspace_result, dict):
            raise RuntimeError("workspace.list returned a non-object result") from exc
        workspaces = workspace_result.get("workspaces", [])
        if not isinstance(workspaces, list):
            raise RuntimeError("workspace.list returned invalid workspaces") from exc
        panes: list[Any] = []
        active_pane_id = None
        for workspace in workspaces:
            if not isinstance(workspace, dict):
                continue
            workspace_id = workspace.get("workspaceId") or workspace.get("id")
            if not isinstance(workspace_id, str):
                continue
            pane_result = send_request("pane.list", {"workspaceId": workspace_id})
            if not isinstance(pane_result, dict):
                continue
            active_pane_id = active_pane_id or pane_result.get("activePaneId")
            workspace_name = workspace.get("workspaceName") or workspace.get("name")
            for pane in pane_result.get("panes", []):
                if isinstance(pane, dict):
                    panes.append({
                        **pane,
                        "workspaceId": pane.get("workspaceId") or workspace_id,
                        "workspaceName": pane.get("workspaceName") or workspace_name,
                    })
        result = {
            "activeWorkspaceId": workspace_result.get("activeWorkspaceId"),
            "activePaneId": active_pane_id,
            "activeSessionId": active_pane_id,
            "workspaces": workspaces,
            "panes": panes,
        }
    if not isinstance(result, dict):
        raise RuntimeError("pane.list_all returned a non-object result")
    return result


def collect_session_state() -> JsonObject:
    result = send_request("session.state_view", {})
    if not isinstance(result, dict):
        raise RuntimeError("session.state_view returned a non-object result")
    sessions = result.get("sessions")
    if not isinstance(sessions, list):
        raise RuntimeError("session.state_view returned invalid sessions")
    return result


def collect_gpu_summary(
    sample_seconds: int,
    sample_interval_ms: int,
    target_pid: int | None,
    runner: Runner = subprocess.run,
) -> JsonObject:
    PERF_RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    token = uuid.uuid4().hex[:8]
    csv_path = PERF_RESULTS_DIR / f"paint-stats-doctor-{stamp}-{token}.csv"
    summary_path = csv_path.with_suffix(".summary.json")
    command = [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(PERF_SCRIPT),
        "-RepoRoot",
        str(REPO_ROOT),
        "-StateLabel",
        "doctor",
        "-SampleSeconds",
        str(sample_seconds),
        "-SampleIntervalMs",
        str(sample_interval_ms),
        "-OutputPath",
        str(csv_path),
        "-SummaryPath",
        str(summary_path),
    ]
    if target_pid is not None:
        command.extend(["-Pid", str(target_pid)])
    completed = runner(
        command,
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=sample_seconds + 20,
        check=False,
    )
    if completed.returncode != 0:
        reason = (completed.stderr or completed.stdout or "GPU sampler failed").strip()
        raise RuntimeError(reason.splitlines()[-1][:240])
    if not summary_path.is_file():
        raise RuntimeError("GPU sampler did not create its summary JSON")
    summary = read_json(summary_path)
    if not isinstance(summary, dict):
        raise RuntimeError("GPU sampler summary is not a JSON object")
    return summary


def flatten_tabs(panes: Mapping[str, Any] | None) -> list[JsonObject]:
    if not panes:
        return []
    rows: list[JsonObject] = []
    raw_panes = panes.get("panes", [])
    if not isinstance(raw_panes, list):
        return rows
    for pane in raw_panes:
        if not isinstance(pane, dict):
            continue
        tabs = pane.get("tabs", [])
        if not isinstance(tabs, list):
            continue
        for tab in tabs:
            if not isinstance(tab, dict):
                continue
            rows.append(
                {
                    "workspace": pane.get("workspaceName") or pane.get("workspaceId") or "-",
                    "pane": pane.get("label") or pane.get("id") or "-",
                    "active": pane.get("active") is True
                    and pane.get("activeTabId") in (tab.get("id"), tab.get("sessionId")),
                    "session": tab.get("sessionId") or "-",
                    "tab": tab.get("label") or "-",
                    "agent": tab.get("agentKind") or pane.get("agentKind") or "-",
                    "agent_status": tab.get("agentStatus") or "-",
                    "process_status": tab.get("processStatus") or "-",
                    "last_output_at": tab.get("lastOutputAt") or "-",
                }
            )
    return rows


def markdown_table(headers: Sequence[str], rows: Sequence[Sequence[Any]]) -> list[str]:
    rendered = [f"| {' | '.join(headers)} |", f"| {' | '.join('---' for _ in headers)} |"]
    for row in rows:
        values = [
            re.sub(r"[\x00-\x1f\x7f]", " ", str(value)).replace("|", "\\|")
            for value in row
        ]
        rendered.append(f"| {' | '.join(values)} |")
    return rendered


def fmt_number(value: Any, digits: int = 2) -> str:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return "-"
    if isinstance(value, int):
        return str(value)
    return f"{value:.{digits}f}"


def nested(mapping: Mapping[str, Any] | None, *keys: str) -> Any:
    value: Any = mapping
    for key in keys:
        if not isinstance(value, Mapping):
            return None
        value = value.get(key)
    return value


def render_report(
    panes: JsonObject | None,
    gpu: JsonObject | None,
    paint: JsonObject | None,
    errors: Sequence[str],
    session_state: JsonObject | None = None,
) -> str:
    tabs = flatten_tabs(panes)
    raw_workspaces = panes.get("workspaces", []) if isinstance(panes, dict) else []
    raw_panes = panes.get("panes", []) if isinstance(panes, dict) else []
    workspace_count = len(raw_workspaces) if isinstance(raw_workspaces, list) else 0
    pane_count = len(raw_panes) if isinstance(raw_panes, list) else 0
    lines = [
        "# mycmux doctor-lite",
        "",
        f"Generated: {datetime.now(timezone.utc).isoformat()}",
        "",
        "## Runtime",
        "",
        f"Workspaces: {workspace_count} / Panes: {pane_count} / Tabs: {len(tabs)}",
        "",
    ]
    if tabs:
        rows = [
            [
                row["workspace"],
                row["pane"],
                ("* " if row["active"] else "") + str(row["tab"]),
                row["agent"],
                row["agent_status"],
                row["process_status"],
                row["last_output_at"],
            ]
            for row in tabs
        ]
        lines.extend(markdown_table(
            ["Workspace", "Pane", "Tab", "Agent", "Agent status", "Process", "Last output"],
            rows,
        ))
    else:
        lines.append("Runtime pane data: unavailable")

    lines.extend(["", "Tab working set: unavailable in the current socket contract.", "", "## GPU process CPU", ""])
    if gpu:
        lines.extend(markdown_table(
            ["mycmux PID", "GPU PID", "Samples", "Duration s", "CPU avg all cores %", "CPU max all cores %"],
            [[
                gpu.get("mycmux_pid", "-"),
                gpu.get("gpu_pid", "-"),
                gpu.get("sample_count", "-"),
                gpu.get("actual_duration_seconds", "-"),
                gpu.get("avg_cpu_percent_all_cores", "-"),
                gpu.get("max_cpu_percent_all_cores", "-"),
            ]],
        ))
        if gpu.get("csv_path"):
            lines.append(f"\nSamples: `{gpu['csv_path']}`")
    else:
        lines.append("GPU sample: unavailable")

    lines.extend(["", "## Three-layer paint stats", ""])
    if paint:
        lines.extend(markdown_table(
            ["Layer", "Metric", "Value"],
            [
                ["Input/parse", "PTY received bytes", fmt_number(nested(paint, "layers", "inputParse", "ptyReceivedBytes"))],
                ["Input/parse", "Batch count / min / avg / max bytes", " / ".join([
                    fmt_number(nested(paint, "layers", "inputParse", "batchBytes", "count")),
                    fmt_number(nested(paint, "layers", "inputParse", "batchBytes", "min")),
                    fmt_number(nested(paint, "layers", "inputParse", "batchBytes", "avg")),
                    fmt_number(nested(paint, "layers", "inputParse", "batchBytes", "max")),
                ])],
                ["Input/parse", "write calls / callback p50 / p95 ms", " / ".join([
                    fmt_number(nested(paint, "layers", "inputParse", "writeCalls")),
                    fmt_number(nested(paint, "layers", "inputParse", "writeCallbackMs", "p50")),
                    fmt_number(nested(paint, "layers", "inputParse", "writeCallbackMs", "p95")),
                ])],
                ["Input/parse", "pending / max pending bytes", " / ".join([
                    fmt_number(nested(paint, "layers", "inputParse", "pendingBytes")),
                    fmt_number(nested(paint, "layers", "inputParse", "maxPendingBytes")),
                ])],
                ["Input/parse", "onWriteParsed calls", fmt_number(
                    nested(paint, "layers", "inputParse", "onWriteParsedCalls")
                )],
                ["Render", "onRender calls / rows / full screen", " / ".join([
                    fmt_number(nested(paint, "layers", "render", "onRenderCalls")),
                    fmt_number(nested(paint, "layers", "render", "renderedRows")),
                    fmt_number(nested(paint, "layers", "render", "fullScreenRenders")),
                ])],
                ["Render", "renderer / WebGL context losses", " / ".join([
                    str(nested(paint, "layers", "render", "renderer") or "-"),
                    fmt_number(nested(paint, "layers", "render", "webglContextLosses")),
                ])],
                ["Surrounding", "approval scans / avg ms", " / ".join([
                    fmt_number(nested(paint, "layers", "surrounding", "approvalScanMs", "count")),
                    fmt_number(nested(paint, "layers", "surrounding", "approvalScanMs", "avg")),
                ])],
                ["Surrounding", "resync bytes / avg ms", " / ".join([
                    fmt_number(nested(paint, "layers", "surrounding", "resyncBytes")),
                    fmt_number(nested(paint, "layers", "surrounding", "resyncMs", "avg")),
                ])],
                ["Surrounding", "React commits / mounted / focused", " / ".join([
                    fmt_number(nested(paint, "layers", "surrounding", "reactCommits")),
                    fmt_number(nested(paint, "layers", "surrounding", "mountedXterms")),
                    fmt_number(nested(paint, "layers", "surrounding", "focusedXterms")),
                ])],
                ["Surrounding", "cursor blink / document focus / visibility", " / ".join([
                    fmt_number(nested(paint, "layers", "surrounding", "cursorBlinkingXterms")),
                    str(nested(paint, "layers", "surrounding", "documentFocused")),
                    str(nested(paint, "layers", "surrounding", "documentVisibility") or "-"),
                ])],
            ],
        ))
    else:
        lines.append(
            "Paint stats: not supplied. Save `JSON.stringify(window.__mycmuxPaintStats())` and pass `--paint-stats PATH`, or pipe it with `--paint-stats -`."
        )

    lines.extend(["", "## P1.5 evidence ledger", ""])
    state_rows: list[list[Any]] = []
    evidence_rows: list[list[Any]] = []
    sessions = session_state.get("sessions", []) if isinstance(session_state, dict) else []
    if isinstance(sessions, list):
        for session in sessions:
            if not isinstance(session, dict):
                continue
            view = session.get("view")
            if not isinstance(view, dict):
                continue
            attention = view.get("attention")
            attention = attention if isinstance(attention, dict) else {}
            sources = attention.get("sources")
            state_rows.append([
                session.get("session_id") or view.get("session_id") or "-",
                view.get("lifecycle") or "-",
                view.get("activity") or "-",
                attention.get("kind") or "-",
                view.get("health") or "-",
                attention.get("detail") or "-",
                ", ".join(str(source) for source in sources) if isinstance(sources, list) else "-",
            ])
            recent = session.get("recent_evidence")
            if not isinstance(recent, list):
                continue
            for evidence in recent[-5:]:
                if not isinstance(evidence, dict):
                    continue
                signal = evidence.get("signal")
                signal = signal if isinstance(signal, dict) else {}
                evidence_rows.append([
                    session.get("session_id") or "-",
                    evidence.get("observed_at") or "-",
                    evidence.get("source") or "-",
                    signal.get("kind") or "-",
                    signal.get("detail") or "-",
                ])
    if state_rows:
        lines.extend(markdown_table(
            ["Session", "Lifecycle", "Activity", "Attention", "Health", "Detail", "Sources"],
            state_rows,
        ))
        lines.extend(["", "Recent evidence (latest 5 per session):", ""])
        lines.extend(markdown_table(
            ["Session", "Observed at", "Source", "Kind", "Detail"],
            evidence_rows,
        ))
    else:
        lines.append("Session state: unavailable")
    if errors:
        lines.extend(["", "## Collection warnings", ""])
        lines.extend(f"- {error}" for error in errors)
    return "\n".join(lines) + "\n"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--paint-stats", help="Path to a DEV paint snapshot JSON, or - for stdin")
    parser.add_argument("--panes-json", type=Path, help="Offline pane.list_all result for testing/reporting")
    parser.add_argument("--session-state-json", type=Path, help="Offline session.state_view result")
    parser.add_argument("--gpu-summary", type=Path, help="Existing GPU summary JSON")
    parser.add_argument("--skip-gpu", action="store_true")
    parser.add_argument("--sample-seconds", type=int, default=3)
    parser.add_argument("--sample-interval-ms", type=int, default=1000)
    parser.add_argument("--pid", type=int)
    parser.add_argument("--json", action="store_true", dest="as_json")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")
    args = build_parser().parse_args(argv)
    if not 1 <= args.sample_seconds <= 600:
        raise SystemExit("--sample-seconds must be between 1 and 600")
    if not 100 <= args.sample_interval_ms <= 10000:
        raise SystemExit("--sample-interval-ms must be between 100 and 10000")
    if args.pid is not None and args.pid < 1:
        raise SystemExit("--pid must be a positive integer")

    errors: list[str] = []
    panes: JsonObject | None = None
    gpu: JsonObject | None = None
    paint: JsonObject | None = None
    session_state: JsonObject | None = None

    try:
        panes_value = read_json(args.panes_json) if args.panes_json else collect_panes()
        if not isinstance(panes_value, dict):
            raise ValueError("pane data must be a JSON object")
        panes = panes_value
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        errors.append(f"runtime: {str(exc)[:240]}")

    try:
        if args.session_state_json:
            state_value = read_json(args.session_state_json)
        elif args.panes_json:
            state_value = None
        else:
            state_value = collect_session_state()
        if state_value is not None and not isinstance(state_value, dict):
            raise ValueError("session state must be a JSON object")
        session_state = state_value
    except RuntimeError as exc:
        message = str(exc).lower()
        if "unknown" not in message and "unsupported" not in message:
            errors.append(f"session state: {str(exc)[:240]}")
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        errors.append(f"session state: {str(exc)[:240]}")

    if not args.skip_gpu:
        try:
            gpu_value = read_json(args.gpu_summary) if args.gpu_summary else collect_gpu_summary(
                args.sample_seconds,
                args.sample_interval_ms,
                args.pid,
            )
            if not isinstance(gpu_value, dict):
                raise ValueError("GPU summary must be a JSON object")
            gpu = gpu_value
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
            errors.append(f"gpu: {str(exc)[:240]}")

    try:
        paint = load_paint_stats(args.paint_stats)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        errors.append(f"paint stats: {str(exc)[:240]}")

    if args.as_json:
        print(json.dumps({"panes": panes, "gpu": gpu, "paintStats": paint, "sessionState": session_state, "errors": errors}, ensure_ascii=False))
    else:
        print(render_report(panes, gpu, paint, errors, session_state), end="")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
