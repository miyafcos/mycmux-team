# mycmux: build + update in one command
# Usage: powershell -ExecutionPolicy Bypass -File C:\Users\miyaz\cmux-for-linux-dev\build-and-update.ps1

Write-Host "`n=== mycmux Build & Update ===" -ForegroundColor Cyan

# Step 1: MSVC environment
$vsPath = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
$output = cmd /c "`"$vsPath`" x64 && set" 2>&1
foreach ($line in $output) {
    if ($line -match "^([^=]+)=(.*)$") {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
    }
}

# Step 2: Build
Set-Location C:\Users\miyaz\cmux-for-linux-dev
Write-Host "`n[1/3] Building..." -ForegroundColor Yellow
npm run tauri build
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed!" -ForegroundColor Red
    exit 1
}

# Step 3: Update
Write-Host "`n[2/3] Updating..." -ForegroundColor Yellow
& "C:\Users\miyaz\mycmux-app\update.ps1"

Write-Host "`n[3/3] Complete!" -ForegroundColor Green
Write-Host "mycmux has been restarted with the new build."
Write-Host "Your sessions and CWDs are auto-restored."
Write-Host "Run 'claude --resume' in each pane to continue Claude sessions.`n"
