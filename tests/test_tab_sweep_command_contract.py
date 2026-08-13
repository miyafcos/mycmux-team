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
    assert "window.dispatchEvent(new Event(TAB_SWEEP_OPEN_EVENT))" in app_shell
    assert "matchesTabSweepCommand(query)" in palette
    assert "タブ掃除を開く" in palette
    assert "window.dispatchEvent(new Event(TAB_SWEEP_OPEN_EVENT))" in palette


def test_naming_mode_is_wired_to_the_fixed_sonnet_model() -> None:
    rust = read("src-tauri/src/commands/tab_sweep.rs")
    panel = read("src/components/layout/TabSweepPanel.tsx")

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

    naming = re.search(
        r"const runNaming = async \(\) => \{(?P<body>.*?)\n  \};\n\n  const cancelNaming",
        panel,
        re.DOTALL,
    )
    assert naming is not None
    body = naming.group("body")
    assert 'invoke<string>("run_tab_sweep_judge"' in body
    assert 'mode: "naming"' in body


def test_naming_judge_only_proposes_names_and_ui_copy_is_present() -> None:
    panel = read("src/components/layout/TabSweepPanel.tsx")
    naming = re.search(
        r"const runNaming = async \(\) => \{(?P<body>.*?)\n  \};\n\n  const cancelNaming",
        panel,
        re.DOTALL,
    )
    assert naming is not None
    body = naming.group("body")
    assert "applySweep" not in body
    assert "pane.close_tab" not in body
    assert "closeCandidateTabIds" not in body
    assert "名前の提案" in panel
    assert "名前を元に戻す" in panel
    sweep_source = read("src/components/layout/tabSweep.ts")
    assert "名前整理は全タブの画面末尾${TAB_NAMING_TAIL_LINES}行・作業フォルダ・ペイン構成を ${target} に送ります（適用は手動）" in sweep_source
    assert 'formatSweepAiNote("naming"' in panel
