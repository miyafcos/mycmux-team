# package-source.ps1
# Bundle the mycmux source tree into a portable zip for team distribution.
# The output zip can be handed to another developer; extracting it and
# opening the folder in Claude Code is enough to drive a full install.
#
# Usage: powershell -ExecutionPolicy Bypass -File package-source.ps1
# Output: %USERPROFILE%\Desktop\mycmux-src-v{VERSION}-{DATE}.zip

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "`n=== mycmux source packager ===" -ForegroundColor Cyan

# 1. Version from tauri.conf.json (single source of truth).
$confPath = Join-Path $PSScriptRoot "src-tauri\tauri.conf.json"
if (-not (Test-Path $confPath)) {
    Write-Host "tauri.conf.json not found at $confPath" -ForegroundColor Red
    exit 1
}
$version = (Get-Content $confPath -Raw | ConvertFrom-Json).version
if (-not $version) {
    Write-Host "Could not read version from tauri.conf.json" -ForegroundColor Red
    exit 1
}
$date = Get-Date -Format "yyyyMMdd"
$distName = "mycmux-src-v${version}-${date}"
Write-Host "Version:  v${version}" -ForegroundColor Cyan
Write-Host "Dist dir: $distName" -ForegroundColor Cyan

# 2. Staging under %TEMP% (cleaned at the end).
$staging = Join-Path $env:TEMP $distName
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null

# 3. Copy source with robocopy. /XD matches dir names at any depth, /XF matches
#    file patterns. Exit codes 0..7 are success; >=8 is an error.
Write-Host "`nCopying source tree..." -ForegroundColor Cyan

$excludeDirs = @(
    "node_modules", "dist", "dist-cmux-ui", "target",
    "tmp", ".git", ".claude", ".vscode", ".idea",
    "WixTools", ".agent", ".agents", ".serena", ".kilocode",
    ".factory", ".qwen"
)
$excludeFiles = @(
    "*.log", "*.exe", "*.dmg", "*.tsbuildinfo",
    ".env", ".env.local", "Thumbs.db", ".DS_Store",
    # The packaging scripts themselves are not part of the distribution.
    "package-source.ps1",
    "package-source-claude-md.txt",
    "package-source-install-md.txt",
    "package-source-readme-ja.txt",
    "package-dist.ps1",
    "package-dist-readme.txt",
    # Hardcoded-path build scripts are replaced below.
    "build-full.bat",
    "build.bat",
    "build-and-update.ps1",
    "deploy-update.ps1"
)

$roboArgs = @($PSScriptRoot, $staging, "/MIR")
$roboArgs += @("/XD") + $excludeDirs
$roboArgs += @("/XF") + $excludeFiles
$roboArgs += @("/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1")

& robocopy @roboArgs | Out-Null
if ($LASTEXITCODE -ge 8) {
    Write-Host "robocopy failed with exit code $LASTEXITCODE" -ForegroundColor Red
    exit 1
}
$LASTEXITCODE = 0  # reset so the rest of the script doesn't trip

# 4. Overwrite build-full.ps1 with a portable version that auto-detects MSVC.
Write-Host "Writing portable build-full.ps1..." -ForegroundColor Cyan
$portableBuild = @'
# build-full.ps1 - portable build entry point for mycmux.
# Detects MSVC Build Tools 2022, imports the vcvarsall env, then runs
# `npm run tauri build`. Works regardless of install location or MSVC version.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$vsCandidates = @(
    "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools",
    "C:\Program Files\Microsoft Visual Studio\2022\BuildTools",
    "C:\Program Files\Microsoft Visual Studio\2022\Community",
    "C:\Program Files\Microsoft Visual Studio\2022\Professional",
    "C:\Program Files\Microsoft Visual Studio\2022\Enterprise"
)
$vcvars = $null
foreach ($root in $vsCandidates) {
    $candidate = Join-Path $root "VC\Auxiliary\Build\vcvarsall.bat"
    if (Test-Path $candidate) { $vcvars = $candidate; break }
}
if (-not $vcvars) {
    Write-Host "MSVC Build Tools 2022 not found." -ForegroundColor Red
    Write-Host "Install from: https://visualstudio.microsoft.com/visual-cpp-build-tools/" -ForegroundColor Yellow
    Write-Host "Select the 'Desktop development with C++' workload." -ForegroundColor Yellow
    exit 1
}
Write-Host "Using MSVC env: $vcvars" -ForegroundColor Cyan

$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
$output = cmd /c "`"$vcvars`" x64 && set" 2>&1
foreach ($line in $output) {
    if ($line -match "^([^=]+)=(.*)$") {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
    }
}

Write-Host "Running 'npm run tauri build'..." -ForegroundColor Cyan
npm run tauri build
'@
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText(
    (Join-Path $staging "build-full.ps1"),
    $portableBuild,
    $utf8NoBom
)

# 5. Remove the hardcoded MSVC linker override from .cargo/config.toml.
#    The portable build-full.ps1 puts MSVC link.exe first in PATH via
#    vcvarsall, so the override is no longer needed and would break on
#    machines with a different MSVC toolchain version.
$cargoConfig = Join-Path $staging "src-tauri\.cargo\config.toml"
if (Test-Path $cargoConfig) {
    Remove-Item $cargoConfig -Force
    # Clean up empty .cargo dir to keep the tree tidy.
    $cargoDir = Join-Path $staging "src-tauri\.cargo"
    if ((Test-Path $cargoDir) -and -not (Get-ChildItem $cargoDir -Force)) {
        Remove-Item $cargoDir -Force
    }
}

# 6. Write CLAUDE.md, INSTALL.md, README-JA.txt from companion templates.
Write-Host "Writing CLAUDE.md / INSTALL.md / README-JA.txt..." -ForegroundColor Cyan
$templates = @(
    @("package-source-claude-md.txt",   "CLAUDE.md"),
    @("package-source-install-md.txt",  "INSTALL.md"),
    @("package-source-readme-ja.txt",   "README-JA.txt")
)
foreach ($pair in $templates) {
    $src = Join-Path $PSScriptRoot $pair[0]
    $dst = Join-Path $staging $pair[1]
    if (-not (Test-Path $src)) {
        Write-Host "Missing template: $src" -ForegroundColor Red
        exit 1
    }
    $body = [System.IO.File]::ReadAllText($src, $utf8NoBom)
    $body = $body -replace '\{VERSION\}', $version
    $body = $body -replace '\{DATE\}', $date
    [System.IO.File]::WriteAllText($dst, $body, $utf8NoBom)
}

# 7. Compress to Desktop.
$desktop = [Environment]::GetFolderPath("Desktop")
$outZip = Join-Path $desktop "${distName}.zip"
if (Test-Path $outZip) { Remove-Item $outZip -Force }
Write-Host "Compressing to $outZip..." -ForegroundColor Cyan
Compress-Archive -Path "$staging\*" -DestinationPath $outZip -CompressionLevel Optimal

# 8. Clean up staging.
Remove-Item $staging -Recurse -Force

# 9. Summary.
$sizeMB = [math]::Round((Get-Item $outZip).Length / 1MB, 2)
Write-Host "`nSource package ready:" -ForegroundColor Green
Write-Host "  File:    $outZip" -ForegroundColor Cyan
Write-Host "  Size:    ${sizeMB} MB" -ForegroundColor Cyan
Write-Host "  Version: v${version}" -ForegroundColor Cyan
Write-Host "  Contents:" -ForegroundColor Cyan
Write-Host "    - CLAUDE.md      (instructions for Claude Code)" -ForegroundColor DarkGray
Write-Host "    - INSTALL.md     (step-by-step runbook)" -ForegroundColor DarkGray
Write-Host "    - README-JA.txt  (human-readable guide, Japanese)" -ForegroundColor DarkGray
Write-Host "    - build-full.ps1 (portable build, auto-detects MSVC)" -ForegroundColor DarkGray
Write-Host "    - src/ src-tauri/ (full source tree)" -ForegroundColor DarkGray
Write-Host ""
