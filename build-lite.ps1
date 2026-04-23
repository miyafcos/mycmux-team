# build-lite.ps1 — mycmux-lite (team / public) build
#
# Requirements:
#   * Current branch MUST be `release/public-lite` (team-distribution build).
#   * Working tree must be clean.
#
# Produces:
#   * C:\Users\miyaz\cmux-for-linux-dev\src-tauri\target\release\mycmux-lite.exe
#   * Deploys to C:\Users\miyaz\mycmux-lite-app\mycmux-lite.exe (timestamped backup).
#   * Copies signed distribution assets (exe / nsis installer / latest.json / .sig)
#     to C:\Users\miyaz\cmux-for-linux-dev\dist-uploads\ if present.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File build-lite.ps1

$ErrorActionPreference = "Stop"
$repoRoot = "C:\Users\miyaz\cmux-for-linux-dev"
$distDir  = "C:\Users\miyaz\mycmux-lite-app"
$uploadDir = Join-Path $repoRoot "dist-uploads"
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
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
$vcOutput = cmd /c "`"$vsPath`" x64 && set" 2>&1
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
$releaseDir = Join-Path $repoRoot "src-tauri\target\release"
$exeSrc = Join-Path $releaseDir $exeName
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

# 6. Collect distribution artifacts (NSIS installer + signature + latest.json)
if (-not (Test-Path $uploadDir)) { New-Item -ItemType Directory $uploadDir | Out-Null }

$artifactPatterns = @(
    "bundle\nsis\*.exe",
    "bundle\nsis\*.exe.sig",
    "bundle\nsis\latest.json",
    "bundle\msi\*.msi",
    "bundle\msi\*.msi.sig"
)
$collected = @()
foreach ($pat in $artifactPatterns) {
    $matches = Get-ChildItem -Path (Join-Path $releaseDir $pat) -ErrorAction SilentlyContinue
    foreach ($m in $matches) {
        $dest = Join-Path $uploadDir $m.Name
        Copy-Item $m.FullName $dest -Force
        $collected += $dest
    }
}

# 7. Report
$pkgVersion = (Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json).version
$sha = (& git rev-parse --short HEAD).Trim()
Write-Host ""
Write-Host "=== Build complete ==="
Write-Host "Branch:   $branch"
Write-Host "Commit:   $sha"
Write-Host "Version:  $pkgVersion"
Write-Host "Deployed: $exeDst"
Write-Host "Backup:   $exeBak"
if ($collected.Count -gt 0) {
    Write-Host "Dist uploads ($($collected.Count) files) → $uploadDir"
    foreach ($c in $collected) { Write-Host "  $c" }
} else {
    Write-Host "Dist uploads: (none — run tauri build with bundle to produce NSIS/MSI/latest.json)"
}
