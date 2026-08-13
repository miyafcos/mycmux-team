[CmdletBinding()]
param(
  [ValidatePattern('^[A-Za-z0-9_-]{1,64}$')]
  [string]$Name = 'test',
  [switch]$FreshData
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$exePath = Join-Path $repoRoot 'src-tauri\target\release\mycmux.exe'
if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) {
  throw "Release executable was not found: $exePath. Run npm run tauri build first."
}

$appDataRoot = Join-Path $env:APPDATA 'com.miyazaki.mycmux'
$profileDataDir = Join-Path $appDataRoot (Join-Path 'profiles' $Name)
$runtimeDir = Join-Path $HOME ".mycmux-$Name"
New-Item -ItemType Directory -Force -Path $profileDataDir, $runtimeDir | Out-Null

if (-not $FreshData) {
  $sourceData = Join-Path $appDataRoot 'data.json'
  if (Test-Path -LiteralPath $sourceData -PathType Leaf) {
    Copy-Item -LiteralPath $sourceData -Destination (Join-Path $profileDataDir 'data.json') -Force
  }
}

$sourceAiLog = Join-Path $HOME '.mycmux\ailog.db'
if (Test-Path -LiteralPath $sourceAiLog -PathType Leaf) {
  Copy-Item -LiteralPath $sourceAiLog -Destination (Join-Path $runtimeDir 'ailog.db') -Force
  $size = (Get-Item -LiteralPath (Join-Path $runtimeDir 'ailog.db')).Length
  Write-Host "Copied ailog.db ($size bytes)"
}

Start-Process -FilePath $exePath -ArgumentList @('--profile', $Name) -WorkingDirectory (Split-Path -Parent $exePath)
