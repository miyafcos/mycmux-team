from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def test_next_action_command_is_async_and_wired() -> None:
    command = read("src-tauri/src/commands/next_action.rs")
    assert "pub async fn run_next_action_judge" in command
    assert "pub async fn abort_next_action_judge" in command
    assert "crate::ai::resolve(&app)" in command
    assert "crate::ai::build_command(&cfg, std::env::vars())" in command
    assert "EXCERPT_CHAR_LIMIT" in command
    assert "ACTION_LIMIT" in command
    assert "serde_json::from_str" in command
    assert "Do not call a task complete from a test pass or turn end alone" in command
    assert "ReportSummary" in command
    assert "report-summary" in command
    assert "purpose: String" in command
    assert "pub mod next_action;" in read("src-tauri/src/commands/mod.rs")
    lib = read("src-tauri/src/lib.rs")
    assert "commands::next_action::run_next_action_judge" in lib
    assert "commands::next_action::abort_next_action_judge" in lib


def test_scheduler_is_event_driven_and_has_no_react_startup_call() -> None:
    scheduler = read("src/lib/backgroundAiScheduler.ts")
    assert "useReportInboxStore.subscribe" in scheduler
    assert "card.source !== \"status\"" in scheduler
    assert "DEBOUNCE_MS = 1_500" in scheduler
    assert "setTimeout" in scheduler
    assert "setInterval" not in scheduler
    assert "run_next_action_judge" in scheduler
    assert "abort_next_action_judge" in scheduler
    assert "REPORT_SUMMARY_PURPOSE = \"report-summary\"" in scheduler
    assert "reportBatchAiContext" in scheduler
    dashboard = read("src/components/dashboard/DashboardView.tsx")
    assert "scheduleFromStatusCard" not in dashboard
    assert "run_next_action_judge" not in dashboard
