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

    # The AI proposes checkboxes; closing waits for the person's selection.
    assert 'manualCloseCandidateTabIds' in panel
    assert 'closeCandidateTabIds' not in panel
    # The shortcut comes from the live binding now, so the sentence is split
    # around it. Both halves still have to be present: the point of the check is
    # that the panel tells the operator the close is undoable.
    assert "閉じたペインの記録は {reopenTabShortcut} で復元できます。会話は再開できます。" in panel
    assert "SWEEP_RESTORE_LIMIT_TEXT" in panel
    assert "取り消しは記録の復元で、実行状態は戻りません。" in sweep
    # The model is a user setting now, so the disclosure is built in
    # tabSweep.ts. What must not regress is that it still says exactly what
    # leaves the machine.
    assert "各ペインの画面末尾${TAB_SWEEP_TAIL_LINES}行と作業フォルダを ${target} に送って判定します（チェックの提案のみ）" in sweep
    assert 'formatSweepAiNote("judge"' in panel
    assert "掃除できるペインはありません" in panel

    # One list with checkboxes — the numbered sections and their per-section
    # action buttons are gone, and so is the collapsed LOCKED list.
    assert 'type="checkbox"' in panel
    assert '${autoReview ? "確認して" : "選択した"}${selectedCount}件を閉じる' in panel
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
    assert "ペイン掃除を開く" in palette
    assert "openTabSweepInDashboard" in palette
    assert "useDashboardViewStore.getState().openView()" in sweep
    assert "window.setTimeout(() => window.dispatchEvent(new Event(TAB_SWEEP_OPEN_EVENT)), 0)" in sweep


def test_material_names_are_local_and_do_not_use_the_judge() -> None:
    auto = read("src/lib/autoPaneNaming.ts")
    evidence = read("src/lib/paneEvidence.ts")
    for banned in ("run_tab_sweep_judge", "abort_tab_sweep_judge", "buildNamingPrompt", "parseNamingOutput", "readPaneTail", "aiEnabled", "toast"):
        assert banned not in auto
    assert "identitiesForScan" in auto
    assert "readEvidenceScan" in auto
    assert 'invoke<AgentSessionTitles[]>("agent_session_titles"' in evidence
    assert "5 * 60_000" in evidence

    # Manual sweep keeps the existing AI resolver, async command and opt-out.
    rust = read("src-tauri/src/commands/tab_sweep.rs")
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
    panel = read("src/components/layout/TabSweepPanel.tsx")
    sweep_auto = read("src/components/layout/tabSweepAuto.ts")
    assert "runNaming" not in panel
    assert 'mode: "naming"' not in panel
    assert "buildNamingPrompt" not in panel
    assert 'mode: "naming"' not in sweep_auto
    assert "buildNamingPrompt" not in sweep_auto
    assert "renames" not in sweep_auto


def test_auto_display_names_preserve_control_labels_and_do_not_close_tabs() -> None:
    auto = read("src/lib/autoPaneNaming.ts")
    for banned in ("applySweep", "pane.close_tab", "closeCandidateTabIds", "setTabLabel"):
        assert banned not in auto
    assert "setTabDisplayName" in auto
    assert "identity.displayName !== null && tab.displayName !== identity.displayName" in auto
    assert "useWorkspaceListStore.getState().workspaces" in auto
    assert "autoPaneNamingEnabled" in auto
    assert "autoPaneNamingEnabled" in read("src/stores/settingsStore.ts")
    assert "setAutoPaneNamingEnabled" in read("src/stores/settingsStore.ts")
    assert "aiSettingsStrings.features.autoPaneNaming.disclosure" in read("src/components/settings/tabs/AiTab.tsx")


def test_grouping_mode_is_wired_without_closing_tabs() -> None:
    rust = read("src-tauri/src/commands/tab_sweep.rs")
    panel = read("src/components/layout/TabGroupingPanel.tsx")
    grouping = read("src/components/layout/tabGrouping.ts")
    button = read("src/components/layout/TabGroupingButton.tsx")
    minimap = read("src/components/dashboard/LayoutMinimapPanel.tsx")
    # Local plans are prepared ahead of opening; Jev only enriches role evidence.
    precompute = read("src/lib/groupingPrecompute.ts")

    assert "const GROUPING_TIMEOUT: Duration = Duration::from_secs(300)" in rust
    assert 'Some("grouping") => GROUPING_TIMEOUT' in rust
    assert 'mode: "grouping"' not in precompute
    assert "run_tab_sweep_judge" not in precompute
    assert "runEvidenceGroupingAnalysis" in precompute
    assert "run_jev_grouping_judge" in precompute
    assert 'invoke<boolean>("abort_tab_sweep_judge"' in precompute
    assert "pane.close_tab" not in grouping
    assert "pane.close_tab" not in panel
    assert "pane.close_tab" not in precompute
    strings = read("src/components/dashboard/dashboardStrings.ts")
    assert "TabGroupingButton" in minimap
    assert "TAB_GROUPING_OPEN_EVENT" in button
    # The entry shipped in v0.58.0; the flag stays as the kill switch, so assert
    # it is still declared rather than pinning it to the sealed value.
    assert "export const TAB_GROUPING_ENTRY_ENABLED" in button
    assert "tabGroupingStrings.buttonLabel" in button
    assert 'buttonLabel: "ペイン再配置"' in strings
    assert "TabGroupingPanel" in button
    assert "WorkOverview" not in button
    assert "deps.replaceWorkspaces(" in read("src/components/layout/tabGroupingEngine.ts") and "_restoreGroupingLayout(" in read("src/components/layout/groupingStoreAdapter.ts")
    assert "moveTabToPane" not in grouping
    engine = read("src/components/layout/tabGroupingEngine.ts")
    adapter = read("src/components/layout/groupingStoreAdapter.ts")
    assert "pane.close_tab" not in engine
    assert "pane.close_tab" not in adapter
    assert "moveTabToPane" not in engine
    assert "moveTabToPane" not in adapter
