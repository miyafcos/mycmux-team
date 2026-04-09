# mycmux update deploy script
# Usage: mycmuxを閉じてから実行
# powershell -ExecutionPolicy Bypass -File deploy-update.ps1

Write-Host "=== mycmux Deploy ===" -ForegroundColor Cyan

# 1. Check if mycmux is running
$proc = Get-Process -Name "mycmux" -ErrorAction SilentlyContinue
if ($proc) {
    Write-Host "mycmux is running. Close it first!" -ForegroundColor Red
    Write-Host "Press any key after closing mycmux..." -ForegroundColor Yellow
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}

# 2. Full build
Write-Host "`nBuilding..." -ForegroundColor Yellow
Set-Location $PSScriptRoot
npm run tauri build 2>&1 | Select-Object -Last 5

if ($LASTEXITCODE -ne 0) {
    Write-Host "Build FAILED!" -ForegroundColor Red
    exit 1
}

# 3. Copy exe
$primarySrc = "$PSScriptRoot\src-tauri\target\release\mycmux.exe"
$legacySrc = "$PSScriptRoot\src-tauri\target\release\ptrterminal.exe"
$dst = "$env:USERPROFILE\mycmux-app\mycmux.exe"

$src = if (Test-Path $primarySrc) {
    $primarySrc
} elseif (Test-Path $legacySrc) {
    $legacySrc
} else {
    $null
}

Write-Host "`nCopying $src -> $dst" -ForegroundColor Yellow
if ($src) {
    Copy-Item $src $dst -Force
}

if ($src -and $?) {
    Write-Host "`nDeploy SUCCESS!" -ForegroundColor Green
    Write-Host "Changes included:" -ForegroundColor Cyan
    Write-Host "  - Remote Terminal (WebSocket + Dashboard UI)" -ForegroundColor White
    Write-Host "  - Existing session monitoring from iPhone" -ForegroundColor White
    Write-Host "  - Shift+Enter Kitty protocol fix" -ForegroundColor White
    Write-Host "  - 3 new themes: Berry Cream, Ocean Mist, Matcha Latte" -ForegroundColor White
    Write-Host "`nStart mycmux and check console for QR code." -ForegroundColor Yellow
} else {
    Write-Host "Copy FAILED! Build not found or mycmux is still running." -ForegroundColor Red
}
