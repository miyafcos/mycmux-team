"""Run both bundled launchers with isolated homes; no live mycmux or agents."""
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


@pytest.fixture(params=["bash", "powershell"])
def engine(request: pytest.FixtureRequest) -> str:
    return str(request.param)


def run_launcher(tmp_path: Path, engine: str, command: str | None, target: str = "shell", *, twice: bool = False) -> subprocess.CompletedProcess[str]:
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith(("MYCMUX_", "ORCA_"))}
    isolated_home = tmp_path / "home"
    isolated_home.mkdir(exist_ok=True)
    env.update(HOME=str(isolated_home), USERPROFILE=str(isolated_home), APPDATA=str(isolated_home / "AppData"),
               MYCMUX_LAUNCH_TARGET=target, MYCMUX_RUNTIME_DIR=str(tmp_path / "runtime"), MYCMUX_DISPATCH_GUARD="off")
    if command is not None:
        env["MYCMUX_LAUNCH_COMMAND"] = command
    if engine == "bash":
        bash = Path(r"C:\Program Files\Git\bin\bash.exe") if os.name == "nt" else Path(shutil.which("bash") or "missing")
        if not bash.is_file():
            pytest.skip("bash unavailable")
        source = ROOT / "src-tauri/src/launcher.sh"
        env["TERMINAL_LAUNCHER"] = str(source).replace("\\", "/")
        env["TERMINAL_PYTHON"] = str(Path(sys.executable)).replace("\\", "/")
        script = '. "$TERMINAL_LAUNCHER"\n'
        if twice:
            script += 'MYCMUX_LAUNCH_TARGET=shell; . "$TERMINAL_LAUNCHER"\n'
        script += "declare -F claude codex claude-codex grok >/dev/null || exit 91\n"
        script += '[ -z "${MYCMUX_LAUNCH_COMMAND+x}" ] || exit 92\n'
        script += "printf '%s\\n' SHELL_ALIVE\n"
        args = [str(bash), "--noprofile", "--norc", "-c", script]
    else:
        powershell = shutil.which("powershell") or shutil.which("pwsh")
        if not powershell:
            pytest.skip("PowerShell unavailable")
        env["TERMINAL_LAUNCHER"] = str(ROOT / "src-tauri/src/launcher.ps1")
        env["TERMINAL_PYTHON"] = sys.executable
        script = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n. $env:TERMINAL_LAUNCHER\n"
        if twice:
            script += "$env:MYCMUX_LAUNCH_TARGET='shell'; . $env:TERMINAL_LAUNCHER\n"
        script += "foreach ($name in @('claude','codex','claude-codex','grok')) { if ((Get-Command $name).CommandType -ne 'Function') { exit 91 } }\n"
        script += "if (Test-Path Env:MYCMUX_LAUNCH_COMMAND) { exit 92 }; Write-Output SHELL_ALIVE\n"
        args = [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]
    result = subprocess.run(args, env=env, cwd=tmp_path, capture_output=True, text=True, encoding="utf-8", timeout=30)
    assert result.returncode == 0, (result.returncode, result.stdout, result.stderr)
    assert "SHELL_ALIVE" in result.stdout
    assert "Launch:" not in result.stdout
    assert not (isolated_home / ".mycmux").exists()
    return result


def test_shell_target_returns_with_integration_functions(tmp_path: Path, engine: str) -> None:
    result = run_launcher(tmp_path, engine, None)
    assert result.stdout.strip() == "SHELL_ALIVE"


def test_command_is_verbatim_once_and_shell_remains_alive(tmp_path: Path, engine: str) -> None:
    expected = ' spaces "double" $dollar ; pipe| \u65e5\u672c\u8a9e '
    if engine == "bash":
        command = f"value={shlex.quote(expected)}; printf '%s\\n' \"$value\" | cat"
    else:
        command = f"$value='{expected}'; $value | ForEach-Object {{ [Console]::WriteLine($_) }}"
    result = run_launcher(tmp_path, engine, command, twice=True)
    assert result.stdout.splitlines() == [expected, "SHELL_ALIVE"]


def test_payload_env_is_absent_in_command_and_external_child(tmp_path: Path, engine: str) -> None:
    probe = "import os; assert 'MYCMUX_LAUNCH_COMMAND' not in os.environ; print('CHILD_CLEAN')"
    if engine == "bash":
        command = '[ -z "${MYCMUX_LAUNCH_COMMAND+x}" ] || exit 94; "$TERMINAL_PYTHON" -c ' + shlex.quote(probe)
    else:
        command = "if (Test-Path Env:MYCMUX_LAUNCH_COMMAND) { exit 94 }; & $env:TERMINAL_PYTHON -c \"" + probe + "\""
    result = run_launcher(tmp_path, engine, command)
    assert result.stdout.splitlines() == ["CHILD_CLEAN", "SHELL_ALIVE"]


def test_command_resolves_the_integrated_claude_function(tmp_path: Path, engine: str) -> None:
    if engine == "bash":
        command = "__mycmux_with_hook_cap() { printf 'WRAPPED:%s:%s:%s\\n' \"$1\" \"$3\" \"$4\"; }; claude --model 'space $ ; | \u65e5\u672c\u8a9e'"
    else:
        command = "function global:Invoke-MycmuxAgentWithHook { param($Provider,$Executable,$AgentArgs); [Console]::WriteLine(('WRAPPED:{0}:{1}:{2}' -f $Provider,$AgentArgs[0],$AgentArgs[1])) }; claude --model 'space $ ; | \u65e5\u672c\u8a9e'"
    result = run_launcher(tmp_path, engine, command)
    assert result.stdout.splitlines() == ["WRAPPED:claude:--model:space $ ; | \u65e5\u672c\u8a9e", "SHELL_ALIVE"]


@pytest.mark.parametrize("command", ["echo INVALID\necho SECOND", "echo INVALID\recho SECOND", "echo\tINVALID", "echo \x1bINVALID", "echo \x85INVALID", "echo \u2028INVALID", "echo \u2029INVALID", "x" * 4097, "\U0001f600" * 2049])
def test_invalid_lines_are_rejected_without_execution(tmp_path: Path, engine: str, command: str) -> None:
    result = run_launcher(tmp_path, engine, command)
    assert "Terminal command must be one line" in result.stdout + result.stderr
    assert "INVALID" not in result.stdout + result.stderr


def test_command_failure_does_not_close_shell(tmp_path: Path, engine: str) -> None:
    result = run_launcher(tmp_path, engine, "false" if engine == "bash" else "throw 'probe failure'")
    assert "SHELL_ALIVE" in result.stdout


def test_unknown_target_is_rejected_without_menu(tmp_path: Path, engine: str) -> None:
    result = run_launcher(tmp_path, engine, None, target="shell;echo INVALID")
    assert "Invalid launcher target" in result.stdout + result.stderr
    assert "INVALID" not in result.stdout + result.stderr


def test_shell_dispatch_precedes_resume_and_does_not_log_command() -> None:
    sh = (ROOT / "src-tauri/src/launcher.sh").read_text(encoding="utf-8")
    ps = (ROOT / "src-tauri/src/launcher.ps1").read_text(encoding="utf-8")
    assert sh.index('if [ "${MYCMUX_LAUNCH_TARGET:-}" = shell ]') < sh.index('if [ -n "$MYCMUX_RESUME" ]')
    assert ps.index("if ($env:MYCMUX_LAUNCH_TARGET -eq 'shell')") < ps.index("if (Invoke-MycmuxResumeFromEnv)")
    ipc = (ROOT / "src/lib/ipc.ts").read_text(encoding="utf-8")
    assert ipc.count("env: takeTerminalCommandEnv(env) ?? null") == 2
    rust = (ROOT / "src-tauri/src/commands/terminal.rs").read_text(encoding="utf-8")
    assert "validate_terminal_shell_launch(&mut env_map)?;" in rust
    assert 'format!("target={target} command={command} args={args:?}")' in rust
