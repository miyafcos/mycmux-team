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
    assert "Cookie" not in rust


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
    assert "__web_chatgpt__)" in launcher, "the dispatch never handles the web entry"
    assert "--target web --preset chatgpt" in launcher, "the dispatch does not ask for a web tab"

    cli = read("scripts/mycmux_agent_cli.py")
    assert '"web"' in cli and "AGENT_TARGETS" in cli, "the CLI rejects --target web"
    assert '"--preset"' in cli, "the CLI cannot pass a preset"
    assert 'optional_arg(args, "preset"' in cli, "the preset never reaches the request"

    socket_commands = read("src/components/layout/socketCommands.ts")
    assert 'target === "web"' in socket_commands, "pane.spawn has no web branch"
    assert "addWebTabToPane(" in socket_commands, "the web branch never creates a web tab"


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
    arm = shell[shell.index("__web_chatgpt__)") :]
    arm = arm[: arm.index(";;")]
    assert "--target web --preset chatgpt" in arm
    assert ">/dev/null 2>&1" not in arm, "the shell arm throws the failure away"
    assert "web_rc" in arm, "the shell arm never inspects the exit code"

    ps = read("src-tauri/src/launcher.ps1")
    assert "function Invoke-MycmuxWebTab" in ps, "the PowerShell arm has no handler"
    handler = ps[ps.index("function Invoke-MycmuxWebTab") :]
    handler = handler[: handler.index("function Invoke-MycmuxOption")]
    assert "--target web --preset $Preset" in handler
    assert "$LASTEXITCODE" in handler, "the PowerShell arm never inspects the exit code"


def test_the_retired_fugu_entries_are_gone() -> None:
    """Removed on 2026-08-29 as unused; the dispatch must not keep dangling arms."""
    launcher = read("src-tauri/src/launcher.sh")
    assert '"Codex (Fugu Ultra)"' not in launcher
    assert '"claude-codex (Fugu)"' not in launcher
    assert "codex-fugu-ultra)" not in launcher
    assert "claude-codex-fugu)" not in launcher
