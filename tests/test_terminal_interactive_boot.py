"""Exercise the actual frontend shell argv, not just sourcing the launch script."""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]
PROFILE = "terminal-integration"


def visible_output_lines(output: str) -> list[str]:
    return re.sub(r"\x1b\]7;[^\x07\x1b]*(?:\x07|\x1b\\)", "", output).splitlines()


@pytest.mark.parametrize("terminator", ["\x07", "\x1b\\"])
def test_visible_output_lines_preserves_exact_markers(terminator: str) -> None:
    output = "\x1b]7;file://fixture/path" + terminator + "WRAPPER_COUNT:4\nSTATE:kept\n"
    assert visible_output_lines(output) == ["WRAPPER_COUNT:4", "STATE:kept"]
    assert visible_output_lines("WRAPPER_COUNT:3\n") == ["WRAPPER_COUNT:3"]


NODE_PLAN = r"""
const fs = require('node:fs');
const root = process.env.TERMINAL_REPO;
const ts = require(root + '/node_modules/typescript');
const source = fs.readFileSync(root + '/src/lib/agents.ts', 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
const api = {};
const imports = name => {
  if (name === './ipc') return { getDefaultShell: async () => ({ command: process.env.TERMINAL_SHELL, args: [] }) };
  if (name === '@tauri-apps/api/core') return { invoke: async () => 'terminal-integration' };
  throw new Error('Unexpected import: ' + name);
};
new Function('require', 'exports', js)(imports, api);
api.initDefaultShell().then(() => {
  const agent = api.getDefaultAgent(true);
  process.stdout.write(JSON.stringify({ command: agent.command, args: agent.args }));
});
"""


@pytest.mark.parametrize("shell", ["powershell.exe", "cmd.exe", "/bin/zsh", "/bin/bash"])
def test_terminal_startup_keeps_wrappers_state_and_clears_payload(tmp_path: Path, shell: str) -> None:
    if shell.endswith(".exe") and os.name != "nt":
        pytest.skip("Windows shell path")
    node = shutil.which("node")
    if not node:
        pytest.skip("node unavailable")
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith(("MYCMUX_", "ORCA_"))}
    env.update(TERMINAL_REPO=str(ROOT), TERMINAL_SHELL=shell)
    result = subprocess.run([node, "-e", NODE_PLAN], env=env, capture_output=True, text=True, encoding="utf-8", timeout=30)
    assert result.returncode == 0, result.stderr
    plan = json.loads(result.stdout)
    home = tmp_path / "home"
    bin_dir = home / f".mycmux-{PROFILE}" / "bin"
    bin_dir.mkdir(parents=True)
    for suffix in ["sh", "ps1"]:
        (bin_dir / f"launcher.{suffix}").write_bytes((ROOT / f"src-tauri/src/launcher.{suffix}").read_bytes())
    env.update(HOME=str(home), USERPROFILE=str(home), MYCMUX_RUNTIME_DIR=str(bin_dir.parent),
               MYCMUX_LAUNCH_TARGET="shell", MYCMUX_DISPATCH_GUARD="off", __CMUX_LAUNCHER_DONE="1")
    if shell.endswith(".exe"):
        executable = shutil.which(plan["command"])
        if not executable:
            pytest.skip("PowerShell unavailable")
        env["MYCMUX_LAUNCH_COMMAND"] = "$terminal_state = 'kept'; [Console]::WriteLine('BOOT_RAN')"
        followup = "\n".join([
            "[Console]::WriteLine('STATE:' + $terminal_state)",
            "foreach ($name in @('claude','codex','claude-codex','grok')) { if ((Get-Command $name).CommandType -ne 'Function') { exit 91 } }",
            "[Console]::WriteLine('WRAPPERS_OK')",
            "[Console]::WriteLine('COMMAND_ENV:' + [bool](Test-Path Env:MYCMUX_LAUNCH_COMMAND))",
            "exit", "",
        ])
    else:
        executable = str(Path(r"C:\Program Files\Git\bin\bash.exe")) if os.name == "nt" else shutil.which("bash")
        if not executable or not Path(executable).is_file():
            pytest.skip("bash unavailable")
        env["MYCMUX_LAUNCH_COMMAND"] = "terminal_state=kept; printf '%s\\n' BOOT_RAN"
        followup = "\n".join([
            "printf 'STATE:%s\\n' \"$terminal_state\"",
            "declare -F claude codex claude-codex grok >/dev/null || exit 91; printf '%s\\n' WRAPPERS_OK",
            "[ -z \"${MYCMUX_LAUNCH_COMMAND+x}\" ] || exit 92; printf '%s\\n' COMMAND_ENV:False",
            "exit", "",
        ])
    assert env["MYCMUX_LAUNCH_COMMAND"] not in json.dumps(plan)
    result = subprocess.run([executable, *plan["args"]], env=env, cwd=tmp_path, input=followup,
                            capture_output=True, text=True, encoding="utf-8", timeout=30)
    assert result.returncode == 0, (result.returncode, result.stdout, result.stderr)
    lines = visible_output_lines(result.stdout)
    assert lines.count("BOOT_RAN") == 1, (result.stdout, result.stderr)
    for expected in ["STATE:kept", "WRAPPERS_OK", "COMMAND_ENV:False"]:
        assert expected in lines, (result.stdout, result.stderr)
    assert "Launch:" not in result.stdout



@pytest.fixture(scope="module")
def restored_terminal_plans(tmp_path_factory: pytest.TempPathFactory) -> list[dict]:
    node = shutil.which("node")
    if not node:
        pytest.skip("node unavailable")
    output = tmp_path_factory.mktemp("restored-shell-plans") / "plans.json"
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith(("MYCMUX_", "ORCA_"))}
    home = output.parent / "home"
    home.mkdir()
    env.update(HOME=str(home), USERPROFILE=str(home), TERMINAL_RESTORE_PLAN_PATH=str(output))
    if os.name == "nt":
        env["PATH"] = r"C:\Program Files\Git\usr\bin" + os.pathsep + env.get("PATH", "")
    command = [node, str(ROOT / "node_modules/vitest/vitest.mjs"), "run",
               "tests/unit/terminalShellRestore.test.ts", "-t", "exports persisted terminal restore plans",
               "--maxWorkers=1", "--no-file-parallelism"]
    result = subprocess.run(command, env=env, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert result.returncode == 0, (result.stdout, result.stderr)
    plans = json.loads(output.read_text(encoding="utf-8"))
    assert len(plans) == 8
    return plans


@pytest.mark.parametrize("shell", ["powershell.exe", "/bin/bash"])
@pytest.mark.parametrize("kind", ["claude", "codex", "claude-codex", "grok"])
def test_restored_terminal_keeps_all_wrapper_functions(
    tmp_path: Path, restored_terminal_plans: list[dict], shell: str, kind: str,
) -> None:
    if shell.endswith(".exe") and os.name != "nt":
        pytest.skip("Windows shell path")
    plan = next(plan for plan in restored_terminal_plans if plan["shell"] == shell and plan["kind"] == kind)
    home = tmp_path / "home"
    bin_dir = home / f".mycmux-{PROFILE}" / "bin"
    bin_dir.mkdir(parents=True)
    for suffix in ["sh", "ps1"]:
        (bin_dir / f"launcher.{suffix}").write_bytes((ROOT / f"src-tauri/src/launcher.{suffix}").read_bytes())
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith(("MYCMUX_", "ORCA_"))}
    env.update(HOME=str(home), USERPROFILE=str(home), APPDATA=str(home / "AppData"),
               MYCMUX_RUNTIME_DIR=str(bin_dir.parent), MYCMUX_DISPATCH_GUARD="off")
    env.update(plan["env"])
    if os.name == "nt":
        env["PATH"] = r"C:\Program Files\Git\usr\bin" + os.pathsep + env.get("PATH", "")
    for key in ["MYCMUX_RESUME", "MYCMUX_SESSION_ID", "MYCMUX_LAUNCH_COMMAND"]:
        assert key not in plan["env"]
    if shell.endswith(".exe"):
        executable = shutil.which(plan["command"])
        if not executable:
            pytest.skip("PowerShell unavailable")
        followup = "\n".join([
            "[Console]::WriteLine('WRAPPER_COUNT:' + @(Get-Command claude,codex,claude-codex,grok -CommandType Function -ErrorAction SilentlyContinue).Count)",
            "if (Test-Path Env:MYCMUX_LAUNCH_COMMAND) { exit 92 }",
            "if (Test-Path Env:MYCMUX_LAUNCH_TARGET) { exit 93 }",
            "[Console]::WriteLine('RESTORED_SHELL_ALIVE')", "exit", "",
        ])
    else:
        executable = str(Path(r"C:\Program Files\Git\bin\bash.exe")) if os.name == "nt" else shutil.which("bash")
        if not executable or not Path(executable).is_file():
            pytest.skip("bash unavailable")
        followup = "\n".join([
            "wrapper_count=$(declare -F claude codex claude-codex grok | wc -l); printf 'WRAPPER_COUNT:%s\\n' \"$wrapper_count\"",
            "[ -z \"${MYCMUX_LAUNCH_COMMAND+x}\" ] || exit 92",
            "[ -z \"${MYCMUX_LAUNCH_TARGET+x}\" ] || exit 93",
            "printf '%s\\n' RESTORED_SHELL_ALIVE", "exit", "",
        ])
    result = subprocess.run([executable, *plan["args"]], env=env, cwd=tmp_path, input=followup,
                            capture_output=True, text=True, encoding="utf-8", timeout=30)
    assert result.returncode == 0, (result.returncode, result.stdout, result.stderr)
    lines = visible_output_lines(result.stdout)
    assert "WRAPPER_COUNT:4" in lines, (result.stdout, result.stderr)
    assert "RESTORED_SHELL_ALIVE" in lines, (result.stdout, result.stderr)
    assert "ParserError" not in result.stderr and "syntax error" not in result.stderr
    assert "Launch:" not in result.stdout
    assert "ONE_SHOT_MUST_NOT_REPLAY" not in result.stdout + result.stderr
    assert "INITIAL_PROMPT_MUST_NOT_REPLAY" not in result.stdout + result.stderr
    assert not (home / ".mycmux").exists()
