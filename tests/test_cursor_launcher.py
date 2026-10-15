"""Cursor resolution and child-only Windows shell selection, without the real CLI."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
PS1 = ROOT / "src-tauri/src/launcher.ps1"
SH = ROOT / "src-tauri/src/launcher.sh"

PS_HELPERS = r'''
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = "Stop"
$src = Get-Content -LiteralPath $env:CURSOR_TEST_SOURCE -Raw -Encoding UTF8
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($src,[ref]$null,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @("Get-MycmuxCursorCommand","Invoke-MycmuxCursor")) {
  $fn = $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
  if ($fn.Count -ne 1) { throw "Missing helper $name" }
  Invoke-Expression $fn[0].Extent.Text
}
'''


def run_ps(body: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    shell = shutil.which("powershell") or shutil.which("pwsh")
    if not shell:
        pytest.skip("PowerShell unavailable")
    result = subprocess.run([shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PS_HELPERS + body],
                            env={**env, "CURSOR_TEST_SOURCE": str(PS1)}, capture_output=True,
                            text=True, encoding="utf-8", timeout=30)
    assert result.returncode == 0, result.stderr
    return result


@pytest.mark.skipif(os.name != "nt", reason="Windows .cmd resolution")
@pytest.mark.parametrize("installed", [True, False])
def test_windows_resolution_and_environment_are_scoped_to_one_child(tmp_path: Path, installed: bool) -> None:
    local = tmp_path / "local appdata"
    bin_dir = tmp_path / "path bin"
    bin_dir.mkdir()
    recorder = tmp_path / "record.py"
    record = tmp_path / "child.json"
    recorder.write_text("import json,os,sys\nfrom pathlib import Path\n"
                        "Path(os.environ['CURSOR_TEST_RECORD']).write_text(json.dumps({"
                        "'args':sys.argv[1:],'shell':os.getenv('SHELL'),'msystem':os.getenv('MSYSTEM'),"
                        "'exepath':os.getenv('EXEPATH')}),encoding='utf-8')\n", encoding="utf-8")
    cmd = f'@echo off\n"{sys.executable}" "{recorder}" %*\nexit /b 7\n'
    fallback = bin_dir / "cursor-agent.cmd"
    fallback.write_text(cmd, encoding="utf-8")
    expected = local / "cursor-agent/cursor-agent.cmd" if installed else fallback
    if installed:
        expected.parent.mkdir(parents=True)
        expected.write_text(cmd, encoding="utf-8")
    env = {**os.environ, "LOCALAPPDATA": str(local), "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"],
           "SHELL": "old-shell", "MSYSTEM": "MINGW64", "EXEPATH": "old-exepath", "CURSOR_TEST_RECORD": str(record)}
    result = run_ps(r'''
$resolved = Get-MycmuxCursorCommand
Invoke-MycmuxCursor -Arguments @("--model","composer-2.5","--","a prompt with spaces")
@{ resolved=$resolved; shell=$env:SHELL; msystem=$env:MSYSTEM; exepath=$env:EXEPATH; childExit=$LASTEXITCODE } | ConvertTo-Json -Compress
''', env)
    after = json.loads(result.stdout)
    assert Path(after["resolved"]) == expected
    assert after == {"resolved": str(expected), "shell": "old-shell", "msystem": "MINGW64", "exepath": "old-exepath", "childExit": 7}
    child = json.loads(record.read_text(encoding="utf-8"))
    assert child == {"args": ["--model", "composer-2.5", "--", "a prompt with spaces"],
                     "shell": "powershell", "msystem": None, "exepath": None}


@pytest.mark.skipif(os.name != "nt", reason="Windows resolver")
def test_missing_cursor_explains_installation_without_starting_agent(tmp_path: Path) -> None:
    env = {**os.environ, "LOCALAPPDATA": str(tmp_path), "PATH": os.environ["SystemRoot"] + r"\System32"}
    result = run_ps("Invoke-MycmuxCursor", env)
    assert "https://cursor.com/install?win32=true" in result.stdout
    assert "irm" in result.stdout and "iex" in result.stdout


@pytest.mark.skipif(os.name != "nt", reason="Windows environment restoration")
def test_windows_environment_restores_absent_values_when_child_throws(tmp_path: Path) -> None:
    throwing = tmp_path / "throw.ps1"
    throwing.write_text('throw "fixture failure"\n', encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if k.upper() not in {"SHELL", "MSYSTEM", "EXEPATH"}}
    env["CURSOR_TEST_THROWER"] = str(throwing)
    result = run_ps(r'''
function Get-MycmuxCursorCommand { return $env:CURSOR_TEST_THROWER }
$caught = $false
try { Invoke-MycmuxCursor } catch { $caught = $true }
@{ caught=$caught; shell=$env:SHELL; msystem=$env:MSYSTEM; exepath=$env:EXEPATH } | ConvertTo-Json -Compress
''', env)
    assert json.loads(result.stdout) == {"caught": True, "shell": None, "msystem": None, "exepath": None}


@pytest.mark.parametrize("unsafe", [False, True])
def test_fresh_cursor_prompt_uses_one_argument_and_never_records_a_claude_identity(tmp_path: Path, unsafe: bool) -> None:
    prompt = str(tmp_path / ("a&b.md" if unsafe else "instruction \u65e5\u672c\u8a9e.md"))
    env = {**os.environ, "MYCMUX_HANDOFF": "cursor", "MYCMUX_HANDOFF_PROMPT_FILE": prompt,
           "MYCMUX_HANDOFF_LAUNCH_KIND": "new"}
    result = run_ps(r'''
foreach ($name in @("Get-MycmuxCommandLeaf","Add-MycmuxLaunchSpecToCommandArray","Invoke-MycmuxHandoffFromEnv")) {
  $fn = $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
  Invoke-Expression $fn[0].Extent.Text
}
function Invoke-MycmuxCursor { param([string[]]$Arguments) $script:captured = $Arguments }
$script:MycmuxLaunchModel = "composer-2.5"
$script:MycmuxLaunchEffort = ""
$handled = Invoke-MycmuxHandoffFromEnv
@{ handled=$handled; args=@($script:captured); leaked=$env:MYCMUX_HANDOFF } | ConvertTo-Json -Compress
''', env)
    data = json.loads(result.stdout.splitlines()[-1])
    assert data["handled"] is True
    assert data["leaked"] is None
    if unsafe:
        assert data["args"] == [None]
    else:
        assert data["args"] == ["--model", "composer-2.5", "--", f"Read the UTF-8 instruction file at {prompt} and follow its instructions."]


@pytest.mark.parametrize("platform", ["macos", "linux"])
@pytest.mark.parametrize("on_path", [True, False])
def test_posix_resolution_keeps_space_paths_and_arguments(tmp_path: Path, platform: str, on_path: bool) -> None:
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash unavailable")
    source = SH.read_text(encoding="utf-8")
    helper = source.split("__mycmux_cursor() {", 1)[1].split("\n}\n", 1)[0]
    home = tmp_path / "home with space"
    bindir = tmp_path / "bin with space" if on_path else home / ".local/bin"
    bindir.mkdir(parents=True)
    cli = bindir / "cursor-agent"
    cli.write_text('#!/bin/bash\nprintf "<%s>\\n" "$@"\nprintf "shell=%s\\n" "$SHELL"\n', encoding="utf-8")
    cli.chmod(0o755)
    script = "__mycmux_cursor() {" + helper + "\n}\n"
    script += f"__MYCMUX_PLATFORM={platform}\nHOME={shlex.quote(home.as_posix())}\n"
    posix_bin = bindir.as_posix()
    if os.name == "nt":
        posix_bin = "/" + posix_bin[0].lower() + posix_bin[2:]
    script += f"PATH={shlex.quote(posix_bin if on_path else '/nonexistent')}\n"
    script += "SHELL=original-shell\n__mycmux_cursor --model composer-2.5 -- 'one prompt'\n"
    result = subprocess.run([bash, "-s"], input=script, capture_output=True, encoding="utf-8", timeout=15)
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == ["<--model>", "<composer-2.5>", "<-->", "<one prompt>", "shell=original-shell"]
