"""Run launcher handoffs against a PATH-first argv recorder, never a provider."""
from pathlib import Path
import json
import os
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]
SH = ROOT / "src-tauri/src/launcher.sh"
PS = ROOT / "src-tauri/src/launcher.ps1"
SESSION = "11111111-2222-4333-8444-555555555555"


def environment(tmp_path, with_id):
    bin_dir = tmp_path / "fake bin"
    bin_dir.mkdir()
    home = tmp_path / "isolated home"
    home.mkdir()
    prompt = tmp_path / "handoff prompt with spaces.md"
    prompt.write_text("Synthetic handoff only\n", encoding="utf-8")
    argv = tmp_path / "argv.json"
    env = {key: os.environ[key] for key in ("PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "PATHEXT") if key in os.environ}
    env.update(PATH=str(bin_dir) + os.pathsep + env.get("PATH", ""), HOME=str(home), USERPROFILE=str(home),
               MYCMUX_HANDOFF="grok", MYCMUX_HANDOFF_PROMPT_FILE=str(prompt),
               MYCMUX_PANE_SESSION_ID="", MYCMUX_TAB_ID=SESSION if with_id else "",
               MYCMUX_RUNTIME_DIR=str(home / "runtime"), TEST_ARGV=str(argv),
               TEST_SESSION=SESSION if with_id else "", TEST_LAUNCHER=str(PS),
               MYCMUX_LAUNCH_MODEL="grok-4", MYCMUX_LAUNCH_EFFORT="high")
    return bin_dir, prompt, argv, env


def assert_handoff(args, prompt, with_id):
    assert args.count("--permission-mode") == 1
    assert args[args.index("--permission-mode") + 1] == "auto"
    assert "bypassPermissions" not in args and "--resume" not in args
    assert "--no-alt-screen" in args
    assert ("--session-id" in args) == with_id
    if with_id:
        assert args[args.index("--session-id") + 1] == SESSION
    assert args[-1] == f'Handoff from previous session. Read "{prompt}" and continue from where it left off.'
    assert args[args.index("--model") + 1] == "grok-4"
    assert args[args.index("--reasoning-effort") + 1] == "high"


@pytest.mark.parametrize("with_id", [True, False])
def test_bash_real_grok_handoff_argv(tmp_path, with_id):
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("Bash unavailable")
    bin_dir, prompt, argv, env = environment(tmp_path, with_id)
    grok = bin_dir / "grok"
    grok.write_text('#!/bin/bash\nprintf "%s\\0" "$@" > "$TEST_ARGV"\n', encoding="utf-8")
    grok.chmod(0o755)
    # Exercise the full launcher. A blank UUID source selects its real no-id
    # branch; an unused MYCMUX_TAB_ID selects the real session-id branch.
    uuidgen = bin_dir / "uuidgen"
    uuidgen.write_text("#!/bin/bash\nexit 0\n", encoding="utf-8")
    uuidgen.chmod(0o755)
    result = subprocess.run([bash, str(SH)], cwd=tmp_path, env=env,
                            capture_output=True, text=True, encoding="utf-8", timeout=30)
    assert result.returncode == 0, result.stderr
    args = [arg.decode("utf-8") for arg in argv.read_bytes().split(b"\0")[:-1]]
    assert_handoff(args, prompt, with_id)


@pytest.mark.parametrize("with_id", [True, False])
def test_powershell_51_real_grok_handoff_argv(tmp_path, with_id):
    powershell = shutil.which("powershell")
    if not powershell:
        pytest.skip("Windows PowerShell 5.1 unavailable")
    bin_dir, prompt, argv, env = environment(tmp_path, with_id)
    (bin_dir / "grok.ps1").write_text(
        '[IO.File]::WriteAllText($env:TEST_ARGV, (ConvertTo-Json -Compress -InputObject @($args)), [Text.UTF8Encoding]::new($false))\n',
        encoding="utf-8")
    # Load the real handoff and actual external-command invocation using the
    # parser. Only ID acquisition and mapping persistence are fixture seams;
    # PS's automatic $HOME and installed providers are never read or changed.
    script = r"""
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'PowerShell 5.1 required' }
$src = Get-Content -LiteralPath $env:TEST_LAUNCHER -Raw -Encoding utf8
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$null, [ref]$errors)
if ($errors.Count) { throw 'Launcher parse errors' }
$want = @('Get-MycmuxCommandLeaf', 'Get-MycmuxLaunchSpecValue', 'Read-MycmuxLaunchSpecFromEnv', 'Add-MycmuxLaunchSpecToCommandArray', 'Invoke-MycmuxCommandArray', 'Invoke-MycmuxHandoffFromEnv')
$found = $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $want -contains $n.Name}, $true)
if ($found.Count -ne $want.Count) { throw 'Missing handoff helper' }
foreach ($f in $found) { Invoke-Expression $f.Extent.Text }
function Get-MycmuxGrokSessionId { return $env:TEST_SESSION }
function Write-MycmuxSessionMapping {}
Read-MycmuxLaunchSpecFromEnv
if (-not (Invoke-MycmuxHandoffFromEnv)) { throw 'Handoff not executed' }
if (Test-Path Env:\MYCMUX_HANDOFF) { throw 'Handoff state not consumed' }
"""
    result = subprocess.run([powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
                            cwd=tmp_path, env=env, capture_output=True, text=True, encoding="utf-8", timeout=30)
    assert result.returncode == 0, result.stderr
    assert_handoff(json.loads(argv.read_text(encoding="utf-8-sig")), prompt, with_id)
