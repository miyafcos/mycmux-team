from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def text(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_resume_guard_precedes_all_launch_side_effects_and_skips_reattach() -> None:
    terminal = text("src-tauri/src/commands/terminal.rs")
    wrapper = terminal[terminal.index("pub async fn create_session("):terminal.index("fn create_session_blocking(")]
    assert 'run_blocking("create_session", move || {' in wrapper
    assert "create_session_blocking(app_handle, state, session_id, command, args, cols, rows, on_data, cwd, env, background_only.unwrap_or(false), attach_origin, restore_confirmed.unwrap_or(false))" in wrapper
    assert "}).await" in wrapper
    create = terminal[terminal.index("fn create_session_blocking("):terminal.index("pub(crate) fn prepare_spawn_command(")]
    guard = create.index("LaunchClaim::acquire")
    assert "let _launch_claim = if reattach {\n        None" in create[:guard]
    for mutation in ["remove_session_mapping_file(", "std::fs::create_dir_all(", "ensure_claude_project_trusted(", "write_launch_session_mapping(", "state.session_manager.create("]:
        assert guard < create.index(mutation), mutation
    assert 'crate::diag::warn("launch", &error)' in create


def test_running_ids_command_is_registered_async_without_expanding_sync_allowlist() -> None:
    terminal = text("src-tauri/src/commands/terminal.rs")
    assert "#[tauri::command(async)]\npub async fn list_running_session_ids" in terminal
    assert 'run_blocking("list_running_session_ids", move || Ok(running_session_ids_for(&manager))).await' in terminal
    assert "manager.is_running(id)" in terminal
    assert "commands::terminal::list_running_session_ids," in text("src-tauri/src/lib.rs")
    assert 'invoke<string[]>("list_running_session_ids")' in text("src/lib/ipc.ts")


def test_every_start_path_consumes_handoff_only_after_successful_create() -> None:
    wrapper = text("src/components/terminal/XTermWrapper.tsx")
    attach = wrapper[wrapper.index("const attachFrontendChannel = async"):wrapper.index("const registerScanListener =")]
    assert attach.index("await createSession(") < attach.index("consumeHandoffLaunchEnv(sessionId)") < attach.index("frontendChannelReady = true")
    socket = text("src/components/layout/socketCommands.ts")
    background = socket[socket.index("export async function startBackgroundTabSession"):socket.index("function isKnownPaneSession")]
    assert background.index("await createSession(") < background.index("consumeHandoffLaunchEnv(tab.sessionId)")


def test_persist_refreshes_running_ids_and_does_not_feed_startup_dedupe() -> None:
    listener = text("src/components/layout/SocketListener.tsx")
    assert "liveSessionIds = new Set(await listRunningSessionIds())" in listener
    assert 'console.warn("[persist] Failed to list running session ids:", err)' in listener
    assert "buildSnapshot(agentMappings, windowFragments, request.snapshot.workspaces, liveSessionIds)" in listener
    assert "options.liveSessionIds," in listener
    restore = listener[listener.index("const restoredDedupe = dedupeAgentSessionsInConfigs("):]
    assert "liveSessionIds" not in restore[:restore.index(");")]
