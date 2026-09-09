import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def test_child_webview_uses_isolated_profile_and_explicit_lifecycle() -> None:
    rust = read("src-tauri/src/commands/webpane.rs")
    assert "WEB_PANE_PRESETS" in rust
    assert 'id: "chatgpt"' in rust
    assert '.app_local_data_dir()' in rust
    assert '.join("web-profiles")' in rust
    assert ".data_directory(profile_dir)" in rust
    assert "fn macos_data_store_identifier(profile_dir: &str) -> [u8; 16]" in rust
    assert "builder.data_store_identifier(identifier)" in rust
    assert "hex::encode(identifier)" in rust
    assert ".initialization_script(" in rust
    assert '"plugin:event|emit"' in rust
    assert "event.isTrusted" in rust
    assert "event.isComposing" in rust
    assert "event.keyCode === 229" in rust
    assert ".add_child(" in rust
    assert ".set_position(" in rust
    assert ".set_size(" in rust
    assert ".hide()" in rust
    assert ".show()" in rust
    assert ".close()" in rust
    assert "PageLoadEvent::Finished" in rust
    # Credentials stay in the browser profile where the OS protects them: the
    # pane shares a folder, it never reads or moves a cookie itself. Naming the
    # cookie database in a comment is how the \\?\ bug is explained, so the ban
    # is on the APIs, not on the word.
    for api in ("set_cookie", "cookies_for_url", "cookie_manager", "ICoreWebView2CookieManager"):
        assert api not in rust, api


def test_the_profile_path_handed_to_webview2_is_not_extended_length() -> None:
    """`std::fs::canonicalize` is the bug, not a style preference.

    On Windows it returns a `\\\\?\\` path, and Chromium's sandboxed network
    service will not create `Default\\Network\\Cookies` under one. The profile
    still loads and history and local storage still persist, so the pane looks
    healthy while every login is lost the moment the app closes -- which is
    exactly how this shipped between 2026-08-29 and 2026-09-03.
    """
    rust = read("src-tauri/src/commands/webpane.rs")
    assert "dunce::canonicalize" in rust, "the profile path is no longer normalised safely"
    assert ".canonicalize()" not in rust, (
        "std::fs::canonicalize is back: it hands WebView2 a \\\\?\\ path and cookies stop persisting"
    )
    cargo = read("src-tauri/Cargo.toml")
    assert re.search(r"^dunce = ", cargo, re.MULTILINE), "dunce is not a declared dependency"


def test_sign_in_follows_the_platform_browser_contract() -> None:
    """Windows hands the WebView2 profile to Edge; macOS stays in WKWebView.

    A sign-in browser aimed at the parent seeds `<profile>\\Default`, which the
    pane never reads -- the 2026-08-28 spike concluded the handoff worked while
    the pane's own folder held no cookie database at all.
    """
    rust = read("src-tauri/src/commands/webpane.rs")
    assert '#[cfg(target_os = "windows")]\nfn find_signin_browser' in rust
    assert 'join("EBWebView")' in rust
    assert "--user-data-dir=" in rust
    assert "msedge.exe" in rust
    assert '#[cfg(target_os = "macos")]' in rust
    assert "external_signin_required: false" in rust
    assert "external_signin_required: true" in rust
    assert "WKWebView uses Safari's engine" in rust
    # The folder can only be owned by one browser process at a time.
    assert "lockfile" in rust
    assert "wait_for_profile_release" in rust


def test_webpane_push_command_is_wired_to_dom_acknowledged_evaluation() -> None:
    rust = read("src-tauri/src/commands/webpane.rs")
    start = rust.index("pub async fn webpane_push(")
    body = rust[start : rust.index("\n#[cfg(test)]", start)]
    assert "composer_push_script(" in body
    assert "webview.eval(script)" in body
    assert "tokio::time::timeout(WEB_PANE_PUSH_TIMEOUT" in body
    assert "web pane does not exist" in body
    assert 'caller.label() != caller.window().label()' in body
    assert 'pub async fn webpane_push_result(' in body
    assert "return Ok(WebPanePushResult" not in body


def test_web_tab_never_falls_through_to_terminal_rendering() -> None:
    pane = read("src/components/workspace/TerminalPane.tsx")
    web_branch = pane.index('activeTab?.type === "web"')
    terminal_branch = pane.index("activeTab && isTerminalTab(activeTab) && agent", web_branch)
    assert web_branch < terminal_branch
    assert "activeTab && isTerminalTab(activeTab) && isRestorableTab(activeTab) && agent" in pane


def test_web_runtime_is_not_disposed_on_react_workspace_unmount() -> None:
    controller = read("src/components/workspace/WebPaneController.tsx")
    assert "collectWebPaneTabs(workspaces)" in controller
    assert "destroyWebPane(tabId)" in controller
    assert "return () => {\n      cancelled = true;" in controller
    cleanup = controller[controller.index("return () => {\n      cancelled = true;") :]
    assert "destroyWebPane" not in cleanup


def test_forbidden_terminal_and_pty_paths_stay_untouched_by_webpane_code() -> None:
    web_sources = "\n".join(
        read(path)
        for path in (
            "src-tauri/src/commands/webpane.rs",
            "src/components/workspace/WebPaneController.tsx",
            "src/components/workspace/webPaneApi.ts",
            "src/components/workspace/webPaneShortcuts.ts",
        )
    )
    assert "create_session" not in web_sources
    assert "kill_session" not in web_sources
    assert "write_to_session" not in web_sources


def test_web_tab_can_be_opened_from_the_launcher() -> None:
    """The launcher entry has to reach a web tab, not eval a command string.

    A web tab has no PTY, so it cannot ride the eval path every other entry
    uses. The menu item, the shell dispatch, the CLI target and the socket
    branch all have to line up, and a break anywhere leaves a menu entry that
    does nothing when picked.
    """
    # The canonical launcher is the one embedded in the binary (lib.rs uses
    # include_str!), and it overwrites ~/.mycmux/bin/launcher.sh on every start.
    # Asserting on the deployed copy would pass while the source stayed stale.
    launcher = read("src-tauri/src/launcher.sh")
    assert '"ChatGPT (Web)"' in launcher, "menu label is missing"
    assert '"__web_chatgpt__"' in launcher, "menu command slot is missing"
    assert "__web_chatgpt__|" in launcher, "the dispatch never handles the web entry"
    assert 'web-open --preset "$preset" --replace-anchor' in launcher, (
        "the dispatch does not ask for a web tab in place of the launcher tab"
    )

    cli = read("scripts/mycmux_agent_cli.py")
    assert '"web-open"' in cli, "the CLI has no web-open subcommand"
    assert 'return "web.open"' in cli, "web-open never reaches the socket command"
    assert '"replaceAnchor"' in cli, "the CLI cannot ask to replace the anchor tab"

    socket_commands = read("src/components/layout/socketCommands.ts")
    assert 'case "web.open"' in socket_commands, "the socket has no web.open branch"
    assert "addWebTabToPane(" in socket_commands, "the web branch never creates a web tab"


def test_every_registered_preset_has_a_launcher_entry_in_both_launchers() -> None:
    """A preset nobody can reach from the launcher is not shipped.

    Presets are declared once in Rust; each launcher needs a menu slot and a
    dispatch arm per preset. Deriving the expected set from the Rust table
    means adding a service cannot quietly skip one of the two launchers.
    """
    rust = read("src-tauri/src/commands/webpane.rs")
    presets = re.findall(r'^\s+id: "(\w+)",$', rust, re.MULTILINE)
    assert sorted(presets) == ["browser", "chatgpt", "claude", "gemini", "grok", "notebooklm"], presets

    shell = read("src-tauri/src/launcher.sh")
    ps = read("src-tauri/src/launcher.ps1")
    for preset in presets:
        pseudo = f"__web_{preset}__"
        assert f'"{pseudo}"' in shell, f"launcher.sh has no menu slot for {preset}"
        assert pseudo in ps, f"launcher.ps1 has no menu slot for {preset}"
        assert f'-eq "{pseudo}"' in ps, f"launcher.ps1 has no dispatch arm for {preset}"
        assert f'Invoke-MycmuxWebTab "{preset}"' in ps, (
            f"launcher.ps1 never asks for the {preset} preset"
        )


def test_the_powershell_launch_target_table_points_at_the_right_rows() -> None:
    """`$LaunchTargets` indexes `$Options` by position, so an insert shifts it.

    Four web entries landed in the middle of the list on 2026-09-03. A stale
    index here does not fail loudly -- it launches a different program.
    """
    ps = read("src-tauri/src/launcher.ps1")
    labels = re.findall(r'New-MycmuxOption\s+"([^"]+)"', ps)
    targets = dict(re.findall(r'^\s*"([\w.-]+)" = \$Options\[(\d+)\]', ps, re.MULTILINE))
    expected = {
        "claude": "Claude Code",
        "codex": "Codex",
        "grok": "Grok Build",
        "agy": "Antigravity (agy)",
        "web-chatgpt": "ChatGPT (Web)",
        "web-gemini": "Gemini (Web)",
        "web-grok": "Grok (Web)",
        "web-claude": "Claude.ai (Web)",
        "web-notebooklm": "NotebookLM (Web)",
        "web-browser": "Browser (Web)",
        "claude-resume": "Claude Code (resume)",
        "grok-resume": "Grok Build (resume)",
        "custom": "Custom...",
    }
    for name, label in expected.items():
        assert name in targets, f"{name} has no launch target"
        assert labels[int(targets[name])] == label, (
            f"{name} points at {labels[int(targets[name])]!r}, expected {label!r}"
        )


def test_the_shell_launcher_menu_and_command_arrays_stay_aligned() -> None:
    """Both arrays are indexed by the same cursor, so a missed line launches
    the neighbouring entry instead of failing."""
    shell = read("src-tauri/src/launcher.sh")
    options = re.search(r"  options=\(\n(.*?)\n  \)", shell, re.S)
    commands = re.search(r"  commands=\(\n(.*?)\n  \)", shell, re.S)
    assert options and commands, "the launcher menu arrays could not be found"
    assert len(options.group(1).splitlines()) == len(commands.group(1).splitlines())


def test_spawn_tab_refuses_a_web_target_instead_of_opening_a_shell() -> None:
    """pane.spawn_tab builds terminal tabs only, so a web target must be refused.

    `spawn --target web` (no --split) routes to pane.spawn_tab, whose
    addTabToPaneWithOptions always calls makeTab(..., "terminal", ...) and drops
    webPresetId on the floor. Between v0.59.0 and 2026-09-02 that is exactly what
    the ChatGPT launcher entry did: it opened a background shell tab and looked
    like the menu item was broken. Silence is the defect here, not the refusal.
    """
    socket_commands = read("src/components/layout/socketCommands.ts")
    plan = socket_commands[socket_commands.index("export function resolveSpawnTabPlan(") :]
    plan = plan[: plan.index("export function resolveSpawnOrigin(")]
    assert 'target === "web"' in plan, "spawn_tab does not inspect a web target"
    assert "pane.spawn_tab cannot create a web tab" in plan, "the refusal has no message"
    assert "web.open" in plan, "the refusal does not name the route that works"

    store = read("src/stores/workspaceLayoutStore.ts")
    add_tab = store[store.index("  addTabToPaneWithOptions: (workspaceId, paneId, options) => {") :]
    add_tab = add_tab[: add_tab.index("  declareTab:")]
    assert "webPresetId" not in add_tab, (
        "addTabToPaneWithOptions now understands presets -- revisit the refusal above"
    )


def test_every_pseudo_command_in_a_launcher_has_a_dispatch_arm() -> None:
    """A menu entry that no dispatch handles is a dead button.

    Pseudo commands (``__name__``) are not executables: picking one runs a
    handler, or the launcher tries to exec a program that does not exist. The
    ChatGPT entry shipped in v0.59.0 with a menu slot in both launchers but an
    arm in only the shell one, so the PowerShell launcher failed with
    CommandNotFound and the item looked broken. Checking one launcher is what
    let that through -- both are checked here, and any future pseudo command is
    covered without editing this test.
    """
    shell = read("src-tauri/src/launcher.sh")
    shell_offered = set(re.findall(r'^\s*"(__\w+__)"\s*$', shell, re.MULTILINE))
    shell_handled: set[str] = set()
    # Two shapes count as handled: a case arm (``__name__)``, which may bundle
    # several names with ``|``) and a plain string comparison outside the case.
    for arm in re.findall(r"^\s*((?:__\w+__\|)*__\w+__)\)", shell, re.MULTILINE):
        shell_handled.update(arm.split("|"))
    shell_handled.update(re.findall(r'=\s*"(__\w+__)"\s*\]', shell))
    assert shell_offered, "no pseudo commands found -- the pattern stopped matching"
    assert not (shell_offered - shell_handled), (
        f"launcher.sh offers menu entries it cannot run: {sorted(shell_offered - shell_handled)}"
    )

    ps = read("src-tauri/src/launcher.ps1")
    ps_offered = set(re.findall(r'New-MycmuxOption\s+"[^"]+"\s+@\("(__\w+__)"', ps))
    ps_handled = set(re.findall(r'\$Option\.Command\[0\]\s+-eq\s+"(__\w+__)"', ps))
    assert ps_offered, "no pseudo commands found -- the pattern stopped matching"
    assert not (ps_offered - ps_handled), (
        f"launcher.ps1 offers menu entries it cannot run: {sorted(ps_offered - ps_handled)}"
    )


def test_the_web_tab_launcher_arms_do_not_swallow_their_failure() -> None:
    """A silent failure reads as "the launcher is broken" to the operator.

    Both arms shell out to the CLI. If that call is discarded the menu item
    simply returns to the prompt with nothing said, which is exactly how the
    PowerShell breakage presented itself.
    """
    shell = read("src-tauri/src/launcher.sh")
    opener = shell[shell.index("__open_web_tab() {") :]
    opener = opener[: opener.index("\n}\n")]
    assert 'web-open --preset "$preset" --replace-anchor' in opener
    assert ">/dev/null 2>&1" not in opener, "the shell arm throws the failure away"
    assert "web_rc" in opener, "the shell arm never inspects the exit code"
    # The menu arm must actually reach that shared opener.
    arm = shell[shell.index("__web_chatgpt__|__web_gemini__") :]
    arm = arm[: arm.index(";;")]
    assert "__open_web_tab_from_pseudo_command" in arm

    ps = read("src-tauri/src/launcher.ps1")
    assert "function Invoke-MycmuxWebTab" in ps, "the PowerShell arm has no handler"
    handler = ps[ps.index("function Invoke-MycmuxWebTab") :]
    handler = handler[: handler.index("function Invoke-MycmuxOption")]
    assert "web-open --preset $Preset --replace-anchor" in handler
    assert "$LASTEXITCODE" in handler, "the PowerShell arm never inspects the exit code"


def test_the_retired_fugu_entries_are_gone() -> None:
    """Removed on 2026-08-29 as unused; the dispatch must not keep dangling arms."""
    launcher = read("src-tauri/src/launcher.sh")
    assert '"Codex (Fugu Ultra)"' not in launcher
    assert '"claude-codex (Fugu)"' not in launcher
    assert "codex-fugu-ultra)" not in launcher
    assert "claude-codex-fugu)" not in launcher


def test_every_web_preset_has_a_tab_mark() -> None:
    """A Web tab must show the same mark its launcher row showed.

    The tab bar reads `agentKind` and the PTY command to decide which mark to
    draw, and a Web tab has neither -- so before `WEB_PRESET_MARKS` existed the
    tab fell back to an empty grey chip while the launcher row next to it drew
    the vendor's mark. The preset id is the only thing that connects the two,
    which makes this list the contract: a preset added to Rust without a mark
    here ships that grey chip again.
    """
    rust = read("src-tauri/src/commands/webpane.rs")
    presets_block = rust[rust.index("const WEB_PANE_PRESETS:") : rust.index("static WEB_PANE_OPEN_PRESETS")]
    rust_ids = set(re.findall(r'^\s+id: "([a-z0-9-]+)",', presets_block, re.MULTILINE))
    assert rust_ids, "no preset ids found in webpane.rs"

    marks = read("src/lib/tabMark.ts")
    marks_block = marks[marks.index("export const WEB_PRESET_MARKS") :]
    marks_block = marks_block[: marks_block.index("};")]
    mark_ids = set(re.findall(r"^\s+([a-z0-9-]+): \{ kind:", marks_block, re.MULTILINE))

    assert mark_ids == rust_ids, (
        f"web preset marks drifted from webpane.rs: only in Rust {sorted(rust_ids - mark_ids)}, "
        f"only in tabMark.ts {sorted(mark_ids - rust_ids)}"
    )
