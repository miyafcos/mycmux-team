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
    "MYCMUX_HANDOFF_LAUNCH_KIND",
)
PARENT_PATH = "C:/parent/with space/sentinel.md"
CHILD_PATH = "C:/child/with space/spec.md"
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
    "launch_kind": os.environ.get("HANDOFF_TEST_LAUNCH_KIND"),
}))
"""


def fixture_env(tmp_path: Path, kind: str, fail: bool, mixed_case: bool = False,
                launch_spec: bool = False, launch_mode: str = "handoff") -> dict[str, str]:
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
        "HANDOFF_TEST_MODEL": "model-x" if launch_spec else "",
        "HANDOFF_TEST_EFFORT": "high" if launch_spec else "",
    })
    values = (kind, PARENT_PATH, "grok", "parent-sentinel")
    for key, value in zip(HANDOFF_KEYS, values):
        env[key.lower() if mixed_case else key] = value
    if launch_mode == "prompt":
        env["MYCMUX_HANDOFF_LAUNCH_KIND"] = "new"
    return env


def assert_observations(output: str, kind: str, fail: bool, launch_spec: bool = False,
                        launch_mode: str = "handoff") -> None:
    records = [json.loads(line) for line in output.splitlines() if line.strip()]
    parent = [record for record in records if record["stage"] == "parent"]
    child = [record for record in records if record["stage"] == "child"]
    after = [record for record in records if record["stage"] == "after"]
    assert len(parent) == (1 if kind in KINDS[:4] else 0), records
    assert len(child) == 1 and len(after) == 1, records
    if parent:
        assert parent[0]["launch_kind"] == ("new" if launch_mode == "prompt" else "handoff")
        assert parent[0]["args"][0] == kind
        assert parent[0]["args"][-1] == f'Handoff from previous session. Read "{PARENT_PATH}" and continue from where it left off.'
        if launch_spec:
            expected_effort = ("-c", "model_reasoning_effort=high") if kind == "codex" else (
                ("--reasoning-effort", "high") if kind == "grok" else ("--effort", "high")
            )
            assert parent[0]["args"][1:5] == ["--model", "model-x", *expected_effort]
    assert child[0]["args"] == [
        "codex", "--no-alt-screen",
        f'Handoff from previous session. Read "{CHILD_PATH}" and continue from where it left off.',
    ]
    assert child[0]["launch_kind"] == "new"
    assert after[0]["launch_kind"] is None
    for record in records:
        assert record["handoff"] == {}, record
        assert record["pane"] == "pane-preserved", record
        assert record["tab"] == "tab-preserved", record
        assert record["done"] == "1", record
        assert record["keep"] == "preserved", record
    if fail:
        assert after[0]["error"] == "fixture CLI failure"


@pytest.mark.parametrize(("kind", "launch_spec"),
                         [(kind, False) for kind in KINDS] + [(kind, True) for kind in KINDS[:4]])
@pytest.mark.parametrize("fail", [False, True])
@pytest.mark.parametrize("launch_mode", ["handoff", "prompt"])
def test_bash_handoff_is_consumed_before_cli_and_retry(tmp_path: Path, kind: str, fail: bool,
                                                       launch_spec: bool, launch_mode: str) -> None:
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash is not available")
    source = (ROOT / "src-tauri/src/launcher.sh").read_text(encoding="utf-8")
    start = source.index('\ncmd=""\n', source.index("__ensure_fugu_env()"))
    end = source.index('\nif [ -n "$MYCMUX_RESUME" ]; then', start)
    branch = source[start:end]
    helper_start = source.index("\n__handoff_with_launch_spec() {")
    helper_end = source.index("\n__read_launch_spec_from_env", helper_start)
    helper = source[helper_start:helper_end]
    script = helper + r"""
__MYCMUX_LAUNCH_MODEL="$HANDOFF_TEST_MODEL"
__MYCMUX_LAUNCH_EFFORT="$HANDOFF_TEST_EFFORT"
__get_claude_project_dir() { :; }
__stable_new_session_id() { printf 'fixture-session'; }
__grok_new_session_id() { printf 'fixture-grok-session'; }
__write_session_mapping() { :; }
__track_claude_session() { :; }
__track_codex_session() { :; }
__track_claude_codex_session() { :; }
observe() { "$HANDOFF_TEST_PYTHON" "$HANDOFF_TEST_OBSERVER" "$@"; }
agent_stub() {
  export HANDOFF_TEST_LAUNCH_KIND="${__MYCMUX_PENDING_LAUNCH_KIND:-}"
  unset __MYCMUX_PENDING_LAUNCH_KIND
  observe "$@"
  unset HANDOFF_TEST_LAUNCH_KIND
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
__MYCMUX_LAUNCH_MODEL=""
__MYCMUX_LAUNCH_EFFORT=""
export HANDOFF_TEST_STAGE=child
export MYCMUX_HANDOFF=codex
export MYCMUX_HANDOFF_FROM_SESSION=external
export MYCMUX_HANDOFF_LAUNCH_KIND=new
export MYCMUX_HANDOFF_PROMPT_FILE=""" + shlex.quote(CHILD_PATH) + r"""
run_handoff
export HANDOFF_TEST_STAGE=after
observe
"""
    result = subprocess.run([bash, "-s"], input=script, text=True, encoding="utf-8",
                            capture_output=True, timeout=30, env=fixture_env(tmp_path, kind, fail, launch_spec=launch_spec, launch_mode=launch_mode))
    assert result.returncode == 0, result.stderr
    assert_observations(result.stdout, kind, fail, launch_spec, launch_mode)


PS_HARNESS = r"""
$ErrorActionPreference = "Stop"
$src = Get-Content -LiteralPath $env:HANDOFF_TEST_LAUNCHER -Raw -Encoding UTF8
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$null, [ref]$parseErrors)
if ($parseErrors.Count) { throw "launcher parse failed: $parseErrors" }
$want = @("Invoke-MycmuxHandoffFromEnv", "Invoke-MycmuxCommandArray", "Add-MycmuxLaunchSpecToCommandArray", "Get-MycmuxCommandLeaf")
$fns = $ast.FindAll({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $want -contains $node.Name
}, $true)
if ($fns.Count -ne $want.Count) { throw "missing real launcher functions" }
foreach ($fn in $fns) { Invoke-Expression $fn.Extent.Text }
$script:MycmuxLaunchModel = $env:HANDOFF_TEST_MODEL
$script:MycmuxLaunchEffort = $env:HANDOFF_TEST_EFFORT
function Get-MycmuxClaudeProjectDir { return "fixture-project" }
function Get-MycmuxClaudeCodexProjectDir { return "fixture-bridge-project" }
function Get-MycmuxStableSessionId { return "fixture-session" }
function Get-MycmuxGrokSessionId { return "fixture-grok-session" }
function Write-MycmuxSessionMapping {}
function Start-MycmuxSessionTracking {}
function Observe-TestAgent {
  $env:HANDOFF_TEST_LAUNCH_KIND = $script:MycmuxPendingLaunchKind
  $script:MycmuxPendingLaunchKind = $null
  $env:HANDOFF_TEST_ARGS = ConvertTo-Json -InputObject @($args) -Compress
  & $env:HANDOFF_TEST_PYTHON $env:HANDOFF_TEST_OBSERVER
  Remove-Item Env:\HANDOFF_TEST_LAUNCH_KIND -ErrorAction SilentlyContinue
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
$script:MycmuxLaunchModel = ""
$script:MycmuxLaunchEffort = ""
$env:HANDOFF_TEST_STAGE = "child"
$env:MYCMUX_HANDOFF = "codex"
$env:MYCMUX_HANDOFF_FROM_SESSION = "external"
$env:MYCMUX_HANDOFF_LAUNCH_KIND = "new"
$env:MYCMUX_HANDOFF_PROMPT_FILE = "C:/child/with space/spec.md"
try { Invoke-MycmuxHandoffFromEnv | Where-Object { $_ -isnot [bool] } } catch { $env:HANDOFF_TEST_ERROR = $_.Exception.Message }
$env:HANDOFF_TEST_STAGE = "after"
Observe-TestAgent
"""


@pytest.mark.parametrize(("kind", "launch_spec"),
                         [(kind, False) for kind in KINDS] + [(kind, True) for kind in KINDS[:4]])
@pytest.mark.parametrize("fail", [False, True])
@pytest.mark.parametrize("mixed_case", [False, True])
@pytest.mark.parametrize("launch_mode", ["handoff", "prompt"])
def test_powershell_handoff_is_consumed_before_cli_and_retry(
    tmp_path: Path, kind: str, fail: bool, mixed_case: bool, launch_spec: bool, launch_mode: str,
) -> None:
    shell = shutil.which("powershell") or shutil.which("pwsh")
    if not shell:
        pytest.skip("PowerShell is not available")
    if mixed_case and os.name != "nt":
        pytest.skip("case-insensitive Env: aliases are a Windows contract")
    env = fixture_env(tmp_path, kind, fail, mixed_case, launch_spec, launch_mode)
    env["HANDOFF_TEST_LAUNCHER"] = str(ROOT / "src-tauri/src/launcher.ps1")
    encoded = base64.b64encode(PS_HARNESS.encode("utf-16le")).decode("ascii")
    result = subprocess.run(
        [shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        text=True, encoding="utf-8", capture_output=True, timeout=30, env=env,
    )
    assert result.returncode == 0, result.stderr
    assert_observations(result.stdout, kind, fail, launch_spec, launch_mode)
