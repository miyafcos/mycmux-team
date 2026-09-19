from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_repo_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def assert_contains(text: str, snippet: str, source: str) -> None:
    assert snippet in text, f"Missing snippet in {source}: {snippet}"


def function_slice(text: str, start: str, end: str) -> str:
    start_offset = text.index(start)
    end_offset = text.index(end, start_offset)
    return text[start_offset:end_offset]


def test_socket_api_has_frontend_response_bridge() -> None:
    socket_commands = read_repo_text("src/components/layout/socketCommands.ts")
    ipc = read_repo_text("src/lib/ipc.ts")
    socket_rs = read_repo_text("src-tauri/src/socket.rs")

    # Frontend success/error dispatch: peerWindowClose.test.tsx.
    assert_contains(ipc, 'return invoke<void>("socket_response", { id, result, error } satisfies SocketResponseArgs);', "src/lib/ipc.ts")
    assert_contains(socket_rs, 'app.emit("socket-request", &req)', "src-tauri/src/socket.rs")
    assert_contains(socket_rs, 'state.pending_requests.remove(&id);', "src-tauri/src/socket.rs")
    assert_contains(socket_rs, 'if cmd == "session.state_view"', "src-tauri/src/socket.rs")
    assert_contains(socket_rs, ".session_state_store", "src-tauri/src/socket.rs")
    assert_contains(socket_rs, ".snapshot_with_input_revisions(", "src-tauri/src/socket.rs")
    assert_contains(socket_rs, "session_manager.input_revision(id).ok()", "src-tauri/src/socket.rs")

    # The exported command table is checked against the dispatch AST by
    # socketCommandNames.test.ts; names are still an external API contract.
    assert_contains(socket_commands, 'value === "grok"', "src/components/layout/socketCommands.ts")


def test_local_socket_requires_a_token_from_every_caller() -> None:
    socket_rs = read_repo_text("src-tauri/src/socket.rs")
    agent_cli = read_repo_text("scripts/mycmux_agent_cli.py")
    status_probe = read_repo_text("scripts/status_feed_probe.py")

    for snippet in [
        # Credentials are classified and stripped before anything dispatches the
        # request. Since the hook realm arrived this happens inside
        # classify_and_strip_credentials, which must see both fields at once so a
        # request carrying both can be refused outright. The guarantee is
        # unchanged: the credential never reaches the frontend bridge, the
        # emitted payload, or a log line.
        "fn classify_and_strip_credentials(parsed: &mut Value) -> CredentialRealm {",
        "let token = take_request_token(parsed);",
        "let hook_cap = take_hook_cap(parsed);",
        "(true, true) => CredentialRealm::Both,",
        "if !auth.authorize(provided_token.as_deref()) {",
        # A rejection is logged with the command name and whether a token was
        # present at all: the peer port is ephemeral and identifies nothing.
        "auth.note_rejection(",
        'parsed.get("cmd").and_then(Value::as_str),',
        "provided_token.is_some(),",
        'error: "unauthorized",',
        'const SOCKET_TOKEN_FILE: &str = "mycmux.token";',
        'const SOCKET_AUTH_ENV: &str = "MYCMUX_SOCKET_AUTH";',
        "validate_token(provided, expected)",
    ]:
        assert_contains(socket_rs, snippet, "src-tauri/src/socket.rs")

    for snippet in [
        # Token discovery follows the active runtime dir so --profile
        # instances read their own token, never the production one.
        'return runtime_dir() / "mycmux.token"',
        'os.environ.get("MYCMUX_RUNTIME_DIR")',
        'payload["token"] = token',
    ]:
        assert_contains(agent_cli, snippet, "scripts/mycmux_agent_cli.py")

    for snippet in [
        'TOKEN_FILE_NAME = "mycmux.token"',
        'payload["token"] = token',
    ]:
        assert_contains(status_probe, snippet, "scripts/status_feed_probe.py")


def test_one_shot_tab_command_is_not_persisted() -> None:
    socket_listener = read_repo_text("src/components/layout/SocketListener.tsx")
    assert "command_argv" not in socket_listener

    to_config_start = socket_listener.index("export function toConfig(")
    to_config_end = socket_listener.index("\nlet _resolveLoaded", to_config_start)
    to_config = socket_listener[to_config_start:to_config_end]
    assert "commandArgv" not in to_config


def test_socket_global_activation_prohibitions_remain_explicit() -> None:
    # Whole-file bans and type-level guarantees have no exhaustive runtime equivalent.
    socket_commands = read_repo_text("src/components/layout/socketCommands.ts")
    layout_store = read_repo_text("src/stores/workspaceLayoutStore.ts")
    focus_web = function_slice(socket_commands, "async function focusWebPane(", "async function pushWebPane(")
    assert "setActiveWorkspace(" not in socket_commands.replace(focus_web, "")
    assert "focusController." not in socket_commands
    assert "force_focus" not in socket_commands
    assert "forceFocus" not in socket_commands
    # One deliberate exception to "a socket never moves the foreground": a tap the
    # person made on the phone, relayed as pane.spawn_tab --operator. It may take
    # the tab strip of the workspace already on screen and nothing more — a
    # workspace switch stays banned by the whole-file assertion above.
    spawn_tab = function_slice(socket_commands, "async function spawnTab(", "type DeclaredLaunchResult")
    assert 'socketArgBoolean(args, "operator", false)' in spawn_tab
    assert "applyStructuralActivation(newTab.sessionId)" in spawn_tab
    assert "setActiveWorkspace(" not in spawn_tab
    assert "activationSource?: \"human\" | \"socket\";" in layout_store
    assert "options.activationSource !== \"socket\"" in layout_store


def test_human_activation_paths_remain_explicit() -> None:
    app_shell = read_repo_text("src/components/layout/AppShell.tsx")
    terminal_pane = read_repo_text("src/components/workspace/TerminalPane.tsx")
    dashboard = read_repo_text("src/components/dashboard/DashboardView.tsx")

    workspace_jump = function_slice(app_shell, 'case "workspace.jump.1":', 'case "workspace.jump.9":')
    assert 'if (ws[num - 1]) setActiveWorkspace(ws[num - 1].id);' in workspace_jump
    assert_contains(
        app_shell,
        'focusController.request("keyboard", { sessionId: targetSessionId, focus: true });',
        "src/components/layout/AppShell.tsx",
    )
    assert_contains(
        terminal_pane,
        'focusController.request("tab-click", { sessionId: tab.sessionId, focus: true });',
        "src/components/workspace/TerminalPane.tsx",
    )
    dashboard_jump = function_slice(dashboard, "const jumpToCard = useCallback(", "  useEffect(() => {")
    assert_contains(
        dashboard_jump,
        "useWorkspaceListStore.getState().setActiveWorkspace(card.workspaceId);",
        "src/components/dashboard/DashboardView.tsx",
    )
    assert_contains(
        dashboard_jump,
        'focusController.request("programmatic", { sessionId: card.tab.sessionId, focus: true });',
        "src/components/dashboard/DashboardView.tsx",
    )
