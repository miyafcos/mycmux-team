#requires -Version 5.1
<#
.SYNOPSIS
  Normalizes a Tauri updater latest.json so the plain "windows-x86_64" platform
  key always matches the "windows-x86_64-nsis" entry's signature/url.

.DESCRIPTION
  The Tauri updater client falls back to the plain "windows-x86_64" platform
  key for bundle types it does not recognize (for example, a raw .exe copy
  deployed outside the installer reports bundle type UNK). If tauri-action's
  generated latest.json instead points that fallback key at the MSI bundle,
  a per-user NSIS/portable install gets offered a per-machine MSI update,
  producing a dual-install split-brain (the 0.9.x incident this guards
  against).

  This script is a pure input-file -> output-file normalization: it only
  overwrites platforms.'windows-x86_64' with platforms.'windows-x86_64-nsis'.
  It does not rewrite download URL prefixes, release notes, or validate the
  release version -- see mirror-personal-updater-feed.ps1 for that.

.PARAMETER InputPath
  Path to a latest.json to normalize.

.PARAMETER OutputPath
  Path to write the normalized latest.json to. Defaults to -InputPath
  (normalize in place).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath,

  [string]$OutputPath = $InputPath
)

$ErrorActionPreference = "Stop"

function Set-NormalizedWindowsFallbackKey {
  <#
    Pure function: takes a parsed latest.json object (pscustomobject) and
    returns it with platforms.'windows-x86_64' overwritten to match
    platforms.'windows-x86_64-nsis'. Throws if the nsis entry is missing.
  #>
  param(
    [Parameter(Mandatory = $true)][object]$Latest
  )

  if ($null -eq $Latest.platforms) {
    throw "latest.json has no 'platforms' object; cannot normalize fallback key."
  }

  $nsisEntry = $Latest.platforms.'windows-x86_64-nsis'
  if ($null -eq $nsisEntry) {
    throw "latest.json has no 'windows-x86_64-nsis' platform entry; cannot normalize fallback key."
  }

  $Latest.platforms.'windows-x86_64' = [pscustomobject]@{
    signature = $nsisEntry.signature
    url       = $nsisEntry.url
  }

  return $Latest
}

if (-not (Test-Path -LiteralPath $InputPath)) {
  throw "Input latest.json not found: $InputPath"
}

$latest = Get-Content -LiteralPath $InputPath -Raw -Encoding UTF8 | ConvertFrom-Json
$normalized = Set-NormalizedWindowsFallbackKey -Latest $latest

$plainEntry = $normalized.platforms.'windows-x86_64'
$nsisEntry = $normalized.platforms.'windows-x86_64-nsis'
if ($plainEntry.signature -ne $nsisEntry.signature -or $plainEntry.url -ne $nsisEntry.url) {
  throw "Normalization failed: 'windows-x86_64' still does not match 'windows-x86_64-nsis'."
}

$json = $normalized | ConvertTo-Json -Depth 100
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($OutputPath, $json, $utf8NoBom)

Write-Host "Normalized '$InputPath' -> '$OutputPath': windows-x86_64 now matches windows-x86_64-nsis."
