# package-dist.ps1 - bundle the built NSIS installer with a Japanese README
# into a versioned zip on the user's Desktop for easy team handoff.
#
# Usage: powershell -ExecutionPolicy Bypass -File package-dist.ps1
# Prerequisite: build-full.ps1 must have been run so the NSIS installer
# exists under src-tauri/target/release/bundle/nsis/.
#
# The README template is kept in a separate UTF-8 file (package-dist-readme.txt)
# so this script stays ASCII-only and is immune to PowerShell 5.1's default
# CP-ANSI script decoding.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "`n=== mycmux distribution packager ===" -ForegroundColor Cyan

# 1. Read the version from tauri.conf.json (single source of truth).
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

# 2. Locate the NSIS installer produced by `tauri build`.
$installerSrc = Join-Path $PSScriptRoot "src-tauri\target\release\bundle\nsis\mycmux_${version}_x64-setup.exe"
if (-not (Test-Path $installerSrc)) {
    Write-Host "`nNSIS installer not found:" -ForegroundColor Red
    Write-Host "  $installerSrc" -ForegroundColor Yellow
    Write-Host "`nRun build-full.ps1 first." -ForegroundColor Yellow
    exit 1
}

# 3. Load the README template (UTF-8, with {VERSION} placeholder).
$readmeTemplatePath = Join-Path $PSScriptRoot "package-dist-readme.txt"
if (-not (Test-Path $readmeTemplatePath)) {
    Write-Host "README template not found: $readmeTemplatePath" -ForegroundColor Red
    exit 1
}
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$readme = [System.IO.File]::ReadAllText($readmeTemplatePath, $utf8NoBom)
$readme = $readme -replace '\{VERSION\}', $version

# 4. Prepare a staging directory under %TEMP% (cleaned up at the end).
$date = Get-Date -Format "yyyyMMdd"
$distName = "mycmux-v${version}-${date}"
$staging = Join-Path $env:TEMP $distName
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null

# 5. Copy the installer into the staging dir with a simpler name.
$stagedInstaller = Join-Path $staging "mycmux-setup.exe"
Copy-Item $installerSrc $stagedInstaller

# 6. Write README.txt (UTF-8, no BOM — Windows 10 1803+ Notepad renders it).
$readmePath = Join-Path $staging "README.txt"
[System.IO.File]::WriteAllText($readmePath, $readme, $utf8NoBom)

# 7. Compress to Desktop as mycmux-v{version}-{date}.zip.
$desktopPath = [Environment]::GetFolderPath("Desktop")
$outZip = Join-Path $desktopPath "${distName}.zip"
if (Test-Path $outZip) { Remove-Item $outZip -Force }
Compress-Archive -Path "$staging\*" -DestinationPath $outZip -CompressionLevel Optimal

# 8. Clean up staging.
Remove-Item $staging -Recurse -Force

# 9. Print summary.
$sizeMB = [math]::Round((Get-Item $outZip).Length / 1MB, 2)
Write-Host "`nPackage ready:" -ForegroundColor Green
Write-Host "  File:     $outZip" -ForegroundColor Cyan
Write-Host "  Size:     ${sizeMB} MB" -ForegroundColor Cyan
Write-Host "  Version:  v${version}" -ForegroundColor Cyan
Write-Host "  Contents: mycmux-setup.exe, README.txt" -ForegroundColor Cyan
Write-Host ""
