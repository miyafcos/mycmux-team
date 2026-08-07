from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def test_tab_sweep_command_is_wired_end_to_end() -> None:
    assert "pub mod tab_sweep;" in read("src-tauri/src/commands/mod.rs")
    assert "commands::tab_sweep::run_tab_sweep_judge" in read("src-tauri/src/lib.rs")
    assert "commands::tab_sweep::abort_tab_sweep_judge" in read("src-tauri/src/lib.rs")
    assert "pub async fn run_tab_sweep_judge" in read("src-tauri/src/commands/tab_sweep.rs")
    assert "pub async fn abort_tab_sweep_judge" in read("src-tauri/src/commands/tab_sweep.rs")
    assert 'invoke<string>("run_tab_sweep_judge"' in read(
        "src/components/layout/TabSweepPanel.tsx"
    )
    assert 'invoke<boolean>("abort_tab_sweep_judge"' in read(
        "src/components/layout/TabSweepPanel.tsx"
    )


def test_judge_action_never_applies_or_closes_tabs_implicitly() -> None:
    panel = read("src/components/layout/TabSweepPanel.tsx")
    match = re.search(
        r"const runJudge = async \(\) => \{(?P<body>.*?)\n  \};\n\n  const cancelJudge",
        panel,
        re.DOTALL,
    )
    assert match is not None
    body = match.group("body")
    assert "applySweep" not in body
    assert "applyAndRefresh" not in body
    assert "closeCandidateTabIds" not in body
    assert "pane.close_tab" not in body
    assert "setJudged(false)" in body
    assert 'parseJudgeOutput("", ids)' not in body


def test_judge_process_uses_stdin_pipes_and_a_clean_environment() -> None:
    source = read("src-tauri/src/commands/tab_sweep.rs")
    assert ".env_clear()" in source
    assert ".stdin(Stdio::piped())" in source
    assert ".stdout(Stdio::piped())" in source
    assert ".stderr(Stdio::piped())" in source
    assert "stdin.write_all(prompt.as_bytes())" in source
    assert ".arg(prompt)" not in source
    assert "oneshot::channel" in source
    assert "terminate_child_tree(&mut child)" in source
    assert '"timeout"' in source
    assert '"cli_not_found"' in source
    assert '"cli_failed"' in source
    assert 'taskkill.args(["/PID", &pid.to_string(), "/T", "/F"])' in source


def test_tab_sweep_ui_contract_covers_all_entry_points_and_safety_copy() -> None:
    panel = read("src/components/layout/TabSweepPanel.tsx")
    button = read("src/components/layout/TabSweepButton.tsx")
    sweep = read("src/components/layout/tabSweep.ts")
    keybindings = read("src/lib/keybindings.ts")
    app_shell = read("src/components/layout/AppShell.tsx")
    palette = read("src/components/CommandPalette/CrsmPalette.tsx")

    assert 'manualCloseCandidateTabIds' in panel
    assert 'closeCandidateTabIds: [tab.id], verdicts' in panel
    assert "閉じたタブは Ctrl+Shift+T で復元できます（会話も再開されます）" in panel
    assert "各タブの画面末尾8行と作業フォルダを Claude (haiku) に送って判定します" in panel
    assert "掃除できるタブはありません" in panel
    assert "① 即掃除できる" in panel
    assert "② AI 判定候補" in panel
    assert "④ 無名タブのラベル案" in panel
    assert "③ ロック中" in panel
    assert "lockedExpanded" in panel
    assert "lastMeaningfulTailLine" in panel
    assert "shortenCwdFromStart" in panel
    assert "onReportChange" in panel
    assert "countUnseenSweepTabs" in button
    assert "TAB_SWEEP_OPEN_EVENT" in button
    assert 'visible={mounted}' in button
    assert 'open={open}' in button
    assert 'manualCloseCandidateTabIds?: string[]' in sweep
    assert '| "tab.sweep"' in keybindings
    assert 'action: "tab.sweep"' in keybindings
    assert 'defaultShortcut: "ctrl+shift+k"' in keybindings
    assert 'case "tab.sweep":' in app_shell
    assert "window.dispatchEvent(new Event(TAB_SWEEP_OPEN_EVENT))" in app_shell
    assert "matchesTabSweepCommand(query)" in palette
    assert "タブ掃除を開く" in palette
    assert "window.dispatchEvent(new Event(TAB_SWEEP_OPEN_EVENT))" in palette
