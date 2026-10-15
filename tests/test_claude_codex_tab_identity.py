from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import uuid

import pytest


ROOT = Path(__file__).resolve().parents[1]
TAB_ID = "4af809a7-ab03-44d3-b8f1-e264e8ee4061"
CASES = [
    ([], True),
    (["--backend", "gpt", "--model", "gpt-6.1-sol"], True),
    (["--resume", "saved-id"], False),
    (["--resume=saved-id"], False),
    (["--continue"], False),
    (["-c"], False),
    (["-rsaved-id"], False),
    (["--fork-session"], False),
    (["--session-id", "saved-id"], False),
    (["--session-id=saved-id"], False),
    (["-p", "prompt"], False),
    (["--print"], False),
    (["--no-session-persistence"], False),
    (["--help"], False),
    (["--version"], False),
    (["mcp", "list"], False),
    (["auth", "status"], False),
    (["doctor"], False),
    (["update"], False),
]


def launch_arguments(shell: str, arguments: list[str], tmp_path: Path, *, pane: str = "test-pty", tab: str = TAB_ID, existing: bytes | None = None) -> tuple[list[str], Path]:
    environment = os.environ.copy()
    (tmp_path / "uuid.py").write_text('raise RuntimeError("untrusted working directory import")\n', encoding="utf-8")
    runtime = tmp_path / "runtime with spaces"
    if existing is not None:
        mapping = runtime / "pane-sessions" / f"{tab}.txt"
        mapping.parent.mkdir(parents=True)
        mapping.write_bytes(existing)
    environment.update(
        MYCMUX_PANE_SESSION_ID=pane,
        MYCMUX_TAB_ID=tab,
        MYCMUX_RUNTIME_DIR=str(runtime),
        ICON_TEST_ARGS=json.dumps(arguments),
        ICON_TEST_ROOT=str(ROOT),
    )
    if shell == "powershell":
        executable = shutil.which("powershell")
        if not executable:
            pytest.skip("PowerShell unavailable")
        script = r'''
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$path = Join-Path $env:ICON_TEST_ROOT 'src-tauri/src/launcher.ps1'
$source = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$null, [ref]$errors)
if ($errors.Count) { throw $errors[0] }
$definitions = $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -match '(^|:)(Get-MycmuxClaudeCodexLaunchArgs|claude-codex)$'}, $true)
foreach ($definition in $definitions) { Invoke-Expression $definition.Extent.Text }
function Invoke-MycmuxAgentWithHook {
  param([string]$Provider, [string]$Executable, [object[]]$AgentArgs)
  ConvertTo-Json -InputObject @($AgentArgs) -Compress
}
$arguments = ConvertFrom-Json $env:ICON_TEST_ARGS
claude-codex @arguments
'''
        encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
        command = [executable, "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]
        stdin = None
    else:
        executable = shutil.which("bash")
        if not executable:
            pytest.skip("Bash unavailable")
        source = (ROOT / "src-tauri/src/launcher.sh").read_text(encoding="utf-8")
        start = source.index("__mycmux_claude_codex_launch_args() {")
        wrapper = source.index("\n__mycmux_claude_codex_with_hook()", start)
        end = source.index("\n}\n", wrapper) + 3
        functions = source[start:end]
        script = "__mycmux_python() { command -v python; }\n" + functions + "\n"
        script += "__mycmux_with_hook_cap() { shift 2; python -I -c 'import json,sys; print(json.dumps(sys.argv[1:]))' \"$@\"; }\n"
        script += "__mycmux_claude_codex_with_hook /fixture/claude-codex \"$@\"\n"
        command = [executable, "-s", "--", *arguments]
        stdin = script
    result = subprocess.run(command, input=stdin, cwd=tmp_path, env=environment, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20)
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout), runtime / "pane-sessions" / f"{tab}.txt"


@pytest.mark.parametrize("shell", ["bash", "powershell"])
@pytest.mark.parametrize(("arguments", "register"), CASES)
def test_new_session_is_registered_before_launch(shell: str, arguments: list[str], register: bool, tmp_path: Path) -> None:
    captured, mapping = launch_arguments(shell, arguments, tmp_path)
    if register:
        assert captured[0] == "--session-id"
        session_id = captured[1]
        assert str(uuid.UUID(session_id)) == session_id
        assert mapping.read_text(encoding="utf-8").strip() == f"claude-codex:{session_id}"
        assert captured[2:] == arguments
    else:
        assert captured == arguments
        assert not mapping.exists()


@pytest.mark.parametrize("shell", ["bash", "powershell"])
@pytest.mark.parametrize(("pane", "tab"), [("", TAB_ID), ("test-pty", "invalid"), ("test-pty", "------------------------------------")])
def test_identity_registration_requires_exact_tab(shell: str, pane: str, tab: str, tmp_path: Path) -> None:
    captured, mapping = launch_arguments(shell, [], tmp_path, pane=pane, tab=tab)
    assert captured == []
    assert not mapping.exists()


@pytest.mark.parametrize("shell", ["bash", "powershell"])
@pytest.mark.parametrize("arguments", [["mcp", "list"], ["auth", "status"], ["doctor"], ["update"]])
def test_management_commands_preserve_existing_mapping(shell: str, arguments: list[str], tmp_path: Path) -> None:
    previous = b"claude-codex:11111111-1111-4111-8111-111111111111\r\n"
    captured, mapping = launch_arguments(shell, arguments, tmp_path, existing=previous)
    assert captured == arguments
    assert mapping.read_bytes() == previous


def test_claude_codex_wrappers_use_identity_helper_without_changing_claude() -> None:
    powershell = (ROOT / "src-tauri/src/launcher.ps1").read_text(encoding="utf-8")
    bash = (ROOT / "src-tauri/src/launcher.sh").read_text(encoding="utf-8")
    assert "Get-MycmuxClaudeCodexLaunchArgs -AgentArgs @($args)" in powershell
    assert '__mycmux_claude_codex_with_hook "$HOME/bin/claude-codex.cmd" "$@"' in bash
    assert '__mycmux_claude_codex_with_hook "$executable" "$@"' in bash
    assert 'claude() { __mycmux_with_hook_cap claude "$HOME/bin/claude.cmd" "$@"; }' in bash
    assert re.search(r'function global:claude \{\s+Invoke-MycmuxAgentWithHook "claude"', powershell)
