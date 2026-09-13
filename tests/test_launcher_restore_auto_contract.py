"""Execute Claude restore branches with CLI stubs; never start a real agent."""
from pathlib import Path
import os
import shutil
import subprocess
import pytest

ROOT = Path(__file__).resolve().parents[1]
SH = ROOT / "src-tauri/src/launcher.sh"
PS = ROOT / "src-tauri/src/launcher.ps1"
NOTICE = "Previous conversation could not be restored; starting a new session."


def test_claude_launch_lines_never_bypass_or_continue():
    for path in (SH, PS):
        source = path.read_text(encoding="utf-8")
        lines = [line for line in source.splitlines()
                 if ('eval ' in line or 'claude --' in line or '@("claude"' in line
                     or '@("claude-codex"' in line) and not line.lstrip().startswith('#')]
        assert lines
        for line in lines:
            assert "bypassPermissions" not in line, line
            assert "--dangerously-skip-permissions" not in line, line
            assert "--continue" not in line, line



@pytest.mark.parametrize("shell", ["bash", "powershell"])
@pytest.mark.parametrize("case", ["resume", "fork", "missing-id", "missing-file", "missing-cwd"])
@pytest.mark.parametrize("saved", [True, False])
def test_restore_auto_and_saved_values(shell, case, saved, tmp_path):
    executable = shutil.which(shell)
    if not executable:
        pytest.skip(f"{shell} unavailable")
    env = {key: os.environ[key] for key in ("PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "PATHEXT") if key in os.environ}
    transcript = tmp_path / "saved-id.jsonl"
    if case != "missing-file":
        transcript.write_text("{}\n", encoding="utf-8")
    env.update(TEST_PROJECT_DIR=tmp_path.as_posix(), TEST_SESSION_FILE=transcript.as_posix(),
               TEST_CWD=(tmp_path / "missing" if case == "missing-cwd" else tmp_path).as_posix())
    env.update(MYCMUX_RESUME="claude", MYCMUX_SESSION_ID="" if case == "missing-id" else "saved-id",
               MYCMUX_RESUME_FORK="1" if case == "fork" else "", MYCMUX_PANE_SESSION_ID="test-pane",
               MYCMUX_LAUNCH_MODEL="  opus  " if saved else "", MYCMUX_LAUNCH_EFFORT=" high " if saved else "",
               TEST_LAUNCHER=str(PS))
    if shell == "bash":
        source = SH.read_text(encoding="utf-8")
        start = source.index("__launch_spec_value() {")
        end = source.index("__read_launch_spec_from_env\n", start)
        helpers = source[start:end] + "__read_launch_spec_from_env\n"
        start = source.index('if [ -n "$MYCMUX_RESUME" ]; then')
        end = source.index('\nfi', start) + 3
        prepare_start = source.index("__prepare_claude_resume() {")
        prepare_end = source.index("\n}\n", prepare_start) + 3
        script = helpers + source[prepare_start:prepare_end] + r"""
__find_claude_session_file() { [ -f "$TEST_SESSION_FILE" ] || return 1; printf '%s' "$TEST_SESSION_FILE"; }
__claude_session_cwd() { printf '%s' "$TEST_CWD"; }
__mycmux_is_windows_shell() { return 1; }
__get_claude_project_dir() { printf '%s' "$TEST_PROJECT_DIR"; }
__trust_claude_cwd() { :; }
__write_session_mapping() { :; }
__track_claude_session() { :; }
claude() { printf 'ARG:%s\n' "$@"; }
""" + source[start:end]
        command = [executable, "-s"]
    else:
        script = r"""
$ErrorActionPreference = 'Stop'
$src = Get-Content -LiteralPath $env:TEST_LAUNCHER -Raw -Encoding utf8
$ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$null, [ref]$null)
$want = @('Get-MycmuxCommandLeaf', 'Get-MycmuxLaunchSpecValue', 'Read-MycmuxLaunchSpecFromEnv', 'Add-MycmuxLaunchSpecToCommandArray', 'Invoke-MycmuxResumeFromEnv', 'Set-MycmuxClaudeResumeLocation')
foreach ($f in $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $want -contains $n.Name}, $true)) { Invoke-Expression $f.Extent.Text }
function Find-MycmuxClaudeSessionFile { if (Test-Path -LiteralPath $env:TEST_SESSION_FILE) { return $env:TEST_SESSION_FILE }; return '' }
function Get-MycmuxClaudeSessionCwd { return $env:TEST_CWD }
function Write-MycmuxSessionMapping {}
function Start-MycmuxSessionTracking {}
function Get-MycmuxClaudeProjectDir { return $env:TEST_PROJECT_DIR }
function Invoke-MycmuxCommandArray { param([string[]]$Command) foreach ($arg in $Command[1..($Command.Length-1)]) { Write-Output "ARG:$arg" } }
Read-MycmuxLaunchSpecFromEnv
Invoke-MycmuxResumeFromEnv | Write-Output
"""
        command = [executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]
    result = subprocess.run(command, input=script if shell == "bash" else None,
                            env=env, capture_output=True, text=True, encoding="utf-8", timeout=30)
    assert result.returncode == 0, result.stderr
    args = [line[4:] for line in result.stdout.splitlines() if line.startswith("ARG:")]
    assert args.count("--permission-mode") == 1
    assert args[args.index("--permission-mode") + 1] == "auto"
    assert "--allow-dangerously-skip-permissions" in args
    assert "--dangerously-skip-permissions" not in args
    assert "bypassPermissions" not in args
    assert "--continue" not in args
    if saved:
        assert args[args.index("--model") + 1] == "opus"
        assert args[args.index("--effort") + 1] == "high"
    else:
        assert "--model" not in args and "--effort" not in args
    if case in ("resume", "fork"):
        assert args[args.index("--resume") + 1] == "saved-id"
        assert ("--fork-session" in args) == (case == "fork")
        assert NOTICE not in result.stdout
    else:
        assert "--resume" not in args and "saved-id" not in args
        assert result.stdout.count(NOTICE) == 1
