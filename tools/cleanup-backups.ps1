# cleanup-backups.ps1 — Trim accumulated mycmux exe backups
#
# build-personal.ps1 / build-lite.ps1 each rename the existing exe to a
# timestamped `.bak-YYYYMMDD-HHmmss` file before copying the new build into
# place. After many iterations these backups can take hundreds of MB.
#
# This script keeps the most recent N backups (default 3) per app directory
# and removes the rest. Pass -DryRun to preview without deleting.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\cleanup-backups.ps1
#   powershell -ExecutionPolicy Bypass -File tools\cleanup-backups.ps1 -KeepLast 5 -DryRun
#
# Targets (both apps unless -Target is specified):
#   personal: C:\Users\miyaz\mycmux-app\mycmux.exe.bak-*
#   lite:     C:\Users\miyaz\mycmux-lite-app\mycmux-lite.exe.bak-*

param(
    [int]$KeepLast = 3,
    [switch]$DryRun,
    [ValidateSet('personal', 'lite', 'both')]
    [string]$Target = 'both'
)

$ErrorActionPreference = "Stop"

$plans = @()
if ($Target -in @('personal', 'both')) {
    $plans += [PSCustomObject]@{
        Label    = 'personal'
        Dir      = "$env:USERPROFILE\mycmux-app"
        Pattern  = 'mycmux.exe.bak-*'
    }
}
if ($Target -in @('lite', 'both')) {
    $plans += [PSCustomObject]@{
        Label    = 'lite'
        Dir      = "$env:USERPROFILE\mycmux-lite-app"
        Pattern  = 'mycmux-lite.exe.bak-*'
    }
}

$totalKept = 0
$totalDeleted = 0
$totalReclaimedBytes = 0

foreach ($plan in $plans) {
    if (-not (Test-Path $plan.Dir)) {
        Write-Host "[$($plan.Label)] skip: $($plan.Dir) does not exist"
        continue
    }
    $backups = Get-ChildItem -Path $plan.Dir -Filter $plan.Pattern -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending
    if (-not $backups -or $backups.Count -eq 0) {
        Write-Host "[$($plan.Label)] no backups in $($plan.Dir)"
        continue
    }

    $keep = $backups | Select-Object -First $KeepLast
    $drop = $backups | Select-Object -Skip $KeepLast

    Write-Host ("[{0}] {1} backup(s) found in {2}; keeping {3}, dropping {4}" -f `
        $plan.Label, $backups.Count, $plan.Dir, $keep.Count, $drop.Count)

    foreach ($k in $keep) {
        Write-Host ("  KEEP   {0,-40} {1,12:N0} bytes  ({2:yyyy-MM-dd HH:mm})" -f $k.Name, $k.Length, $k.LastWriteTime)
    }

    foreach ($d in $drop) {
        if ($DryRun) {
            Write-Host ("  WOULD  remove {0,-40} {1,12:N0} bytes  ({2:yyyy-MM-dd HH:mm})" -f $d.Name, $d.Length, $d.LastWriteTime)
        } else {
            try {
                Remove-Item $d.FullName -Force -ErrorAction Stop
                Write-Host ("  REMOVE {0,-40} {1,12:N0} bytes" -f $d.Name, $d.Length)
                $totalReclaimedBytes += $d.Length
            } catch {
                Write-Warning ("  FAILED to remove {0}: {1}" -f $d.Name, $_)
            }
        }
    }

    $totalKept += $keep.Count
    $totalDeleted += $drop.Count
}

Write-Host ""
if ($DryRun) {
    Write-Host "Dry run complete. $totalKept backup(s) would be kept, $totalDeleted dropped."
} else {
    $reclaimedMb = [math]::Round($totalReclaimedBytes / 1MB, 1)
    Write-Host "Done. $totalKept kept, $totalDeleted removed, ${reclaimedMb} MB reclaimed."
}
