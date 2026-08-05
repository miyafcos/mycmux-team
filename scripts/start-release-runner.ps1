# Start the self-hosted GitHub Actions runner with a sanitized environment.
#
# Why this script exists (each item caused a real CI failure or leak):
#   1. BASH_FUNC_* exported by the mycmux launcher breaks every bash step
#      ("syntax error: unexpected end of file", run 29433650693).
#   2. PATH without Git\bin resolves bash to the WindowsApps WSL stub and the
#      job dies with "no installed distributions" (v0.19.0 attempt 1).
#   3. Secrets living in the user environment (FUGU_API_KEY, tokens) are
#      inherited by the runner and end up verbatim in build logs whenever a
#      step dumps its environment (observed in run 30975163089).
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\start-release-runner.ps1

$ErrorActionPreference = "Stop"

$runnerDir = Join-Path $env:USERPROFILE "actions-runner-mycmux"
$runCmd = Join-Path $runnerDir "run.cmd"
if (-not (Test-Path $runCmd)) {
    Write-Error "runner not found: $runCmd"
    exit 1
}

if (Get-Process Runner.Listener -ErrorAction SilentlyContinue) {
    Write-Host "runner is already running - nothing to do"
    exit 0
}

# Strip launcher/agent state and machine-local secrets from this process before
# the runner inherits it. Add new secret-bearing variables to this list.
$stripPrefixes = @("BASH_FUNC_", "MYCMUX_", "CLAUDE")
$stripExact = @(
    "__CMUX_LAUNCHER_DONE",
    "FUGU_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY"
)
$stripped = @()
foreach ($entry in Get-ChildItem Env:) {
    $name = $entry.Name
    $matchesPrefix = $false
    foreach ($prefix in $stripPrefixes) {
        if ($name -like "$prefix*") { $matchesPrefix = $true; break }
    }
    if ($matchesPrefix -or ($stripExact -contains $name)) {
        [Environment]::SetEnvironmentVariable($name, $null, "Process")
        $stripped += $name
    }
}
Write-Host ("stripped {0} env vars: {1}" -f $stripped.Count, ($stripped -join ", "))

# Ensure bash resolves to Git bash, not the WindowsApps WSL stub.
$env:Path = "C:\Program Files\Git\bin;C:\Program Files\Git\usr\bin;" + $env:Path
$bash = (Get-Command bash -ErrorAction SilentlyContinue).Source
Write-Host "bash resolves to: $bash"
if ($bash -notlike "*Git*") {
    Write-Error "bash does not resolve to Git bash - aborting"
    exit 1
}

Start-Process -FilePath $runCmd -WorkingDirectory $runnerDir -WindowStyle Minimized
Start-Sleep -Seconds 12
$listener = Get-Process Runner.Listener -ErrorAction SilentlyContinue
if ($listener) {
    Write-Host "runner started: PID $($listener.Id)"
} else {
    Write-Error "runner did not start (Runner.Listener not found after 12s)"
    exit 1
}
