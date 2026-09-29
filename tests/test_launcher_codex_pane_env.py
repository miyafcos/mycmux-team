"""Codex receives a quoted pane-id override without changing user config."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
SH = ROOT / "src-tauri/src/launcher.sh"
PS = ROOT / "src-tauri/src/launcher.ps1"
PANE_ID = 'C:\\my path\\pane "one"'


def test_bash_codex_quotes_pane_id_and_keeps_resume_args() -> None:
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash unavailable")
    env = os.environ.copy()
    env.update(MYCMUX_HOOK_WRAPPERS_ONLY="1", MYCMUX_PANE_SESSION_ID=PANE_ID,
               MYCMUX_DISPATCH_GUARD="off", TEST_LAUNCHER=SH.as_posix())
    script = r'''
source "$TEST_LAUNCHER"
__mycmux_issue_hook_cap() { printf cap; }
__mycmux_ensure_dispatch_guard() { :; }
test_codex() { printf 'ARG:%s\n' "$@"; printf 'KIND:%s\n' "${MYCMUX_LAUNCH_KIND:-none}"; }
__MYCMUX_PENDING_LAUNCH_KIND=resume
__mycmux_codex_with_pane test_codex resume --last
'''
    result = subprocess.run([bash, "-s"], input=script, env=env, text=True,
                            capture_output=True, encoding="utf-8", timeout=15)
    assert result.returncode == 0, result.stderr
    args = [line[4:] for line in result.stdout.splitlines() if line.startswith("ARG:")]
    assert args == ["-c", f"shell_environment_policy.set.MYCMUX_PANE_SESSION_ID={json.dumps(PANE_ID)}",
                    "resume", "--last"]
    assert "KIND:resume" in result.stdout


def test_powershell_codex_quotes_pane_id_and_keeps_resume_args() -> None:
    shell = shutil.which("powershell") or shutil.which("pwsh")
    if not shell:
        pytest.skip("PowerShell unavailable")
    env = os.environ.copy()
    env.update(MYCMUX_PANE_SESSION_ID=PANE_ID, TEST_LAUNCHER=str(PS))
    script = r'''
$src = Get-Content -LiteralPath $env:TEST_LAUNCHER -Raw -Encoding UTF8
$ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$null, [ref]$null)
$fn = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in @('codex', 'global:codex')}, $true)
Invoke-Expression $fn.Extent.Text
function Invoke-MycmuxAgentWithHook {
  param([string]$Provider, [string]$Executable, [object[]]$AgentArgs)
  foreach ($arg in $AgentArgs) { Write-Output "ARG:$arg" }
}
codex resume --last
'''
    result = subprocess.run([shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
                            env=env, text=True, capture_output=True, encoding="utf-8", timeout=15)
    assert result.returncode == 0, result.stderr
    args = [line[4:] for line in result.stdout.splitlines() if line.startswith("ARG:")]
    assert args == ["-c", f"shell_environment_policy.set.MYCMUX_PANE_SESSION_ID={json.dumps(PANE_ID)}",
                    "resume", "--last"]


@pytest.mark.parametrize("kind,expected_arg", [("codex", "--last"), ("grok", "--continue")])
@pytest.mark.parametrize("shell", ["bash", "powershell"])
def test_resume_without_id_uses_continue_kind(shell: str, kind: str, expected_arg: str) -> None:
    executable = shutil.which(shell)
    if not executable:
        pytest.skip(f"{shell} unavailable")
    env = os.environ.copy()
    env.update(MYCMUX_RESUME=kind, MYCMUX_SESSION_ID="", MYCMUX_PANE_SESSION_ID="test-pane",
               TEST_LAUNCHER=str(PS))
    if shell == "bash":
        source = SH.read_text(encoding="utf-8")
        start = source.index('if [ -n "$MYCMUX_RESUME" ]; then')
        end = source.index('\nfi', start) + 3
        script = r'''
__track_codex_session() { :; }
codex() { printf 'KIND:%s\n' "${__MYCMUX_PENDING_LAUNCH_KIND:-}"; printf 'ARG:%s\n' "$@"; }
grok() { printf 'KIND:%s\n' "${__MYCMUX_PENDING_LAUNCH_KIND:-}"; printf 'ARG:%s\n' "$@"; }
''' + source[start:end]
        command = [executable, "-s"]
    else:
        script = r'''
$src = Get-Content -LiteralPath $env:TEST_LAUNCHER -Raw -Encoding UTF8
$ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$null, [ref]$null)
$fn = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-MycmuxResumeFromEnv'}, $true)
Invoke-Expression $fn.Extent.Text
function Start-MycmuxSessionTracking {}
function Invoke-MycmuxCommandArray { param([string[]]$Command) Write-Output "KIND:$script:MycmuxPendingLaunchKind"; foreach ($arg in $Command) { Write-Output "ARG:$arg" } }
Invoke-MycmuxResumeFromEnv | Where-Object { $_ -isnot [bool] }
'''
        command = [executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]
    result = subprocess.run(command, input=script if shell == "bash" else None, env=env,
                            text=True, capture_output=True, encoding="utf-8", timeout=15)
    assert result.returncode == 0, result.stderr
    assert "KIND:resume" in result.stdout
    assert f"ARG:{expected_arg}" in result.stdout
