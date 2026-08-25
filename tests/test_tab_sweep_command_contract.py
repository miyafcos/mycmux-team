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
    # Command construction moved into crate::ai so tab sweep, the ailog
    # summariser and the digest share one hardened spawn recipe. The
    # properties themselves are unchanged, so assert them at their new home.
    runner = read("src-tauri/src/ai/mod.rs")
    assert ".env_clear()" in runner
    assert ".stdin(Stdio::piped())" in runner
    assert ".stdout(Stdio::piped())" in runner
    assert ".stderr(Stdio::piped())" in runner
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

    # Closing always goes through the manual channel: the AI judge proposes
    # checkboxes, it is not a gate on the close button.
    assert 'manualCloseCandidateTabIds' in panel
    assert 'closeCandidateTabIds' not in panel
    assert "閉じたタブは Ctrl+Shift+T で復元できます（会話も再開されます）" in panel
    # The model is a user setting now, so the disclosure is built in
    # tabSweep.ts. What must not regress is that it still says exactly what
    # leaves the machine.
    assert "各タブの画面末尾${TAB_SWEEP_TAIL_LINES}行と作業フォルダを ${target} に送って判定します（チェックの提案のみ）" in sweep
    assert 'formatSweepAiNote("judge"' in panel
    assert "掃除できるタブはありません" in panel

    # One list with checkboxes — the numbered sections and their per-section
    # action buttons are gone, and so is the collapsed LOCKED list.
    assert 'type="checkbox"' in panel
    assert "選択した${selectedCount}件を閉じる" in panel
    assert "① 即掃除できる" not in panel
    assert "② AI 判定候補" not in panel
    assert "④ 無名タブのラベル案" not in panel
    assert "③ ロック中" not in panel
    assert "lockedExpanded" not in panel
    assert "ラベル案: " in panel

    assert "lastMeaningfulTailLine" in panel
    assert "shortenCwdFromStart" in panel
    for helper in (
        "buildSweepRows",
        "initialSweepSelection",
        "applyVerdictSelection",
        "retainSweepSelection",
        "splitSweepSelection",
        "toggleSweepSelection",
    ):
        assert helper in panel
        assert f"export function {helper}" in sweep

    # The button is a plain toggle: no badge, no background scanning.
    assert "onReportChange" not in panel
    assert "onReportChange" not in button
    assert "countUnseenSweepTabs" not in button
    assert "summarizeSweepReport" not in button
    assert "scanTabs" not in button
    assert "setInterval" not in button
    assert "pty-exit" not in button
    assert "TAB_SWEEP_OPEN_EVENT" in button
    assert 'visible={mounted}' in button
    assert 'open={open}' in button

    # The removed notice helpers must not come back on the module either.
    assert "summarizeSweepReport" not in sweep
    assert "countUnseenSweepTabs" not in sweep
    assert 'manualCloseCandidateTabIds?: string[]' in sweep
    assert '| "tab.sweep"' in keybindings
    assert 'action: "tab.sweep"' in keybindings
    assert 'defaultShortcut: "ctrl+shift+k"' in keybindings
    assert 'case "tab.sweep":' in app_shell
    assert "openTabSweepInDashboard();" in app_shell
    assert "matchesTabSweepCommand(query)" in palette
    assert "タブ掃除を開く" in palette
    assert "openTabSweepInDashboard" in palette
    assert "useDashboardViewStore.getState().openView()" in sweep
    assert "window.setTimeout(() => window.dispatchEvent(new Event(TAB_SWEEP_OPEN_EVENT)), 0)" in sweep


def test_naming_mode_is_wired_to_the_auto_pane_naming_job() -> None:
    """Naming left the sweep panel: it is a background job now, not a button.

    The sweep button must stay a pure tidy-up (judge + close). Naming runs on
    its own schedule from src/lib/autoPaneNaming.ts and still shares the one
    Rust command via mode: "naming".
    """
    rust = read("src-tauri/src/commands/tab_sweep.rs")
    panel = read("src/components/layout/TabSweepPanel.tsx")
    auto = read("src/lib/autoPaneNaming.ts")
    sweep_auto = read("src/components/layout/tabSweepAuto.ts")

    signature = re.search(
        r"pub async fn run_tab_sweep_judge\((?P<body>.*?)\) -> Result<String, TabSweepJudgeError>",
        rust,
        re.DOTALL,
    )
    assert signature is not None
    assert "mode: Option<String>" in signature.group("body")
    assert "crate::ai::resolve(" in rust
    assert "const JUDGE_MODEL" not in rust
    assert "ai_disabled" in rust

    # The naming call now lives in the scheduler.
    assert 'invoke<string>("run_tab_sweep_judge"' in auto
    assert 'mode: "naming"' in auto
    assert 'invoke<boolean>("abort_tab_sweep_judge"' in auto

    # ...and must not come back to either sweep entry point.
    assert "runNaming" not in panel
    assert 'mode: "naming"' not in panel
    assert "buildNamingPrompt" not in panel
    assert 'mode: "naming"' not in sweep_auto
    assert "buildNamingPrompt" not in sweep_auto
    assert "renames" not in sweep_auto


def test_auto_pane_naming_never_closes_tabs_or_overwrites_human_labels() -> None:
    """The unattended job may only add names, and only to tabs nobody named."""
    auto = read("src/lib/autoPaneNaming.ts")
    sweep_source = read("src/components/layout/tabSweep.ts")
    settings_store = read("src/stores/settingsStore.ts")
    ai_tab = read("src/components/settings/tabs/AiTab.tsx")

    # Naming never closes anything.
    assert "applySweep" not in auto
    assert "pane.close_tab" not in auto
    assert "closeCandidateTabIds" not in auto

    # A label a human set is off limits, and an empty label makes a tab eligible
    # again (that is what "reset the name" has to mean).
    assert 'labelSource === "ai"' in auto
    assert 'labelSource !== "ai"' in auto
    assert '"ai"' in auto

    # No candidates must mean no CLI call at all.
    assert "targets.length === 0" in auto

    # Both gates, and the visibility check on the recovery sweep.
    assert "aiEnabled" in auto
    assert "autoPaneNamingEnabled" in auto
    assert 'getVisibility() !== "visible"' in auto

    # The disclosure has to match what actually happens now: it applies by
    # itself, and only to unnamed tabs.
    assert "名前のないタブの画面末尾${TAB_NAMING_TAIL_LINES}行・作業フォルダ・ペイン構成を ${target} に送って名前を付けます（自動で適用・元に戻せます）" in sweep_source
    # There is no panel to open first, so the disclosure sits by the switch.
    assert 'formatSweepAiNote("naming"' in ai_tab

    # The switch itself is persisted and defaults on.
    assert "autoPaneNamingEnabled" in settings_store
    assert "setAutoPaneNamingEnabled" in settings_store
    assert "autoPaneNamingStrings" in ai_tab


def test_grouping_mode_is_wired_without_closing_tabs() -> None:
    rust = read("src-tauri/src/commands/tab_sweep.rs")
    panel = read("src/components/layout/TabGroupingPanel.tsx")
    grouping = read("src/components/layout/tabGrouping.ts")
    button = read("src/components/layout/TabGroupingButton.tsx")
    minimap = read("src/components/dashboard/LayoutMinimapPanel.tsx")

    assert "const GROUPING_TIMEOUT: Duration = Duration::from_secs(180)" in rust
    assert 'Some("grouping") => GROUPING_TIMEOUT' in rust
    assert 'mode: "grouping"' in panel
    assert 'invoke<string>("run_tab_sweep_judge"' in panel
    assert 'invoke<boolean>("abort_tab_sweep_judge"' in panel
    assert "pane.close_tab" not in grouping
    assert "pane.close_tab" not in panel
    strings = read("src/components/dashboard/dashboardStrings.ts")
    assert "TabGroupingButton" in minimap
    assert "TAB_GROUPING_OPEN_EVENT" in button
    assert "TAB_GROUPING_ENTRY_ENABLED = false" in button
    assert "tabGroupingStrings.buttonLabel" in button
    assert 'buttonLabel: "タブ再配置"' in strings
    assert "_replaceWorkspaces" in grouping
    assert "moveTabToPane" not in grouping
