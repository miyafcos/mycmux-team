import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_savepoint_drag_is_isolated_from_pane_move_drag():
    pane_store = read("src/stores/paneDragStore.ts")
    savepoint_hook = read("src/hooks/useSavepointDragSource.ts")
    pane_hook = read("src/hooks/usePaneDragSource.ts")

    assert 'kind: "savepoint"' not in pane_store
    assert 'from "../stores/savepointDragStore"' in savepoint_hook
    assert "moveTabToPane" not in savepoint_hook
    assert "movePaneToPane" not in savepoint_hook
    assert "usePaneDragStore.getState().item" in savepoint_hook
    assert "useSavepointDragStore.getState().item" in pane_hook
    assert savepoint_hook.count("usePaneDragStore.getState().item") >= 2
    assert pane_hook.count("useSavepointDragStore.getState().item") >= 2
    assert "dragState.clearDrag(dragOwnerRef.current)" in savepoint_hook
    assert "clearDrag(dragOwnerRef.current)" in savepoint_hook


def test_savepoint_drop_pastes_a_draft_or_opens_full_resume_with_handoff_fallback():
    savepoint_hook = read("src/hooks/useSavepointDragSource.ts")
    handoff_logic = read("src/lib/savepointHandoff.ts")
    paste_runtime = read("src/lib/savepointHandoffRuntime.ts")
    layout_store = read("src/stores/workspaceLayoutStore.ts")

    assert "commitSavepointPaste(item.bundleDir, target)" in savepoint_hook
    assert "joinSavepointSummary(bundleDir)" in paste_runtime
    assert "prepareSavepointDropOpen(" in savepoint_hook
    assert "joinSavepointFull," in savepoint_hook
    assert "joinSavepointSummary," in savepoint_hook
    assert 'return { mode: "full", joined: await joinFull(bundleDir) };' in handoff_logic
    assert 'mode: "handoff"' in handoff_logic
    assert "joined: await joinSummary(bundleDir)" in handoff_logic
    assert "sanitizeSavepointHandoffDraft(onlineStrings.joinPrompt(joined.handoff_path))" in paste_runtime
    assert "await writeToSession(readyTarget.sessionId, draft);" in paste_runtime
    assert ".addPaneToWorkspaceWithOptions(" in savepoint_hook
    assert "resolveSpawnPlan({" in savepoint_hook
    assert "prepared.joined.command_argv" in savepoint_hook
    assert "prepared.joined.handoff_path" in savepoint_hook
    assert "layoutStore.movePaneToSplit(" in savepoint_hook
    assert ".addTabToPaneWithOptions(" not in savepoint_hook
    assert '"\\r"' not in savepoint_hook
    assert '"\\n"' not in savepoint_hook
    assert "addPaneToWorkspaceWithOptions:" in layout_store


def test_cards_and_agent_tabs_expose_dedicated_drag_surfaces():
    panel = read("src/components/online/OnlinePanel.tsx")
    tab_bar = read("src/components/workspace/PaneTabBar.tsx")
    terminal_pane = read("src/components/workspace/TerminalPane.tsx")

    assert "useSavepointDragSource" in panel
    assert 'data-savepoint-drag-handle="true"' in panel
    assert "data-savepoint-drop-workspace-id" in tab_bar
    assert 'data-savepoint-drop-pane="true"' in terminal_pane


def test_releasing_inside_savepoint_panel_is_an_explicit_silent_cancel():
    panel = read("src/components/online/OnlinePanel.tsx")
    savepoint_hook = read("src/hooks/useSavepointDragSource.ts")

    assert 'data-savepoint-drop-cancel="true"' in panel
    resolver = savepoint_hook.split(
        "function resolveDropAtPoint", 1
    )[1].split("async function commitSavepointDrop", 1)[0]
    assert resolver.index("data-savepoint-export-target") < resolver.index(
        "data-savepoint-drop-cancel"
    )
    assert resolver.index("data-savepoint-drop-cancel") < resolver.index(
        "data-savepoint-drop-pane"
    )

    pointer_up = savepoint_hook.split(
        "function handlePointerUp", 1
    )[1].split("function handlePointerCancel", 1)[0]
    assert "nativeEvent.clientX" in pointer_up
    assert "nativeEvent.clientY" in pointer_up
    assert "resolveSavepointReleaseDisposition(" in pointer_up
    assert "release.onCancelSurface" in pointer_up
    assert "dragStore.setTarget(release.target)" in pointer_up

    finish_drag = savepoint_hook.split(
        "const finishDrag", 1
    )[1].split("function handlePointerMove", 1)[0]
    assert 'disposition === "commit"' in finish_drag
    assert 'disposition === "invalid"' in finish_drag


def test_dragging_to_the_temporary_share_tray_exports_without_restoring_a_pane():
    panel = read("src/components/online/OnlinePanel.tsx")
    savepoint_hook = read("src/hooks/useSavepointDragSource.ts")
    overlay = read("src/components/online/SavepointDragOverlay.tsx")

    assert "function SavepointTransferDropTarget" in panel
    assert 'data-savepoint-export-target="true"' in panel
    assert "if (!dragging) return null;" in panel
    assert 'position: "absolute"' in panel
    assert 'target.mode === "export"' in savepoint_hook
    assert "shareSavepointTransfer(item.bundleDir, item.label)" in savepoint_hook
    assert 'target?.mode === "export"' in overlay
    assert "onlineStrings.dragGhostTransferTarget" in overlay


def test_exact_non_agent_tab_never_falls_through_to_another_active_agent_tab():
    savepoint_hook = read("src/hooks/useSavepointDragSource.ts")

    assert 'target: target ?? resolveSpawnTarget(workspaceId, paneId, "right"),' in savepoint_hook


def test_card_actions_offer_keyboard_and_touch_handoff_to_both_agents():
    panel = read("src/components/online/OnlinePanel.tsx")

    assert 'handoffSummary(entry, "claude")' in panel
    assert 'handoffSummary(entry, "codex")' in panel
    assert "buildSavepointHandoffLaunchEnv(" in panel
    assert "if (target.cwd_missing)" in panel
    summary_join = panel.split("const handoffSummary", 1)[1].split("const joinFull", 1)[0]
    summary_fallback = summary_join.split("if (target.cwd_missing)", 1)[1].split(
        "addPaneToWorkspaceWithOptions", 1
    )[0]
    assert "setCwdNotice(onlineStrings.joinCwdMissing)" in summary_fallback
    assert "return;" not in summary_fallback


def test_full_resume_and_handoff_fallback_use_home_instead_of_aborting():
    panel = read("src/components/online/OnlinePanel.tsx")
    savepoint_hook = read("src/hooks/useSavepointDragSource.ts")

    card_full = panel.split("const joinFull", 1)[1].split("const togglePin", 1)[0]
    card_fallback = card_full.split("if (target.cwd_missing)", 1)[1].split(
        "addPaneToWorkspaceWithOptions", 1
    )[0]
    assert "setCwdNotice(onlineStrings.joinCwdMissing)" in card_fallback
    assert "return;" not in card_fallback
    drag_full = savepoint_hook.split(
        "const prepared = await prepareSavepointDropOpen(", 1
    )[1].split("} catch (error)", 1)[0]
    assert "addPaneToWorkspaceWithOptions" in drag_full
    assert "prepared.joined.cwd_missing ? onlineStrings.joinCwdMissing" in drag_full
    assert "prepared.joined.cwd_missing ? onlineStrings.dragDropCwdMissing" in drag_full


def test_async_drop_revalidates_target_and_reports_invalid_release():
    savepoint_hook = read("src/hooks/useSavepointDragSource.ts")
    paste_runtime = read("src/lib/savepointHandoffRuntime.ts")

    assert savepoint_hook.count("revalidateDropTarget(") >= 3
    assert paste_runtime.count("revalidateLiveAgentTarget(") >= 4
    assert "await isSessionAlive(sessionId)" in paste_runtime
    assert "isApprovalWaiting(" in paste_runtime
    assert "dragDropInvalidTarget" in savepoint_hook
    assert "dragDropTargetGone" in paste_runtime
    assert "dismissToast(openingToastId)" in paste_runtime


def test_session_liveness_query_is_wired_through_all_tauri_layers():
    ipc = read("src/lib/ipc.ts")
    terminal_commands = read("src-tauri/src/commands/terminal.rs")
    lib_rs = read("src-tauri/src/lib.rs")

    assert "export async function isSessionAlive(sessionId: string): Promise<boolean>" in ipc
    assert 'return invoke<boolean>("is_session_alive", { sessionId } satisfies SessionIdArgs);' in ipc
    assert "#[tauri::command(async)]\npub fn is_session_alive" in terminal_commands
    assert "state.session_manager.is_alive(&session_id)" in terminal_commands
    assert "commands::terminal::is_session_alive" in lib_rs


def test_paste_target_uses_an_input_preview_instead_of_the_split_preview():
    terminal_pane = read("src/components/workspace/TerminalPane.tsx")
    tab_bar = read("src/components/workspace/PaneTabBar.tsx")
    css = read("src/global.css")

    assert 'savepointDropTarget?.mode === "paste"' in terminal_pane
    assert "savepointDropTarget.tabId === activeTab?.id" in terminal_pane
    assert 'className="savepoint-write-preview"' in terminal_pane
    assert "pane-handoff-drop-chip--savepoint" in terminal_pane
    assert 'data-savepoint-paste-target="true"' in terminal_pane
    assert "data-savepoint-paste-target" in read("src/hooks/useSavepointDragSource.ts")
    assert 'savepointDropTarget?.mode === "spawn"' in terminal_pane
    assert "pane-drop-preview--${savepointDropTarget.direction}" in terminal_pane
    assert "onlineStrings.dragDropFullResumeSplit(savepointDropTarget.direction)" in terminal_pane
    assert "is-savepoint-write-target" in tab_bar
    assert ".savepoint-write-preview__caret" in css
    assert "savepointWriteCaretBlink" in css
    write_preview_css = css.split(".savepoint-write-preview {", 1)[1].split("}", 1)[0]
    assert "paneDropPreviewPulse" not in write_preview_css


def test_savepoint_overlay_copy_matches_left_right_full_resume_and_bottom_paste():
    overlay = read("src/components/online/SavepointDragOverlay.tsx")
    strings = read("src/components/online/onlineStrings.ts")
    terminal_pane = read("src/components/workspace/TerminalPane.tsx")

    assert 'target?.mode === "spawn"' in overlay
    assert "onlineStrings.dragDropFullResumeSplit(target.direction)" in overlay
    assert "onlineStrings.dragDropFullResumeSplit(savepointDropTarget.direction)" in terminal_pane
    assert "左・右端: 完全再開" in strings
    assert 'direction === "left" ? "左に完全再開" : "右に完全再開"' in strings
    assert "下: この会話へ引き継ぎ" in strings
    assert "paneDndStrings.handoffSplit(savepointDropTarget.direction)" not in terminal_pane


def _ts_join_prompt_body() -> str:
    """Return the joinPrompt template literal with the TS placeholder normalised."""
    source = read("src/components/online/onlineStrings.ts")
    match = re.search(r"joinPrompt:[^`]*`(?P<body>[^`]*)`", source, re.DOTALL)
    assert match, "joinPrompt template literal not found in onlineStrings.ts"
    return match.group("body").replace("${handoffPath}", "{handoff}")


def _py_summary_prompt_template() -> str:
    """Return the concatenated SUMMARY_PROMPT_TEMPLATE literal from the CLI copy."""
    source = read("scripts/savepoint_join.py")
    match = re.search(
        r"SUMMARY_PROMPT_TEMPLATE = \((?P<body>.*?)\n\)", source, re.DOTALL
    )
    assert match, "SUMMARY_PROMPT_TEMPLATE not found in savepoint_join.py"
    parts = re.findall(r'"([^"]*)"', match.group("body"))
    assert parts, "SUMMARY_PROMPT_TEMPLATE has no string literals"
    return "".join(parts)


def test_handoff_prompt_default_stops_after_organising_the_premise():
    """The dropped-on agent must summarise and then wait, not start working."""
    draft = _ts_join_prompt_body()

    assert "{handoff}" in draft
    # Newlines would be collapsed by sanitizeSavepointHandoffDraft anyway, but a
    # literal one here means the authored copy no longer reads as one line.
    assert "\n" not in draft
    assert "そこで止まって" in draft
    assert "指示を待って" in draft
    assert "ファイルの変更・コマンド実行はしないでください" in draft
    for point in ("何の作業か", "前提・制約", "未確定", "次の一手"):
        assert point in draft
    # The superseded "start working from where it left off" default must be gone.
    assert "その内容の続きから作業してください" not in draft


def test_handoff_prompt_stays_identical_between_the_ts_and_python_copies():
    """savepoint_join.py duplicates the GUI prompt; keep the two from drifting."""
    assert _py_summary_prompt_template() == _ts_join_prompt_body()
