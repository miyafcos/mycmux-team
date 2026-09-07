"""Execute real handoff branches with isolated CLI stubs; no app or agent is started."""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
HANDOFF_KEYS = (
    "MYCMUX_HANDOFF", "MYCMUX_HANDOFF_PROMPT_FILE",
    "MYCMUX_HANDOFF_FROM", "MYCMUX_HANDOFF_FROM_SESSION",
)
PARENT_PATH = "C:/parent/sentinel.md"
CHILD_PATH = "C:/child/spec.md"
KINDS = ("claude", "codex", "claude-codex", "grok", "invalid", "")

OBSERVER = r"""
import json, os, sys
keys = json.loads(os.environ["HANDOFF_TEST_KEYS"])
print(json.dumps({
    "stage": os.environ.get("HANDOFF_TEST_STAGE"),
    "args": json.loads(os.environ["HANDOFF_TEST_ARGS"]) if "HANDOFF_TEST_ARGS" in os.environ else sys.argv[1:],
    "handoff": {k: v for k, v in os.environ.items() if k.upper() in keys},
    "pane": os.environ.get("MYCMUX_PANE_SESSION_ID"),
    "tab": os.environ.get("MYCMUX_TAB_ID"),
    "done": os.environ.get("__CMUX_LAUNCHER_DONE"),
    "keep": os.environ.get("KEEP_SETTING"),
    "error": os.environ.get("HANDOFF_TEST_ERROR"),
}))
"""


def fixture_env(tmp_path: Path, kind: str, fail: bool, mixed_case: bool = False) -> dict[str, str]:
    observer = tmp_path / "observe_handoff.py"
    observer.write_text(OBSERVER, encoding="utf-8")
    assert "\ufffd" not in observer.read_text(encoding="utf-8")
    # Never pass user agent credentials or launcher hooks into the fixture.
    env = {key: os.environ[key] for key in ("PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "PATHEXT") if key in os.environ}
    env.update({
        "PYTHONUTF8": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "HANDOFF_TEST_PYTHON": Path(sys.executable).as_posix(),
        "HANDOFF_TEST_OBSERVER": observer.as_posix(),
        "HANDOFF_TEST_KEYS": json.dumps(HANDOFF_KEYS),
        "HANDOFF_TEST_FAIL": "1" if fail else "0",
        "HANDOFF_TEST_STAGE": "parent",
        "MYCMUX_PANE_SESSION_ID": "pane-preserved",
        "MYCMUX_TAB_ID": "tab-preserved",
        "__CMUX_LAUNCHER_DONE": "1",
        "KEEP_SETTING": "preserved",
    })
    values = (kind, PARENT_PATH, "grok", "parent-sentinel")
    for key, value in zip(HANDOFF_KEYS, values):
        env[key.lower() if mixed_case else key] = value
    return env


def assert_observations(output: str, kind: str, fail: bool) -> None:
    records = [json.loads(line) for line in output.splitlines() if line.strip()]
    parent = [record for record in records if record["stage"] == "parent"]
    child = [record for record in records if record["stage"] == "child"]
    after = [record for record in records if record["stage"] == "after"]
    assert len(parent) == (1 if kind in KINDS[:4] else 0), records
    assert len(child) == 1 and len(after) == 1, records
    if parent:
        assert parent[0]["args"][0] == kind
        assert parent[0]["args"][-1] == f'Handoff from previous session. Read "{PARENT_PATH}" and continue from where it left off.'
    assert child[0]["args"] == [
        "codex", "--no-alt-screen",
        f'Handoff from previous session. Read "{CHILD_PATH}" and continue from where it left off.',
    ]
    for record in records:
        assert record["handoff"] == {}, record
        assert record["pane"] == "pane-preserved", record
        assert record["tab"] == "tab-preserved", record
        assert record["done"] == "1", record
        assert record["keep"] == "preserved", record
    if fail:
        assert after[0]["error"] == "fixture CLI failure"


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("fail", [False, True])
def test_bash_handoff_is_consumed_before_cli_and_retry(tmp_path: Path, kind: str, fail: bool) -> None:
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash is not available")
    source = (ROOT / "src-tauri/src/launcher.sh").read_text(encoding="utf-8")
    start = source.index('\ncmd=""\n', source.index("__ensure_fugu_env()"))
    end = source.index('\nif [ -n "$MYCMUX_RESUME" ]; then', start)
    branch = source[start:end]
    script = r"""
__get_claude_project_dir() { :; }
__stable_new_session_id() { printf 'fixture-session'; }
__grok_new_session_id() { printf 'fixture-grok-session'; }
__write_session_mapping() { :; }
__track_claude_session() { :; }
__track_codex_session() { :; }
__track_claude_codex_session() { :; }
observe() { "$HANDOFF_TEST_PYTHON" "$HANDOFF_TEST_OBSERVER" "$@"; }
agent_stub() {
  observe "$@"
  if [ "$HANDOFF_TEST_FAIL" = 1 ]; then
    export HANDOFF_TEST_ERROR="fixture CLI failure"
    return 7
  fi
}
claude() { agent_stub claude "$@"; }
codex() { agent_stub codex "$@"; }
claude-codex() { agent_stub claude-codex "$@"; }
grok() { agent_stub grok "$@"; }
run_handoff() {
""" + branch + r"""
}
run_handoff
# A second launch in the same host gets a new prompt, not the consumed parent.
export HANDOFF_TEST_STAGE=child
export MYCMUX_HANDOFF=codex
export MYCMUX_HANDOFF_FROM_SESSION=external
export MYCMUX_HANDOFF_PROMPT_FILE=""" + shlex.quote(CHILD_PATH) + r"""
run_handoff
export HANDOFF_TEST_STAGE=after
observe
"""
    result = subprocess.run([bash, "-s"], input=script, text=True, encoding="utf-8",
                            capture_output=True, timeout=30, env=fixture_env(tmp_path, kind, fail))
    assert result.returncode == 0, result.stderr
    assert_observations(result.stdout, kind, fail)


PS_HARNESS = r"""
$ErrorActionPreference = "Stop"
$src = Get-Content -LiteralPath $env:HANDOFF_TEST_LAUNCHER -Raw -Encoding UTF8
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$null, [ref]$parseErrors)
if ($parseErrors.Count) { throw "launcher parse failed: $parseErrors" }
$want = @("Invoke-MycmuxHandoffFromEnv", "Invoke-MycmuxCommandArray")
$fns = $ast.FindAll({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $want -contains $node.Name
}, $true)
if ($fns.Count -ne $want.Count) { throw "missing real launcher functions" }
foreach ($fn in $fns) { Invoke-Expression $fn.Extent.Text }
function Get-MycmuxClaudeProjectDir { return "fixture-project" }
function Get-MycmuxClaudeCodexProjectDir { return "fixture-bridge-project" }
function Get-MycmuxStableSessionId { return "fixture-session" }
function Get-MycmuxGrokSessionId { return "fixture-grok-session" }
function Write-MycmuxSessionMapping {}
function Start-MycmuxSessionTracking {}
function Observe-TestAgent {
  $env:HANDOFF_TEST_ARGS = ConvertTo-Json -InputObject @($args) -Compress
  & $env:HANDOFF_TEST_PYTHON $env:HANDOFF_TEST_OBSERVER
}
function Invoke-TestAgent {
  Observe-TestAgent @args
  if ($env:HANDOFF_TEST_FAIL -eq "1") { throw "fixture CLI failure" }
}
function claude { Invoke-TestAgent "claude" @args }
function codex { Invoke-TestAgent "codex" @args }
function claude-codex { Invoke-TestAgent "claude-codex" @args }
function grok { Invoke-TestAgent "grok" @args }
try { Invoke-MycmuxHandoffFromEnv | Where-Object { $_ -isnot [bool] } } catch { $env:HANDOFF_TEST_ERROR = $_.Exception.Message }
$env:HANDOFF_TEST_STAGE = "child"
$env:MYCMUX_HANDOFF = "codex"
$env:MYCMUX_HANDOFF_FROM_SESSION = "external"
$env:MYCMUX_HANDOFF_PROMPT_FILE = "C:/child/spec.md"
try { Invoke-MycmuxHandoffFromEnv | Where-Object { $_ -isnot [bool] } } catch { $env:HANDOFF_TEST_ERROR = $_.Exception.Message }
$env:HANDOFF_TEST_STAGE = "after"
Observe-TestAgent
"""


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("fail", [False, True])
@pytest.mark.parametrize("mixed_case", [False, True])
def test_powershell_handoff_is_consumed_before_cli_and_retry(
    tmp_path: Path, kind: str, fail: bool, mixed_case: bool,
) -> None:
    shell = shutil.which("powershell") or shutil.which("pwsh")
    if not shell:
        pytest.skip("PowerShell is not available")
    if mixed_case and os.name != "nt":
        pytest.skip("case-insensitive Env: aliases are a Windows contract")
    env = fixture_env(tmp_path, kind, fail, mixed_case)
    env["HANDOFF_TEST_LAUNCHER"] = str(ROOT / "src-tauri/src/launcher.ps1")
    encoded = base64.b64encode(PS_HARNESS.encode("utf-16le")).decode("ascii")
    result = subprocess.run(
        [shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        text=True, encoding="utf-8", capture_output=True, timeout=30, env=env,
    )
    assert result.returncode == 0, result.stderr
    assert_observations(result.stdout, kind, fail)
