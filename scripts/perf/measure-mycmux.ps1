[CmdletBinding()]
param(
    [string]$RepoRoot = "",
    [Alias("Pid")]
    [int]$TargetPid = 0,
    [string]$ProcessName = "",
    [string]$ExecutablePath = "",
    [ValidateRange(1, 600)]
    [int]$SampleSeconds = 10,
    [switch]$UiProbe,
    [ValidateRange(100, 10000)]
    [int]$UiSettleMs = 900,
    [switch]$ScrollProbe,
    [ValidateRange(1, 600)]
    [int]$ScrollSeconds = 10,
    [ValidateRange(20, 5000)]
    [int]$ScrollIntervalMs = 120,
    [string]$OutputPath = "",
    [switch]$NoOutputFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-RepoRoot {
    param([string]$InputPath)

    if ([string]::IsNullOrWhiteSpace($InputPath)) {
        return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
    }
    return (Resolve-Path -LiteralPath $InputPath).Path
}

function ConvertTo-SlashPath {
    param([string]$PathValue)

    if ([string]::IsNullOrWhiteSpace($PathValue)) {
        return $null
    }
    return $PathValue -replace "\\", "/"
}

function Get-GitInfo {
    param([string]$Root)

    $info = [ordered]@{
        branch = $null
        commit = $null
        status_short = @()
    }

    try {
        $info.branch = (& git -C $Root rev-parse --abbrev-ref HEAD 2>$null)
        $info.commit = (& git -C $Root rev-parse HEAD 2>$null)
        $info.status_short = @(& git -C $Root status --short 2>$null)
    } catch {
        $info["error"] = $_.Exception.Message
    }

    return $info
}

function Get-AppConfig {
    param([string]$Root)

    $configPath = Join-Path $Root "src-tauri\tauri.conf.json"
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    return [ordered]@{
        product_name = [string]$config.productName
        identifier = [string]$config.identifier
        config_path = $configPath
    }
}

function Get-DataJsonCandidates {
    param(
        [string]$Identifier,
        [string]$ProductName
    )

    $candidates = New-Object System.Collections.Generic.List[object]
    foreach ($name in @($Identifier, $ProductName)) {
        if ([string]::IsNullOrWhiteSpace($name)) {
            continue
        }
        $path = Join-Path (Join-Path $env:APPDATA $name) "data.json"
        $candidates.Add([ordered]@{
            path = $path
            exists = (Test-Path -LiteralPath $path)
        })
    }
    return @($candidates.ToArray())
}

function Get-FileSha256 {
    param([string]$PathValue)

    if ([string]::IsNullOrWhiteSpace($PathValue)) {
        return $null
    }
    if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) {
        return $null
    }
    return (Get-FileHash -LiteralPath $PathValue -Algorithm SHA256).Hash
}

function Get-ProcessPathSafe {
    param([System.Diagnostics.Process]$Process)

    try {
        return $Process.Path
    } catch {
        return $null
    }
}

function Resolve-TargetProcess {
    param(
        [int]$RequestedPid,
        [string]$RequestedProcessName,
        [string]$RequestedExecutablePath,
        [string]$DefaultProcessName
    )

    if ($RequestedPid -gt 0) {
        return Get-Process -Id $RequestedPid -ErrorAction Stop
    }

    if (-not [string]::IsNullOrWhiteSpace($RequestedExecutablePath)) {
        $resolvedPath = (Resolve-Path -LiteralPath $RequestedExecutablePath).Path
        $matchedProcesses = Get-Process | Where-Object {
            $path = Get-ProcessPathSafe -Process $_
            $path -and ([string]::Equals($path, $resolvedPath, [System.StringComparison]::OrdinalIgnoreCase))
        } | Sort-Object StartTime -Descending
        if ($matchedProcesses) {
            return $matchedProcesses[0]
        }
        throw "No running process found for executable path: $resolvedPath"
    }

    $name = $RequestedProcessName
    if ([string]::IsNullOrWhiteSpace($name)) {
        $name = $DefaultProcessName
    }
    $name = [System.IO.Path]::GetFileNameWithoutExtension($name)
    $processes = Get-Process -Name $name -ErrorAction SilentlyContinue | Sort-Object StartTime -Descending
    if ($processes) {
        return $processes[0]
    }

    throw "No running process found. Pass -Pid, -ProcessName, or -ExecutablePath."
}

function Get-ProcessSnapshot {
    param([System.Diagnostics.Process]$Process)

    $Process.Refresh()
    $path = Get-ProcessPathSafe -Process $Process
    $startTime = $null
    try {
        $startTime = $Process.StartTime.ToString("o")
    } catch {
        $startTime = $null
    }
    return [ordered]@{
        timestamp = (Get-Date).ToString("o")
        pid = $Process.Id
        process_name = $Process.ProcessName
        path = $path
        sha256 = (Get-FileSha256 -PathValue $path)
        total_processor_seconds = $Process.TotalProcessorTime.TotalSeconds
        working_set_bytes = $Process.WorkingSet64
        private_memory_bytes = $Process.PrivateMemorySize64
        main_window_handle = $Process.MainWindowHandle.ToInt64()
        responding = $Process.Responding
        start_time = $startTime
    }
}

function Measure-ProcessDelta {
    param(
        [System.Diagnostics.Process]$Process,
        [int]$Seconds,
        [string]$Label
    )

    $before = Get-ProcessSnapshot -Process $Process
    $start = Get-Date
    Start-Sleep -Seconds $Seconds
    $end = Get-Date
    $after = Get-ProcessSnapshot -Process $Process
    $elapsed = [Math]::Max(0.001, ($end - $start).TotalSeconds)
    $deltaCpu = [double]$after.total_processor_seconds - [double]$before.total_processor_seconds
    $cpuPctOneCore = ($deltaCpu / $elapsed) * 100.0
    $cpuPctAllCores = $cpuPctOneCore / [Environment]::ProcessorCount

    return [ordered]@{
        label = $Label
        kind = "process_delta"
        duration_seconds = [Math]::Round($elapsed, 3)
        cpu_delta_seconds = [Math]::Round($deltaCpu, 6)
        cpu_percent_one_core = [Math]::Round($cpuPctOneCore, 3)
        cpu_percent_all_cores = [Math]::Round($cpuPctAllCores, 3)
        working_set_delta_bytes = [int64]$after.working_set_bytes - [int64]$before.working_set_bytes
        working_set_before_bytes = $before.working_set_bytes
        working_set_after_bytes = $after.working_set_bytes
        private_memory_before_bytes = $before.private_memory_bytes
        private_memory_after_bytes = $after.private_memory_bytes
        before = $before
        after = $after
    }
}

function Ensure-SendKeys {
    try {
        Add-Type -AssemblyName System.Windows.Forms
    } catch {
        throw "System.Windows.Forms.SendKeys is unavailable: $($_.Exception.Message)"
    }
}

function Invoke-KeySequence {
    param(
        [System.Diagnostics.Process]$Process,
        [string]$Keys
    )

    if ($Process.MainWindowHandle.ToInt64() -eq 0) {
        throw "Target process has no main window handle."
    }
    $shell = New-Object -ComObject WScript.Shell
    $activated = $shell.AppActivate($Process.Id)
    if (-not $activated) {
        throw "Failed to activate target window for pid $($Process.Id)."
    }
    Start-Sleep -Milliseconds 150
    [System.Windows.Forms.SendKeys]::SendWait($Keys)
}

function Measure-KeyProbe {
    param(
        [System.Diagnostics.Process]$Process,
        [string]$Label,
        [string]$Keys,
        [int]$SettleMs
    )

    $before = Get-ProcessSnapshot -Process $Process
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        Invoke-KeySequence -Process $Process -Keys $Keys
        Start-Sleep -Milliseconds $SettleMs
        $timer.Stop()
        $after = Get-ProcessSnapshot -Process $Process
        return [ordered]@{
            label = $Label
            kind = "ui_key_probe"
            status = "ok"
            keys = $Keys
            settle_ms = $SettleMs
            elapsed_ms = [Math]::Round($timer.Elapsed.TotalMilliseconds, 3)
            cpu_delta_seconds = [Math]::Round(([double]$after.total_processor_seconds - [double]$before.total_processor_seconds), 6)
            working_set_delta_bytes = [int64]$after.working_set_bytes - [int64]$before.working_set_bytes
            before = $before
            after = $after
        }
    } catch {
        $timer.Stop()
        return [ordered]@{
            label = $Label
            kind = "ui_key_probe"
            status = "skipped"
            keys = $Keys
            reason = $_.Exception.Message
            before = $before
        }
    }
}

function Measure-ScrollProbe {
    param(
        [System.Diagnostics.Process]$Process,
        [int]$Seconds,
        [int]$IntervalMs
    )

    $before = Get-ProcessSnapshot -Process $Process
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    $sent = 0
    try {
        while ($timer.Elapsed.TotalSeconds -lt $Seconds) {
            Invoke-KeySequence -Process $Process -Keys "{PGDN}"
            $sent += 1
            Start-Sleep -Milliseconds $IntervalMs
        }
        $timer.Stop()
        $after = Get-ProcessSnapshot -Process $Process
        $elapsed = [Math]::Max(0.001, $timer.Elapsed.TotalSeconds)
        $deltaCpu = [double]$after.total_processor_seconds - [double]$before.total_processor_seconds
        return [ordered]@{
            label = "scroll_cpu"
            kind = "scroll_probe"
            status = "ok"
            duration_seconds = [Math]::Round($elapsed, 3)
            key = "PageDown"
            keypresses = $sent
            interval_ms = $IntervalMs
            cpu_delta_seconds = [Math]::Round($deltaCpu, 6)
            cpu_percent_one_core = [Math]::Round(($deltaCpu / $elapsed) * 100.0, 3)
            cpu_percent_all_cores = [Math]::Round((($deltaCpu / $elapsed) * 100.0) / [Environment]::ProcessorCount, 3)
            working_set_delta_bytes = [int64]$after.working_set_bytes - [int64]$before.working_set_bytes
            before = $before
            after = $after
        }
    } catch {
        $timer.Stop()
        return [ordered]@{
            label = "scroll_cpu"
            kind = "scroll_probe"
            status = "skipped"
            reason = $_.Exception.Message
            before = $before
        }
    }
}

$root = Resolve-RepoRoot -InputPath $RepoRoot
$app = Get-AppConfig -Root $root
$process = Resolve-TargetProcess -RequestedPid $TargetPid -RequestedProcessName $ProcessName -RequestedExecutablePath $ExecutablePath -DefaultProcessName $app.product_name

$measurements = New-Object System.Collections.Generic.List[object]
$measurements.Add((Measure-ProcessDelta -Process $process -Seconds $SampleSeconds -Label "cpu_${SampleSeconds}s_increment"))

if ($UiProbe -or $ScrollProbe) {
    Ensure-SendKeys
}

if ($UiProbe) {
    $measurements.Add((Measure-KeyProbe -Process $process -Label "ctrl_p_cold_open" -Keys "^{p}" -SettleMs $UiSettleMs))
    $null = Measure-KeyProbe -Process $process -Label "ctrl_p_close_after_cold" -Keys "{ESC}" -SettleMs 200
    Start-Sleep -Milliseconds 500
    $measurements.Add((Measure-KeyProbe -Process $process -Label "ctrl_p_warm_open" -Keys "^{p}" -SettleMs $UiSettleMs))
    $null = Measure-KeyProbe -Process $process -Label "ctrl_p_close_after_warm" -Keys "{ESC}" -SettleMs 200
}

if ($ScrollProbe) {
    $measurements.Add((Measure-ScrollProbe -Process $process -Seconds $ScrollSeconds -IntervalMs $ScrollIntervalMs))
}

$report = [ordered]@{
    schema_version = 1
    generated_at = (Get-Date).ToString("o")
    repo_root = $root
    repo_git = (Get-GitInfo -Root $root)
    app = $app
    data_json_candidates = @(Get-DataJsonCandidates -Identifier $app.identifier -ProductName $app.product_name)
    target_process = (Get-ProcessSnapshot -Process $process)
    measurements = @($measurements.ToArray())
    notes = @(
        "Default CPU sample is a 10 second TotalProcessorTime delta.",
        "Ctrl+P probes use SendKeys and a fixed settle window; verify visually when recording official before values.",
        "Scroll probe sends PageDown repeatedly to the active window."
    )
}

$json = $report | ConvertTo-Json -Depth 12

if ($NoOutputFile) {
    Write-Output $json
    return
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $safeProduct = ($app.product_name -replace "[^A-Za-z0-9_.-]", "_")
    $OutputPath = Join-Path $PSScriptRoot "results\week1-day1-$safeProduct-$timestamp.json"
}

$outputDir = Split-Path -Parent $OutputPath
if (-not [string]::IsNullOrWhiteSpace($outputDir)) {
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}

Set-Content -LiteralPath $OutputPath -Value $json -Encoding UTF8
Write-Output $json
Write-Host "Wrote performance report: $OutputPath"
