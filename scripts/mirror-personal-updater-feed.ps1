#requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SourceTag,

  [string]$SourceRepo = "miyafcos/mycmux",
  [string]$TargetRepo = "miyafcos/mycmux-team",
  [string]$TargetTag = "mycmux-personal-updater",
  [string]$WorkDir = (Join-Path $env:TEMP ("mycmux-personal-updater-" + [Guid]::NewGuid().ToString("N")))
)

$ErrorActionPreference = "Stop"

function Invoke-Gh {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  & gh @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "gh $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

function Get-SingleFile {
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][string]$Pattern
  )
  $matches = @(Get-ChildItem -LiteralPath $Directory -File -Filter $Pattern)
  if ($matches.Count -ne 1) {
    throw "Expected exactly one '$Pattern' in $Directory, found $($matches.Count)."
  }
  return $matches[0]
}

function Rewrite-DownloadUrls {
  param(
    [AllowNull()][object]$Value,
    [Parameter(Mandatory = $true)][string]$SourcePrefix,
    [Parameter(Mandatory = $true)][string]$TargetPrefix
  )

  if ($null -eq $Value) {
    return $null
  }

  if ($Value -is [string]) {
    return $Value.Replace($SourcePrefix, $TargetPrefix)
  }

  if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
    $items = @()
    foreach ($item in $Value) {
      $items += Rewrite-DownloadUrls -Value $item -SourcePrefix $SourcePrefix -TargetPrefix $TargetPrefix
    }
    return $items
  }

  if ($Value -is [pscustomobject]) {
    foreach ($property in @($Value.PSObject.Properties)) {
      $property.Value = Rewrite-DownloadUrls -Value $property.Value -SourcePrefix $SourcePrefix -TargetPrefix $TargetPrefix
    }
    return $Value
  }

  return $Value
}

function Ensure-TargetRelease {
  param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string]$Tag
  )

  & gh release view $Tag --repo $Repo *> $null
  if ($LASTEXITCODE -eq 0) {
    Invoke-Gh -Arguments @("release", "edit", $Tag, "--repo", $Repo, "--title", "mycmux personal updater feed", "--prerelease")
    $json = & gh release view $Tag --repo $Repo --json databaseId | ConvertFrom-Json
    if ($json.databaseId) {
      Invoke-Gh -Arguments @("api", "--method", "PATCH", "/repos/$Repo/releases/$($json.databaseId)", "-f", "make_latest=false", "-f", "prerelease=true")
    }
    return
  }

  Invoke-Gh -Arguments @(
    "release", "create", $Tag,
    "--repo", $Repo,
    "--title", "mycmux personal updater feed",
    "--notes", "Fixed public updater feed for mycmux personal builds.",
    "--prerelease",
    "--latest=false"
  )
}

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
Write-Host "Using work directory: $WorkDir"

$patterns = @(
  "latest.json",
  "mycmux_*_x64-setup.exe",
  "mycmux_*_x64-setup.exe.sig",
  "mycmux_*_x64_en-US.msi",
  "mycmux_*_x64_en-US.msi.sig"
)

foreach ($pattern in $patterns) {
  Invoke-Gh -Arguments @(
    "release", "download", $SourceTag,
    "--repo", $SourceRepo,
    "--dir", $WorkDir,
    "--pattern", $pattern,
    "--clobber"
  )
}

$latestFile = Get-SingleFile -Directory $WorkDir -Pattern "latest.json"
$setupFile = Get-SingleFile -Directory $WorkDir -Pattern "mycmux_*_x64-setup.exe"
$setupSigFile = Get-SingleFile -Directory $WorkDir -Pattern "mycmux_*_x64-setup.exe.sig"
$msiFile = Get-SingleFile -Directory $WorkDir -Pattern "mycmux_*_x64_en-US.msi"
$msiSigFile = Get-SingleFile -Directory $WorkDir -Pattern "mycmux_*_x64_en-US.msi.sig"

$expectedVersion = if ($SourceTag.StartsWith("v")) { $SourceTag.Substring(1) } else { $SourceTag }
$sourcePrefix = "https://github.com/$SourceRepo/releases/download/$SourceTag/"
$targetPrefix = "https://github.com/$TargetRepo/releases/download/$TargetTag/"

$latest = Get-Content -LiteralPath $latestFile.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
if ($latest.version -ne $expectedVersion) {
  throw "latest.json version '$($latest.version)' does not match expected '$expectedVersion'."
}

$rewritten = Rewrite-DownloadUrls -Value $latest -SourcePrefix $sourcePrefix -TargetPrefix $targetPrefix
if ($rewritten.PSObject.Properties.Name -contains "notes") {
  $rewritten.notes = "mycmux personal build ($SourceTag). See CHANGELOG.md for details."
}

# Write the URL-rewritten JSON, then hand the plain "windows-x86_64" fallback-key
# normalization (binaries deployed as raw exe copies carry bundle type UNK, fall back
# to that key, and must not receive the MSI, or a per-machine MSI install leaves the
# per-user NSIS/portable copy stale) to the shared script so master and lite feeds
# apply the exact same fix instead of duplicating the logic here.
$preNormalizeJson = $rewritten | ConvertTo-Json -Depth 100
$utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
[System.IO.File]::WriteAllText($latestFile.FullName, $preNormalizeJson, $utf8NoBom)

$normalizeScript = Join-Path $PSScriptRoot "normalize-updater-feed.ps1"
& $normalizeScript -InputPath $latestFile.FullName -OutputPath $latestFile.FullName

$rewrittenJson = Get-Content -LiteralPath $latestFile.FullName -Raw -Encoding UTF8
if ($rewrittenJson -match [regex]::Escape($sourcePrefix)) {
  throw "latest.json still references private source URL prefix: $sourcePrefix"
}
if ($rewrittenJson -notmatch [regex]::Escape($targetPrefix)) {
  throw "latest.json does not reference target URL prefix: $targetPrefix"
}

Ensure-TargetRelease -Repo $TargetRepo -Tag $TargetTag

$uploadArgs = @(
  "release", "upload", $TargetTag,
  $latestFile.FullName,
  $setupFile.FullName,
  $setupSigFile.FullName,
  $msiFile.FullName,
  $msiSigFile.FullName,
  "--repo", $TargetRepo,
  "--clobber"
)
Invoke-Gh -Arguments $uploadArgs

$verifyDir = Join-Path $WorkDir "verify"
New-Item -ItemType Directory -Force -Path $verifyDir | Out-Null
Invoke-Gh -Arguments @(
  "release", "download", $TargetTag,
  "--repo", $TargetRepo,
  "--dir", $verifyDir,
  "--pattern", "latest.json",
  "--clobber"
)

$verified = Get-Content -LiteralPath (Join-Path $verifyDir "latest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if ($verified.version -ne $expectedVersion) {
  throw "Published target latest.json version '$($verified.version)' does not match expected '$expectedVersion'."
}

Write-Host "Mirrored $SourceRepo $SourceTag to $TargetRepo $TargetTag (version $expectedVersion)."
