<#
.SYNOPSIS
Samples CPU usage for the WebView2 GPU process owned by a running mycmux.

.DESCRIPTION
The default run records 60 one-second samples and writes a CSV plus a JSON
summary under scripts\perf\results. CPU percentages are reported both as a
single-core percentage and as the all-logical-core percentage shown by Task
Manager.

Paint counters are exposed only by a development build. Start mycmux in dev
mode, open DevTools Console, and verify
typeof window.__mycmuxPaintStats === "function" before measuring. For each
state, run window.__mycmuxPaintStatsReset(), start this script, then run
window.__mycmuxPaintStats() after it completes. Save that snapshot together
with the CSV and summary paths.

Capture three separate 60-second runs. For streaming, keep PTY output flowing
throughout the run. For idle, stop output and wait for pending writes to settle
before resetting the counters. For unfocused, reset first, focus another app,
and launch this script from an external PowerShell window.

.EXAMPLE
.\scripts\perf\measure-paint-stats.ps1 -StateLabel streaming

.EXAMPLE
.\scripts\perf\measure-paint-stats.ps1 -StateLabel idle

.EXAMPLE
.\scripts\perf\measure-paint-stats.ps1 -StateLabel unfocused
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = "",
    [Alias("Pid")]
    [int]$TargetPid = 0,
    [ValidateRange(1, 600)]
    [int]$SampleSeconds = 60,
    [ValidateRange(100, 10000)]
    [int]$SampleIntervalMs = 1000,
    [Parameter(Mandatory = $true)]
    [ValidateSet("streaming", "idle", "unfocused", "doctor")]
    [string]$StateLabel,
    [string]$OutputPath = "",
    [string]$SummaryPath = ""
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

function Resolve-MycmuxProcess {
    param([int]$RequestedPid)

    if ($RequestedPid -gt 0) {
        $requested = Get-Process -Id $RequestedPid -ErrorAction Stop
        if ($requested.ProcessName -ne "mycmux") {
            throw "PID $RequestedPid is $($requested.ProcessName), not mycmux."
        }
        return $requested
    }

    $running = @(Get-Process -Name "mycmux" -ErrorAction SilentlyContinue)
    if ($running.Count -eq 0) {
        throw "No running mycmux process was found."
    }
    if ($running.Count -gt 1) {
        $ids = ($running | Sort-Object Id | ForEach-Object { $_.Id }) -join ", "
        throw "Multiple mycmux processes are running ($ids). Pass -Pid to select one."
    }
    return $running[0]
}

function Get-DescendantProcessIds {
    param(
        [int]$RootPid,
        [object[]]$ProcessTable
    )

    $descendants = New-Object "System.Collections.Generic.HashSet[int]"
    $queue = New-Object "System.Collections.Generic.Queue[int]"
    $queue.Enqueue($RootPid)
    while ($queue.Count -gt 0) {
        $parentPid = $queue.Dequeue()
        foreach ($process in $ProcessTable) {
            if ([int]$process.ParentProcessId -ne $parentPid) {
                continue
            }
            $childPid = [int]$process.ProcessId
            if ($descendants.Add($childPid)) {
                $queue.Enqueue($childPid)
            }
        }
    }
    return @($descendants)
}

function Resolve-WebViewGpuProcess {
    param(
        [int]$MycmuxPid,
        [object[]]$ProcessTable
    )

    $descendantIds = @(Get-DescendantProcessIds -RootPid $MycmuxPid -ProcessTable $ProcessTable)
    $gpuCandidates = @($ProcessTable | Where-Object {
        $_.Name -eq "msedgewebview2.exe" -and
        $descendantIds -contains [int]$_.ProcessId -and
        $_.CommandLine -match "(?:^|\s)--type=gpu-process(?:\s|$)"
    })

    if ($gpuCandidates.Count -eq 0) {
        throw "No WebView2 gpu-process descendant was found for mycmux PID $MycmuxPid."
    }
    if ($gpuCandidates.Count -gt 1) {
        $ids = ($gpuCandidates | Sort-Object ProcessId | ForEach-Object { $_.ProcessId }) -join ", "
        throw "Multiple WebView2 gpu-process descendants were found ($ids)."
    }
    return Get-Process -Id ([int]$gpuCandidates[0].ProcessId) -ErrorAction Stop
}

function Resolve-ResultPath {
    param(
        [string]$RequestedPath,
        [string]$DefaultPath,
        [string]$Root
    )

    $path = if ([string]::IsNullOrWhiteSpace($RequestedPath)) { $DefaultPath } else { $RequestedPath }
    if (-not [System.IO.Path]::IsPathRooted($path)) {
        $path = Join-Path $Root $path
    }
    return [System.IO.Path]::GetFullPath($path)
}

function Measure-GpuCpu {
    param(
        [System.Diagnostics.Process]$GpuProcess,
        [int]$MycmuxPid,
        [int]$DurationSeconds,
        [int]$IntervalMs
    )

    $samples = New-Object System.Collections.Generic.List[object]
    $durationMs = $DurationSeconds * 1000
    $sampleCount = [int][Math]::Ceiling($durationMs / [double]$IntervalMs)
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $GpuProcess.Refresh()
    $previousCpuSeconds = $GpuProcess.TotalProcessorTime.TotalSeconds
    $previousElapsedSeconds = 0.0

    for ($index = 1; $index -le $sampleCount; $index += 1) {
        $targetMs = [Math]::Min($durationMs, $index * $IntervalMs)
        $remainingMs = $targetMs - $clock.Elapsed.TotalMilliseconds
        if ($remainingMs -gt 0) {
            Start-Sleep -Milliseconds ([int][Math]::Ceiling($remainingMs))
        }

        $GpuProcess.Refresh()
        if ($GpuProcess.HasExited) {
            throw "WebView2 gpu-process PID $($GpuProcess.Id) exited during sampling."
        }
        $elapsedSeconds = $clock.Elapsed.TotalSeconds
        $cpuSeconds = $GpuProcess.TotalProcessorTime.TotalSeconds
        $intervalSeconds = [Math]::Max(0.001, $elapsedSeconds - $previousElapsedSeconds)
        $cpuDeltaSeconds = [Math]::Max(0.0, $cpuSeconds - $previousCpuSeconds)
        $cpuPercentOneCore = ($cpuDeltaSeconds / $intervalSeconds) * 100.0
        $cpuPercentAllCores = $cpuPercentOneCore / [Environment]::ProcessorCount

        $samples.Add([pscustomobject][ordered]@{
            sample_index = $index
            timestamp = (Get-Date).ToString("o")
            elapsed_seconds = [Math]::Round($elapsedSeconds, 3)
            interval_seconds = [Math]::Round($intervalSeconds, 3)
            mycmux_pid = $MycmuxPid
            gpu_pid = $GpuProcess.Id
            cpu_delta_seconds = [Math]::Round($cpuDeltaSeconds, 6)
            cpu_percent_one_core = [Math]::Round($cpuPercentOneCore, 3)
            cpu_percent_all_cores = [Math]::Round($cpuPercentAllCores, 3)
            working_set_bytes = $GpuProcess.WorkingSet64
            private_memory_bytes = $GpuProcess.PrivateMemorySize64
        })

        $previousCpuSeconds = $cpuSeconds
        $previousElapsedSeconds = $elapsedSeconds
    }
    $clock.Stop()
    return @($samples.ToArray())
}

$root = Resolve-RepoRoot -InputPath $RepoRoot
$mycmuxProcess = Resolve-MycmuxProcess -RequestedPid $TargetPid
$processTable = @(Get-CimInstance Win32_Process | Select-Object Name, ProcessId, ParentProcessId, CommandLine)
$gpuProcess = Resolve-WebViewGpuProcess -MycmuxPid $mycmuxProcess.Id -ProcessTable $processTable

$safeLabel = $StateLabel
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$resultsDir = Join-Path $root "scripts\perf\results"
$defaultCsvPath = Join-Path $resultsDir "paint-stats-$safeLabel-$stamp.csv"
$csvPath = Resolve-ResultPath -RequestedPath $OutputPath -DefaultPath $defaultCsvPath -Root $root
$defaultSummaryPath = [System.IO.Path]::ChangeExtension($csvPath, ".summary.json")
$jsonPath = Resolve-ResultPath -RequestedPath $SummaryPath -DefaultPath $defaultSummaryPath -Root $root

foreach ($directory in @([System.IO.Path]::GetDirectoryName($csvPath), [System.IO.Path]::GetDirectoryName($jsonPath))) {
    if (-not [string]::IsNullOrWhiteSpace($directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
}

Write-Host "Sampling WebView2 GPU PID $($gpuProcess.Id) for mycmux PID $($mycmuxProcess.Id)..."
$samples = @(Measure-GpuCpu -GpuProcess $gpuProcess -MycmuxPid $mycmuxProcess.Id -DurationSeconds $SampleSeconds -IntervalMs $SampleIntervalMs)
$samples | Export-Csv -LiteralPath $csvPath -NoTypeInformation -Encoding UTF8

$actualDuration = [double]$samples[-1].elapsed_seconds
$totalCpuDelta = [double](($samples | Measure-Object -Property cpu_delta_seconds -Sum).Sum)
$avgOneCore = ($totalCpuDelta / [Math]::Max(0.001, $actualDuration)) * 100.0
$avgAllCores = $avgOneCore / [Environment]::ProcessorCount
$maxOneCore = [double](($samples | Measure-Object -Property cpu_percent_one_core -Maximum).Maximum)
$maxAllCores = [double](($samples | Measure-Object -Property cpu_percent_all_cores -Maximum).Maximum)

$summary = [ordered]@{
    status = "ok"
    generated_at = (Get-Date).ToString("o")
    state_label = $StateLabel
    sample_count = $samples.Count
    requested_duration_seconds = $SampleSeconds
    actual_duration_seconds = [Math]::Round($actualDuration, 3)
    sample_interval_ms = $SampleIntervalMs
    logical_processor_count = [Environment]::ProcessorCount
    mycmux_pid = $mycmuxProcess.Id
    gpu_pid = $gpuProcess.Id
    avg_cpu_percent_one_core = [Math]::Round($avgOneCore, 3)
    max_cpu_percent_one_core = [Math]::Round($maxOneCore, 3)
    avg_cpu_percent_all_cores = [Math]::Round($avgAllCores, 3)
    max_cpu_percent_all_cores = [Math]::Round($maxAllCores, 3)
    csv_path = $csvPath
}
$summary | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $jsonPath -Encoding UTF8

Write-Host "CSV: $csvPath"
Write-Host "Summary: $jsonPath"
Write-Host "CPU all cores avg/max: $($summary.avg_cpu_percent_all_cores)% / $($summary.max_cpu_percent_all_cores)%"
