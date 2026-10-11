"""Run actual Codex restore branches with fixtures; never launch a real agent."""
from __future__ import annotations

import json
import os
import shutil
import sys
import re
from unittest.mock import patch
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REQUIRE_PS51 = os.environ.get("MYCMUX_REQUIRE_PS51") == "1" or "--require-powershell-51" in sys.argv


def powershell_executable(required: bool = False) -> str | None:
    override = os.environ.get("TEST_POWERSHELL_EXECUTABLE")
    executable = (override if override and Path(override).is_file() else None) if override is not None else (shutil.which("powershell") or shutil.which("pwsh"))
    if not executable:
        if required: raise RuntimeError("Windows PowerShell 5.1 is required for acceptance; unavailable")
        return None
    if required:
        result = subprocess.run([executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], text=True, capture_output=True, encoding="utf-8", timeout=15)
        if result.returncode != 0 or not re.search(r"(?m)^5\.1(?:\.|$)", result.stdout.strip()):
            raise RuntimeError("Windows PowerShell 5.1 is required for acceptance; wrong version: " + result.stdout.strip())
    return executable

SID = "11111111-2222-7333-8444-555555555555"
PTY = "aaaaaaaa-1111-4222-8333-444444444444"
TAB = "bbbbbbbb-1111-4222-8333-444444444444"
NOTICE = "Previous conversation could not be restored; starting a new session."
GENERATION = "cccccccc-1111-4222-8333-444444444444"
CASES = ("exact", "missing", "malformed", "failed", "fresh-failed", "normal-completed", "native-nonzero", "native-126", "native-127", "validation-failed", "report-unavailable", "report-fault-missing", "report-fault-malformed", "report-fault-validation")
FINAL_REPORT_FAULTS = ("final-report-resume-0", "final-report-resume-7", "final-report-fresh-0", "final-report-fresh-7")


def assert_result(case: str, result: subprocess.CompletedProcess[str], directory: Path) -> None:
    assert result.returncode == 0, result.stdout + result.stderr
    calls = directory / "calls.jsonl"
    attempts = [json.loads(line) for line in calls.read_text(encoding="utf-8").splitlines()] if calls.exists() else []
    if case in FINAL_REPORT_FAULTS:
        fresh = "fresh" in case
        assert attempts == ([["--no-alt-screen"]] if fresh else [["resume", "--no-alt-screen", SID]]), attempts
        assert result.stdout.count(NOTICE) == int(fresh), result.stdout
        assert result.stdout.count("Codex restore outcome could not be recorded; returning to the shell.") == 1, result.stdout
        assert (directory / "preflight-ok").exists(), "the fault must occur after successful preflight"
        assert (directory / "clean-env").exists(), "the CLI must actually have started"
        assert (directory / "pane-sessions" / f"{PTY}.codex-restore.json").is_dir()
        return
    fallback = case in ("missing", "malformed", "failed", "fresh-failed", "validation-failed")
    expected = [["resume", "--no-alt-screen", SID]] if not fallback else [["--no-alt-screen"]]
    if case == "failed": expected.insert(0, ["resume", "--no-alt-screen", SID])
    if case == "report-unavailable" or case.startswith("report-fault-"):
        assert attempts == ([["resume", "--no-alt-screen", SID]] if case == "report-unavailable" else []), attempts
        assert NOTICE not in result.stdout, result.stdout
        assert "restore outcome could not be recorded; returning to the shell" in result.stdout, result.stdout
        assert (directory / "pane-sessions" / f"{PTY}.codex-restore.json").is_dir()
        for identifier in (PTY, TAB):
            assert not (directory / "pane-sessions" / f"{identifier}.txt").exists()
        return
    assert attempts == expected, (case, attempts, result.stdout, result.stderr)
    assert result.stdout.count(NOTICE) == int(fallback), (case, result.stdout)
    assert "--last" not in str(attempts)
    report_path = directory / "pane-sessions" / f"{PTY}.codex-restore.json"
    assert report_path.is_file(), "Codex restore outcome was not recorded after actual invocation"
    report = json.loads(report_path.read_text(encoding="utf-8-sig"))
    outcome = "fresh-failed" if case == "fresh-failed" else "fresh-completed" if fallback else "exited" if case.startswith("native-") else "completed"
    reason = {"missing": "missing-id", "malformed": "malformed-id", "failed": "spawn-failed", "fresh-failed": "missing-id", "validation-failed": "validation-failed"}.get(case, "cli-exit")
    assert report == {"generation": GENERATION, "tab_id": TAB, "outcome": outcome, "reason": reason}, report
    for identifier in (PTY, TAB):
        assert (directory / "pane-sessions" / f"{identifier}.txt").exists() != fallback, case
    assert (directory / "clean-env").exists(), "resume intent reached a CLI"
    if case == "fresh-failed" or case.startswith("native-"):
        assert "returning to the shell" in result.stdout, result.stdout


def fixture_env(directory: Path, case: str) -> dict[str, str]:
    base_case = {"report-fault-missing": "missing", "report-fault-malformed": "malformed", "report-fault-validation": "validation-failed",
                 "final-report-fresh-0": "missing", "final-report-fresh-7": "missing"}.get(case, case)
    (directory / "pane-sessions").mkdir(exist_ok=True)
    for identifier in (PTY, TAB):
        (directory / "pane-sessions" / f"{identifier}.txt").write_text(f"codex:{SID}\n", encoding="utf-8")
    env = {key: os.environ[key] for key in ("PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "PATHEXT") if key in os.environ}
    env.update(MYCMUX_RUNTIME_DIR=str(directory), MYCMUX_PANE_SESSION_ID=PTY, MYCMUX_TAB_ID=TAB,
               MYCMUX_CODEX_RESTORE_GENERATION=GENERATION,
               MYCMUX_RESUME="codex", MYCMUX_AGENT_KIND="codex", MYCMUX_RESUME_FORK="0",
               MYCMUX_LAUNCH_KIND="resume", MYCMUX_LAUNCH_TARGET="codex",
               MYCMUX_SESSION_ID="" if base_case in ("missing", "fresh-failed") else "invalid;prompt" if base_case == "malformed" else SID,
               TEST_CASE=case, TEST_DIR=str(directory))
    if case == "report-unavailable" or case.startswith("report-fault-"):
        (directory / "pane-sessions" / f"{PTY}.codex-restore.json").mkdir()
    if case in FINAL_REPORT_FAULTS:
        report = directory / "pane-sessions" / f"{PTY}.codex-restore.json"
        report.write_text("preflight probe", encoding="utf-8")
        report.unlink()
        (directory / "preflight-ok").touch()
    if base_case == "validation-failed":
        env["MYCMUX_CODEX_RESTORE_REASON"] = "validation-failed"
        env.pop("MYCMUX_RESUME")
    return env


def run_base_bash(case: str, source: str) -> str:
    """Bind the same expectations to the actual base automatic branch."""
    start = source.index('if [ -n "$MYCMUX_RESUME" ]; then')
    end = source.index('\n# Web ', start)
    with tempfile.TemporaryDirectory(prefix="codex-base-bash-") as temporary:
        directory = Path(temporary)
        env = fixture_env(directory, case)
        # These keys do not exist in the base protocol; do not invent a red by
        # injecting later-generation report intent into its command invoker.
        env.pop("MYCMUX_CODEX_RESTORE_GENERATION", None)
        env.pop("MYCMUX_CODEX_RESTORE_REASON", None)
        env["MYCMUX_RESUME"] = "codex"
        script = r'''
__write_session_mapping() { :; }
__track_codex_session() { :; }
prompt() { :; }
codex() {
  local line='[' separator='' argument
  for argument in "$@"; do line="$line$separator\"$argument\""; separator=','; done
  printf '%s]\n' "$line" >> "$TEST_DIR/calls.jsonl"
  return 0
}
__fixture_source_launcher() {
''' + source[start:end] + "\n}\n__fixture_source_launcher\n"
        result = subprocess.run([shutil.which("bash") or "/bin/bash", "-s"], input=script,
                                env=env, text=True, capture_output=True, encoding="utf-8", timeout=15)
        assert_result(case, result, directory)
        return result.stdout


def run_bash(case: str, source_override: str | None = None) -> str:
    source = source_override or (ROOT / "src-tauri/src/launcher.sh").read_text(encoding="utf-8")
    if "# BEGIN CODEX RESTORE HELPERS" not in source:
        return run_base_bash(case, source)
    helpers = source.split("# BEGIN CODEX RESTORE HELPERS", 1)[1].split("# END CODEX RESTORE HELPERS", 1)[0]
    start = source.index('if [ -n "${MYCMUX_CODEX_RESTORE_REASON:-}" ]; then')
    end = source.index('\n# Web ', start)
    with tempfile.TemporaryDirectory(prefix="codex-restore-bash-") as temporary:
        directory = Path(temporary)
        executable = directory / "codex"
        executable.write_text('''#!/bin/bash
for key in MYCMUX_RESUME MYCMUX_SESSION_ID MYCMUX_AGENT_KIND MYCMUX_RESUME_FORK MYCMUX_CODEX_RESTORE_REASON MYCMUX_CODEX_RESTORE_GENERATION; do
  [ -z "${!key}" ] || exit 91
done
[ -z "${MYCMUX_LAUNCH_TARGET:-}" ] || exit 92
if [ "$1" = resume ]; then expected_kind=resume; else expected_kind=new; fi
[ "$MYCMUX_LAUNCH_KIND" = "$expected_kind" ] || exit 93
touch "$TEST_DIR/clean-env"
case "$TEST_CASE" in final-report-*)
  rm -f "$TEST_DIR/pane-sessions/$MYCMUX_PANE_SESSION_ID.codex-restore.json"
  mkdir "$TEST_DIR/pane-sessions/$MYCMUX_PANE_SESSION_ID.codex-restore.json"
  case "$TEST_CASE" in *-7) exit 7;; esac
  ;; esac
case "$TEST_CASE" in fresh-failed|native-nonzero) exit 7;; native-126) exit 126;; native-127) exit 127;; esac
exit 0
''', encoding="utf-8")
        executable.chmod(0o755)
        script = helpers.replace('__mycmux_codex_restore_invoke() {', '__product_codex_restore_invoke() {').replace('__mycmux_codex_restore_report() {', '__product_codex_restore_report() {') + r'''
__mycmux_is_windows_shell() { return 1; }
__write_session_mapping() { printf 'codex:%s\n' "$3" > "$TEST_DIR/pane-sessions/$MYCMUX_TAB_ID.txt"; }
__track_codex_session() { :; }
__mycmux_codex_restore_invoke() {
  local line='[' separator='' argument
  shift
  for argument in "$@"; do line="$line$separator\"$argument\""; separator=','; done
  printf '%s]\n' "$line" >> "$TEST_DIR/calls.jsonl"
  if [[ "$TEST_CASE" = failed || "$TEST_CASE" = report-unavailable ]] && [ ! -f "$TEST_DIR/retried" ]; then
    touch "$TEST_DIR/retried"
    mv "$TEST_DIR/codex" "$TEST_DIR/codex.disabled"
  fi
  __product_codex_restore_invoke codex "$@"
}
__mycmux_codex_restore_report() {
  __product_codex_restore_report "$@"
  if [[ "$TEST_CASE" = failed || "$TEST_CASE" = report-unavailable ]] && [ "$1" = downgrade ]; then mv "$TEST_DIR/codex.disabled" "$TEST_DIR/codex"; fi
}
''' + '\n__fixture_source_launcher() {\n' + source[start:end] + r'''
}
__fixture_source_launcher
touch "$TEST_DIR/caller-returned"
for key in MYCMUX_RESUME MYCMUX_SESSION_ID MYCMUX_AGENT_KIND MYCMUX_RESUME_FORK MYCMUX_CODEX_RESTORE_REASON MYCMUX_CODEX_RESTORE_GENERATION MYCMUX_LAUNCH_KIND MYCMUX_LAUNCH_TARGET __MYCMUX_PENDING_LAUNCH_KIND; do
  [ -z "${!key}" ] || exit 94
done
# A second harmless command observes the caller shell after the sourced branch.
__fixture_manual_command() {
  for key in MYCMUX_RESUME MYCMUX_SESSION_ID MYCMUX_CODEX_RESTORE_REASON MYCMUX_CODEX_RESTORE_GENERATION MYCMUX_LAUNCH_KIND MYCMUX_LAUNCH_TARGET __MYCMUX_PENDING_LAUNCH_KIND; do
    [ -z "${!key}" ] || return 95
  done
  touch "$TEST_DIR/manual-command-clean"
}
__fixture_manual_command || exit 95
'''
        env = fixture_env(directory, case)
        for name in ("mkdir", "mv", "rm", "touch"):
            target = shutil.which(name)
            assert target, name
            (directory / name).symlink_to(target)
        # Never fall through to a real installed Codex when testing preflight.
        env["PATH"] = str(directory)
        result = subprocess.run([shutil.which("bash") or "/bin/bash", "-s"], input=script, env=env, text=True, capture_output=True, encoding="utf-8", timeout=15)
        assert (directory / "caller-returned").exists(), "launcher exited instead of returning to the caller"
        assert (directory / "manual-command-clean").exists(), result.stdout + result.stderr + " caller cleanup checks did not complete"
        assert_result(case, result, directory)
        return result.stdout


def run_powershell(case: str, executable: str) -> None:
    with tempfile.TemporaryDirectory(prefix="codex-restore-ps-") as temporary:
        directory = Path(temporary)
        script = r'''
$ErrorActionPreference = 'Continue'
$source = Get-Content -LiteralPath $env:TEST_LAUNCHER -Raw -Encoding UTF8
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$null, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$names = @('Write-MycmuxCodexRestoreReport', 'Remove-MycmuxCodexRestoreMapping', 'Invoke-MycmuxCodexRestoreCommand', 'Invoke-MycmuxCodexRestore', 'Invoke-MycmuxResumeFromEnv')
foreach ($name in $names) {
  $function = $ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
  if ($function.Count -ne 1) { throw "missing helper $name" }
  Invoke-Expression $function[0].Extent.Text
}
function Write-MycmuxSessionMapping { param($PaneId, $Kind, $Id) [IO.File]::WriteAllText((Join-Path $env:TEST_DIR "pane-sessions\$env:MYCMUX_TAB_ID.txt"), "codex:$Id") }
function Start-MycmuxSessionTracking { }
function Invoke-MycmuxCommandArray {
  param([string[]]$Command)
  $line = ConvertTo-Json -InputObject @($Command[1..($Command.Count-1)]) -Compress
  [IO.File]::AppendAllText((Join-Path $env:TEST_DIR 'calls.jsonl'), "$line`n")
  if ($env:TEST_CASE -in @('failed', 'report-unavailable') -and -not $script:retried) {
    $script:retried = $true
    throw (New-Object System.Management.Automation.CommandNotFoundException('fixture invocation failure'))
  }
  foreach ($key in @('MYCMUX_RESUME', 'MYCMUX_SESSION_ID', 'MYCMUX_AGENT_KIND', 'MYCMUX_RESUME_FORK', 'MYCMUX_CODEX_RESTORE_REASON', 'MYCMUX_CODEX_RESTORE_GENERATION')) {
    if (Test-Path "Env:\$key") { throw "resume intent leaked: $key" }
  }
  if (Test-Path Env:\MYCMUX_LAUNCH_TARGET) { throw 'launch target leaked' }
  $expectedKind = if ($Command[1] -eq 'resume') { 'resume' } else { 'new' }
  if ($env:MYCMUX_LAUNCH_KIND -ne $expectedKind) { throw 'launch kind missing' }
  [IO.File]::WriteAllText((Join-Path $env:TEST_DIR 'clean-env'), 'ok')
  if ($env:TEST_CASE -like 'final-report-*') {
    $report = Join-Path $env:TEST_DIR "pane-sessions\$env:MYCMUX_PANE_SESSION_ID.codex-restore.json"
    Remove-Item -LiteralPath $report -Force -ErrorAction SilentlyContinue
    [IO.Directory]::CreateDirectory($report) | Out-Null
  }
  $global:LASTEXITCODE = switch ($env:TEST_CASE) { 'fresh-failed' {7}; 'native-nonzero' {7}; 'native-126' {126}; 'native-127' {127}; default {0} }
  if ($env:TEST_CASE -like 'final-report-*-7') { $global:LASTEXITCODE = 7 }
}
Invoke-MycmuxResumeFromEnv | Out-Null
foreach ($key in @('MYCMUX_RESUME', 'MYCMUX_SESSION_ID', 'MYCMUX_AGENT_KIND', 'MYCMUX_RESUME_FORK', 'MYCMUX_CODEX_RESTORE_REASON', 'MYCMUX_CODEX_RESTORE_GENERATION', 'MYCMUX_LAUNCH_KIND', 'MYCMUX_LAUNCH_TARGET')) {
  if (Test-Path "Env:\$key") { throw "launch intent survived: $key" }
}
if ($script:MycmuxPendingLaunchKind) { throw 'pending kind survived' }
'''
        env = fixture_env(directory, case)
        env["TEST_LAUNCHER"] = os.environ.get("TEST_LAUNCHER_PATH", str(ROOT / "src-tauri/src/launcher.ps1"))
        result = subprocess.run([executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], env=env, text=True, capture_output=True, encoding="utf-8", timeout=30)
        assert_result(case, result, directory)


REAL_CASES = ("missing-executable", "invocation-failed", "native-7", "native-126", "native-127")


def run_powershell_real_invoker(case: str, executable: str) -> None:
    with tempfile.TemporaryDirectory(prefix="codex-real-invoker-") as temporary:
        directory = Path(temporary)
        native = directory / "benign-native.cmd"
        native.write_text("""@echo off
for %%K in (MYCMUX_RESUME MYCMUX_SESSION_ID MYCMUX_AGENT_KIND MYCMUX_RESUME_FORK MYCMUX_CODEX_RESTORE_REASON MYCMUX_CODEX_RESTORE_GENERATION MYCMUX_LAUNCH_TARGET) do if defined %%K exit /b 91
if "%~1"=="resume" (
  if not "%MYCMUX_LAUNCH_KIND%"=="resume" exit /b 92
  echo resume>>"%TEST_DIR%\\native-calls.txt"
) else (
  if not "%MYCMUX_LAUNCH_KIND%"=="new" exit /b 93
  echo fresh>>"%TEST_DIR%\\native-calls.txt"
)
echo clean>"%TEST_DIR%\\clean-env"
exit /b %TEST_NATIVE_CODE%
""", encoding="ascii")
        invalid = directory / "invalid-executable.exe"
        invalid.write_bytes(b"benign fixture, intentionally not a PE executable")
        env = fixture_env(directory, "exact")
        env.update(TEST_CASE=case, TEST_NATIVE_CODE=case.split("-")[-1] if case.startswith("native-") else "0",
                   TEST_NATIVE=str(native), TEST_INVALID=str(invalid),
                   TEST_LAUNCHER=os.environ.get("TEST_LAUNCHER_PATH", str(ROOT / "src-tauri/src/launcher.ps1")))
        # These five cases watch actual invocation classification, not the
        # newer report protocol. B3 already passed them on Windows PS 5.1;
        # do not manufacture a red by passing its helper a later env key.
        if "MYCMUX_CODEX_RESTORE_GENERATION" not in Path(env["TEST_LAUNCHER"]).read_text(encoding="utf-8-sig"):
            env.pop("MYCMUX_CODEX_RESTORE_GENERATION", None)
        script = r"""
$ErrorActionPreference = 'Continue'
$source = Get-Content -LiteralPath $env:TEST_LAUNCHER -Raw -Encoding UTF8
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$null, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Invoke-MycmuxCommandArray', 'Write-MycmuxCodexRestoreReport', 'Remove-MycmuxCodexRestoreMapping', 'Invoke-MycmuxCodexRestoreCommand', 'Invoke-MycmuxCodexRestore')) {
  $function = $ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
  if ($function.Count -ne 1) { throw "missing helper $name" }
  Invoke-Expression $function[0].Extent.Text
}
# The product command invoker is loaded above, without a substitute.
function Write-MycmuxSessionMapping { param($PaneId, $Kind, $Id) [IO.File]::WriteAllText((Join-Path $env:TEST_DIR "pane-sessions\$env:MYCMUX_TAB_ID.txt"), "codex:$Id") }
function Start-MycmuxSessionTracking { }
$resumeExe = if ($env:TEST_CASE -eq 'missing-executable') { Join-Path $env:TEST_DIR 'absent-fixture.exe' } elseif ($env:TEST_CASE -eq 'invocation-failed') { $env:TEST_INVALID } else { $env:TEST_NATIVE }
Invoke-MycmuxCodexRestore -ResumeCommand @($resumeExe, 'resume', '--no-alt-screen', $env:MYCMUX_SESSION_ID) -FreshCommand @($env:TEST_NATIVE, '--no-alt-screen')
if ($ErrorActionPreference -ne 'Continue') { throw 'caller error policy changed' }
foreach ($key in @('MYCMUX_RESUME', 'MYCMUX_SESSION_ID', 'MYCMUX_AGENT_KIND', 'MYCMUX_RESUME_FORK', 'MYCMUX_CODEX_RESTORE_REASON', 'MYCMUX_CODEX_RESTORE_GENERATION', 'MYCMUX_LAUNCH_KIND', 'MYCMUX_LAUNCH_TARGET')) {
  if (Test-Path "Env:\$key") { throw "intent survived: $key" }
}
if ($script:MycmuxPendingLaunchKind) { throw 'pending kind survived' }
[IO.File]::WriteAllText((Join-Path $env:TEST_DIR 'caller-returned'), 'ok')
"""
        result = subprocess.run([executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], env=env, text=True, capture_output=True, encoding="utf-8", timeout=30)
        assert result.returncode == 0, result.stdout + result.stderr
        assert (directory / "caller-returned").exists(), result.stdout + result.stderr
        assert (directory / "clean-env").exists(), "intent reached the real command invoker"
        fallback = not case.startswith("native-")
        calls = (directory / "native-calls.txt").read_text(encoding="utf-8").splitlines()
        assert calls == (["fresh"] if fallback else ["resume"]), (case, calls, result.stdout, result.stderr)
        assert result.stdout.count(NOTICE) == int(fallback), result.stdout
        report = json.loads((directory / "pane-sessions" / f"{PTY}.codex-restore.json").read_text(encoding="utf-8-sig"))
        assert {key: value for key, value in report.items() if key != "generation"} == {"tab_id": TAB, "outcome": "fresh-completed" if fallback else "exited", "reason": "spawn-failed" if fallback else "cli-exit"}, report
        if "MYCMUX_CODEX_RESTORE_GENERATION" in env: assert report.get("generation") == GENERATION
        for identifier in (PTY, TAB):
            assert (directory / "pane-sessions" / f"{identifier}.txt").exists() != fallback


class CodexRestoreRuntimeTests(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "Bash fixture is exercised on Mac/Linux")
    def test_r7_6_bash_final_reports_fail_after_preflight_and_invocation(self) -> None:
        for case in FINAL_REPORT_FAULTS:
            with self.subTest(case=case): run_bash(case)

    def test_r7_6_powershell_final_reports_fail_after_preflight_and_invocation(self) -> None:
        executable = powershell_executable(REQUIRE_PS51)
        if not executable: self.skipTest("PowerShell is unavailable on this seat; commander runs 5.1")
        for case in FINAL_REPORT_FAULTS:
            with self.subTest(case=case): run_powershell(case, executable)
    @unittest.skipUnless(shutil.which("bash") and os.name != "nt", "Bash fixture filesystem test runs on Mac/Linux; Windows uses PowerShell")
    def test_bash_restore_cases(self) -> None:
        for case in CASES:
            with self.subTest(case=case): run_bash(case)

    @unittest.skipUnless(shutil.which("bash") and os.name != "nt", "Bash required")
    def test_bash_caller_checks_detect_removed_product_cleanup(self) -> None:
        source = (ROOT / "src-tauri/src/launcher.sh").read_text(encoding="utf-8")
        mutant = source.replace("unset __MYCMUX_PENDING_LAUNCH_KIND", ": # removed cleanup")
        with self.assertRaises(AssertionError):
            run_bash("exact", mutant)

    def test_mandatory_acceptance_rejects_missing_and_wrong_powershell(self) -> None:
        with patch.dict(os.environ, {"TEST_POWERSHELL_EXECUTABLE": "__absent_fixture__"}):
            with self.assertRaisesRegex(RuntimeError, "required.*unavailable"):
                powershell_executable(required=True)
        with patch.dict(os.environ, {"TEST_POWERSHELL_EXECUTABLE": sys.executable}), patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, "7.4.0\n", "")):
            with self.assertRaisesRegex(RuntimeError, "wrong version"):
                powershell_executable(required=True)

    def test_powershell_restore_cases(self) -> None:
        executable = powershell_executable(REQUIRE_PS51)
        if not executable: self.skipTest("PowerShell unavailable (optional Mac/Linux run)")
        assert executable
        for case in CASES:
            with self.subTest(case=case): run_powershell(case, executable)

    def test_powershell_real_command_invoker(self) -> None:
        """Real-invoker guards; B3 already passes these cases on PS 5.1.26100.9444."""
        executable = powershell_executable(REQUIRE_PS51)
        if not executable: self.skipTest("PowerShell unavailable (optional Mac/Linux run)")
        assert executable
        if os.name != "nt": self.skipTest("Windows native invocation fixtures require Windows")
        for case in REAL_CASES:
            with self.subTest(case=case): run_powershell_real_invoker(case, executable)


if __name__ == "__main__":
    if "--require-powershell-51" in sys.argv: sys.argv.remove("--require-powershell-51")
    unittest.main(verbosity=2)
