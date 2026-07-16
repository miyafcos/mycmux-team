# build-lite.ps1 — mycmux-lite (team / public) build
#
# Requirements:
#   * MUST be run from the lite worktree (C:\Users\miyaz\cmux-for-linux-dev).
#   * Current branch MUST be `release/public-lite`.
#   * Working tree must be clean.
#   * Smart App Control 制約: build は必ずこの worktree 内で実行。別 worktree (master 側)
#     に置かれたコピーから走らせると署名検証でブロックされる。
#
# Produces:
#   * <worktree>\src-tauri\target\release\mycmux-lite.exe
#   * Deploys to C:\Users\miyaz\mycmux-lite-app\mycmux-lite.exe (with timestamped backup).
#
# Usage:
#   cd C:\Users\miyaz\cmux-for-linux-dev
#   powershell -ExecutionPolicy Bypass -File build-lite.ps1
#   # Pass -Force to auto-kill a running mycmux-lite.exe instead of aborting.

param(
    [switch]$Force
)

# NOTE: do NOT set $ErrorActionPreference = "Stop" globally.
# `cmd /c "vcvarsall.bat x64"` writes harmless warnings to stderr (e.g. when
# vswhere.exe is not on PATH); under "Stop" PowerShell promotes that to a
# terminating error and the build aborts before npm even runs.
$ErrorActionPreference = "Continue"
$repoRoot = $PSScriptRoot
$distDir  = "C:\Users\miyaz\mycmux-lite-app"
$expectedBranch = "release/public-lite"
$exeName = "mycmux-lite.exe"

Set-Location $repoRoot

# 1. Branch check
$branch = (& git branch --show-current).Trim()
if ($branch -ne $expectedBranch) {
    Write-Error "Expected branch '$expectedBranch', got '$branch'. Aborting."
    exit 1
}

# 2. Clean working tree check
$dirty = & git status --porcelain
if ($dirty) {
    Write-Error "Working tree is not clean. Commit or stash changes first.`n$dirty"
    exit 1
}

# 3. MSVC env (vcvarsall.bat x64)
$vsPath = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
if (-not (Test-Path $vsPath)) {
    Write-Error "vcvarsall.bat not found at $vsPath"
    exit 1
}
# Make sure cargo + the VS Installer (where vswhere.exe lives) are on PATH.
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH;C:\Program Files (x86)\Microsoft Visual Studio\Installer"
# Suppress stderr from vcvarsall.bat — the noisy warnings are harmless and we
# only care about the env-var dump after the `set` invocation.
$vcOutput = cmd /c "`"$vsPath`" x64 && set" 2>$null
foreach ($line in $vcOutput) {
    if ($line -match "^([^=]+)=(.*)$") {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
    }
}

# 4. Build
Write-Host "=== Building $exeName (branch: $branch) ==="
& npm run tauri build
if ($LASTEXITCODE -ne 0) {
    Write-Error "Build failed (exit code $LASTEXITCODE)."
    exit 1
}

# 5. Deploy with timestamped backup
$exeSrc = Join-Path $repoRoot "src-tauri\target\release\$exeName"
if (-not (Test-Path $exeSrc)) {
    Write-Error "Built exe not found at $exeSrc"
    exit 1
}
if (-not (Test-Path $distDir)) { New-Item -ItemType Directory $distDir | Out-Null }

$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$exeDst = Join-Path $distDir $exeName
$exeBak = Join-Path $distDir "$exeName.bak-$ts"

# 5a. Detect a running exe — Copy-Item -Force still fails on Windows file locks.
$exeBaseName = [IO.Path]::GetFileNameWithoutExtension($exeName)
$running = Get-Process -Name $exeBaseName -ErrorAction SilentlyContinue |
    Where-Object { try { $_.Path -ieq $exeDst } catch { $false } }
if ($running) {
    if ($Force) {
        Write-Host "Stopping running $exeName (PID $($running.Id))..."
        $running | Stop-Process -Force -ErrorAction Stop
        Start-Sleep -Milliseconds 500
    } else {
        Write-Error "$exeName is currently running (PID $($running.Id)). Close it or rerun with -Force. Build artifact remains at $exeSrc."
        exit 1
    }
}

if (Test-Path $exeDst) {
    try {
        Copy-Item $exeDst $exeBak -Force -ErrorAction Stop
        Write-Host "Backup saved: $exeBak"
    } catch {
        Write-Error "Failed to back up existing exe to $exeBak`: $_"
        exit 1
    }
}
try {
    Copy-Item $exeSrc $exeDst -Force -ErrorAction Stop
} catch {
    Write-Error "Deploy failed (copy $exeSrc -> $exeDst): $_`nBuild artifact preserved at $exeSrc — investigate file lock or permissions."
    exit 1
}

# 6. Report
$pkgVersion = (Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json).version
$sha = (& git rev-parse --short HEAD).Trim()
Write-Host ""
Write-Host "=== Build complete ==="
Write-Host "Branch:   $branch"
Write-Host "Commit:   $sha"
Write-Host "Version:  $pkgVersion"
Write-Host "Deployed: $exeDst"
Write-Host "Backup:   $exeBak"
