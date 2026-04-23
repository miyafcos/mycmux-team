# build-personal.ps1 — mycmux (personal / private) build
#
# Requirements:
#   * Current branch MUST be `master` (private personal build).
#   * Working tree must be clean.
#
# Produces:
#   * C:\Users\miyaz\cmux-for-linux-dev\src-tauri\target\release\mycmux.exe
#   * Deploys to C:\Users\miyaz\mycmux-app\mycmux.exe (with timestamped backup).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File build-personal.ps1

# NOTE: do NOT set $ErrorActionPreference = "Stop" globally.
# `cmd /c "vcvarsall.bat x64"` writes harmless warnings to stderr (e.g. when
# vswhere.exe is not on PATH); under "Stop" PowerShell promotes that to a
# terminating error and the build aborts before npm even runs.
$ErrorActionPreference = "Continue"
$repoRoot = "C:\Users\miyaz\cmux-for-linux-dev"
$distDir  = "C:\Users\miyaz\mycmux-app"
$expectedBranch = "master"
$exeName = "mycmux.exe"

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

if (Test-Path $exeDst) {
    Copy-Item $exeDst $exeBak -Force
    Write-Host "Backup saved: $exeBak"
}
Copy-Item $exeSrc $exeDst -Force

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
