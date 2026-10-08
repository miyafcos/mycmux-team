"""Exercise external-app dispatch without opening apps or using user profiles."""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
LAUNCHER_PS1 = ROOT / "src-tauri/src/launcher.ps1"
LAUNCHER_SH = ROOT / "src-tauri/src/launcher.sh"
OPENED = "Grok Bot \u3092\u958b\u304d\u307e\u3057\u305f (\u4f1a\u8a71\u306f Grok Bot \u306e\u7a93\u3067)"
MISSING = "Grok Bot \u304c\u5165\u3063\u3066\u3044\u307e\u305b\u3093\u3002https://x.ai/bot \u304b\u3089\u5165\u308c\u3066\u304f\u3060\u3055\u3044"


PS_HARNESS = r"""
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$source = Get-Content -LiteralPath $env:GROKBOT_TEST_LAUNCHER -Raw -Encoding UTF8
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$wanted = @("Get-MycmuxGrokBotLaunchPath", "Invoke-MycmuxGrokBot", "Invoke-MycmuxOption")
$functions = $ast.FindAll({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $wanted -contains $node.Name
}, $true)
if ($functions.Count -ne $wanted.Count) { throw "missing Grok Bot functions" }
foreach ($function in $functions) { Invoke-Expression $function.Extent.Text }
$script:Case = ConvertFrom-Json $env:GROKBOT_TEST_CASE
$script:Launches = @(); $script:Messages = @()
function Test-Path {
  param([string]$LiteralPath, [string]$PathType)
  if ($LiteralPath -eq "Registry::HKEY_CURRENT_USER\Software\Classes\grokbot") {
    return [bool]$script:Case.protocol_key
  }
  $exe = Join-Path $env:LOCALAPPDATA "Programs\Grok Bot\Grok Bot.exe"
  if ($LiteralPath -ne $exe -or $PathType -ne "Leaf") { throw "unexpected installation probe" }
  return [bool]$script:Case.exe
}
function Get-ItemProperty {
  param([string]$LiteralPath, [string]$Name, [string]$ErrorAction)
  if ($LiteralPath -ne "Registry::HKEY_CURRENT_USER\Software\Classes\grokbot" -or $Name -ne "URL Protocol") {
    throw "unexpected protocol probe"
  }
  if ($script:Case.protocol_value) { return [pscustomobject]@{ "URL Protocol" = "" } }
  return $null
}
function Start-Process {
  param([string]$FilePath, [string[]]$ArgumentList, [string]$ErrorAction)
  $script:Launches += @{ file = $FilePath; args = @($ArgumentList | Where-Object { $null -ne $_ }) }
  if ($ErrorAction -ne "Stop") { throw "launch errors must be caught" }
  if ($script:Case.fails) { throw "simulated unavailable application" }
}
function Write-Host {
  param([object]$Object)
  $script:Messages += [string]$Object
}
function Clear-Host { throw "the app must not enter the command/PTY route" }
function Read-Host { throw "the app must return without prompting" }
$option = [pscustomobject]@{ Command = @("__app_grokbot__"); RequiredCommand = $null; Label = "probe" }
Invoke-MycmuxOption $option
@{ launches = @($script:Launches); messages = @($script:Messages) } | ConvertTo-Json -Depth 5 -Compress
"""


@pytest.mark.parametrize(
    "protocol_key,protocol_value,exe,fails",
    [
        (False, False, False, False),
        (True, False, False, False),
        (True, True, False, False),
        (True, True, True, False),
        (False, False, True, False),
        (True, True, False, True),
        (False, False, True, True),
    ],
    ids=["missing", "bare-registry-key", "protocol", "protocol-preferred", "exe-only", "stale-protocol", "broken-exe"],
)
def test_powershell_app_dispatch_checks_installation_and_returns_one_line(
    protocol_key: bool, protocol_value: bool, exe: bool, fails: bool,
) -> None:
    powershell = shutil.which("powershell") or shutil.which("pwsh")
    if not powershell:
        pytest.skip("PowerShell is not available")
    case = dict(protocol_key=protocol_key, protocol_value=protocol_value, exe=exe, fails=fails)
    result = subprocess.run(
        [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PS_HARNESS],
        capture_output=True, text=True, encoding="utf-8", timeout=30,
        env={
            "PATH": os.environ.get("PATH", ""),
            "SystemRoot": os.environ.get("SystemRoot", ""),
            "LOCALAPPDATA": r"C:\Grok Bot test data",
            "GROKBOT_TEST_LAUNCHER": str(LAUNCHER_PS1),
            "GROKBOT_TEST_CASE": json.dumps(case),
        },
    )
    assert result.returncode == 0, result.stderr
    assert not result.stderr, result.stderr
    output = json.loads(result.stdout)
    installed = protocol_value or exe
    assert output["messages"] == [OPENED if installed and not fails else MISSING]
    if protocol_value:
        assert output["launches"] == [{"file": "grokbot://", "args": []}]
    elif exe:
        assert output["launches"] == [{
            "file": r"C:\Grok Bot test data\Programs\Grok Bot\Grok Bot.exe",
            "args": ["grokbot://"],
        }]
    else:
        assert output["launches"] == []


def shell_function(name: str) -> str:
    source = LAUNCHER_SH.read_text(encoding="utf-8")
    match = re.search(rf"(?m)^([ \t]*){re.escape(name)}\(\) \{{", source)
    assert match, f"missing function: {name}"
    end = re.search(rf"(?m)^{re.escape(match.group(1))}\}}$", source[match.end():])
    assert end, f"missing function end: {name}"
    return source[match.start():match.end() + end.end()]


def run_shell(script: str) -> subprocess.CompletedProcess[str]:
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash is not available")
    result = subprocess.run(
        [bash, "--noprofile", "--norc", "-s"], input=script,
        capture_output=True, text=True, encoding="utf-8", timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert not result.stderr, result.stderr
    return result


@pytest.mark.parametrize(
    "platform,protocol,exe,launch_status",
    [
        ("macos", False, False, 0),
        ("macos", False, False, 1),
        ("linux", False, False, 0),
        ("linux", False, False, 1),
        ("windows", True, False, 0),
        ("windows", True, False, 1),
        ("windows", False, True, 0),
        ("windows", False, True, 1),
        ("windows", False, False, 0),
        ("other", False, False, 0),
    ],
    ids=["mac-open", "mac-missing", "linux-open", "linux-missing", "windows-protocol",
         "windows-stale-protocol", "windows-exe", "windows-broken-exe", "windows-missing", "unsupported-os"],
)
def test_shell_app_dispatch_uses_platform_opener_and_returns_one_line(
    tmp_path: Path, platform: str, protocol: bool, exe: bool, launch_status: int,
) -> None:
    calls = tmp_path / "calls.txt"
    local_data = tmp_path / "local app data"
    executable = local_data / "Programs/Grok Bot/Grok Bot.exe"
    if exe:
        executable.parent.mkdir(parents=True)
        executable.write_bytes(b"")
    # Windows supplies backslashes; the launcher must normalise them for -f.
    windows_data = local_data.as_posix().replace("/", "\\")
    script = f"""
test_calls={shlex.quote(calls.as_posix())}
LOCALAPPDATA={shlex.quote(windows_data)}
__MYCMUX_PLATFORM={shlex.quote(platform)}
open() {{ printf '%s\\n' open "$@" >> "$test_calls"; return {launch_status}; }}
xdg-open() {{ printf '%s\\n' xdg-open "$@" >> "$test_calls"; return {launch_status}; }}
reg.exe() {{ return {0 if protocol else 1}; }}
cmd.exe() {{ printf '%s\\n' cmd.exe "$@" >> "$test_calls"; return {launch_status}; }}
{shell_function("__open_grokbot_app")}
__open_grokbot_app
"""
    result = run_shell(script)
    can_open = platform in ("macos", "linux") or (platform == "windows" and (protocol or exe))
    assert result.stdout.splitlines() == [OPENED if can_open and launch_status == 0 else MISSING]
    args = calls.read_text(encoding="utf-8").splitlines() if calls.exists() else []
    if platform == "macos":
        assert args == ["open", "-a", "Grok Bot"]
    elif platform == "linux":
        assert args == ["xdg-open", "grokbot://"]
    elif platform == "windows" and protocol:
        assert args == ["cmd.exe", "/c", "start", "", "grokbot://"]
    elif platform == "windows" and exe:
        assert args == ["cmd.exe", "/c", "start", "", executable.as_posix(), "grokbot://"]
    else:
        assert args == []


def test_shell_menu_app_dispatch_returns_without_eval_or_a_web_pane() -> None:
    result = run_shell(
        '__open_grokbot_app() { printf "opened\\n"; }\n'
        'tput() { :; }\n__close_menu_fd() { :; }\n'
        'commands=("__app_grokbot__"); selected=0; __CMUX_MENU_FD=2\n'
        + shell_function("__try_selected_menu_command")
        + '\n__try_selected_menu_command\nprintf "status=%s\\n" "$?"\n'
    )
    assert result.stdout.splitlines() == ["opened", "status=2"]


def test_shell_launch_target_opens_the_app_and_returns_before_the_local_hook() -> None:
    source = LAUNCHER_SH.read_text(encoding="utf-8")
    target = re.search(r'(?ms)^if \[ -n "\$MYCMUX_LAUNCH_TARGET" \]; then.*?^fi$', source)
    assert target, "missing environment dispatch"
    start = source.index('# MYCMUX_LAUNCH_TARGET=web-*')
    end = source.index('\nif [ -n "$cmd" ]; then', start)
    result = run_shell(
        '__open_grokbot_app() { printf "opened\\n"; }\n'
        'MYCMUX_LAUNCH_TARGET=app-grokbot; cmd=""\n'
        + target.group(0) + "\n" + source[start:end]
        + '\nprintf "fell-through-to-command-or-hook\\n"\n'
    )
    assert result.stdout.splitlines() == ["opened"]


def test_powershell_custom_shortcut_is_independent_of_appended_rows() -> None:
    source = LAUNCHER_PS1.read_text(encoding="utf-8")
    arm = re.search(r'if \(\$key.KeyChar -eq "/"\) \{(.*?)\n  \}', source, re.S)
    assert arm, "missing custom shortcut"
    assert '[Array]::IndexOf($Options, $LaunchTargets["custom"])' in arm.group(1)


def test_powershell_file_loading_preserves_japanese_and_returns_to_the_shell(tmp_path: Path) -> None:
    powershell = shutil.which("powershell") or shutil.which("pwsh")
    if not powershell:
        pytest.skip("PowerShell is not available")
    harness = r"""
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function Test-Path { return $false }
. $env:GROKBOT_TEST_LAUNCHER
Write-Output "shell-returned"
"""
    result = subprocess.run(
        [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", harness],
        capture_output=True, text=True, encoding="utf-8", timeout=30,
        env={
            "PATH": os.environ.get("PATH", ""),
            "SystemRoot": os.environ.get("SystemRoot", ""),
            "APPDATA": str(tmp_path),
            "LOCALAPPDATA": str(tmp_path),
            "MYCMUX_RUNTIME_DIR": str(tmp_path),
            "MYCMUX_LAUNCH_TARGET": "app-grokbot",
            "GROKBOT_TEST_LAUNCHER": str(LAUNCHER_PS1),
        },
    )
    assert result.returncode == 0, result.stderr
    assert not result.stderr, result.stderr
    assert result.stdout.splitlines() == [MISSING, "shell-returned"]
