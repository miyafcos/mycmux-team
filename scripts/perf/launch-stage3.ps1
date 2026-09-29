[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ExePath,
      [ValidateSet('L0','L24')][string]$Load='L24', [string]$FixtureDirectory=(Join-Path $env:USERPROFILE '_work\mycmux-perf3-260924\base'), [switch]$Keep, [switch]$Cold,
      [ValidatePattern('^[A-Za-z0-9_-]{1,64}$')][string]$Name='perf3')
$ErrorActionPreference = 'Stop'
$stage3IsolationStop = Join-Path $env:USERPROFILE '_work\mycmux-perf3-260924\base\ISOLATION_BLOCKED.json'
if (Test-Path -LiteralPath $stage3IsolationStop) { throw 'Isolated launch blocked: window-state plugin writes production app-data. Resolve the recorded isolation boundary before resuming.' }
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
if (Test-Path -LiteralPath (Join-Path $FixtureDirectory 'PAUSE_BEFORE_LAUNCH.json')) { throw 'Driver maintenance pause before launch; no test process was started' }
$env:PYTHONIOENCODING = 'utf-8'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '_work\mycmux-perf3-260924')) + '\'
if (-not [IO.Path]::GetFullPath($ExePath).StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Use a preserved executable under the stage3 work folder' }
# Interpose only at the launch boundary. The original script still clones and
# strips its resume handles. Normalize shell agents before it starts any PTY.
function Start-Process {
  param([string]$FilePath, [string[]]$ArgumentList, [string]$WorkingDirectory)
  if ($FilePath -ne $ExePath -or ($ArgumentList -join ' ') -ne "--profile $Name") { throw 'Unexpected launch' }
  if (-not $Keep) {
    & python (Join-Path $PSScriptRoot 'prepare-stage3-profile.py') --load $Load --cwd $FixtureDirectory --profile-name $Name
    if ($LASTEXITCODE -ne 0) { throw 'Profile normalization failed' }
  }
  if ($Cold) {
    $profileRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "com.miyazaki.mycmux\profiles\$Name"))
    $webCache = [IO.Path]::GetFullPath((Join-Path $profileRoot 'web-profiles'))
    $retiredCache = [IO.Path]::GetFullPath((Join-Path $profileRoot ('web-profiles.pre-cold-' + [guid]::NewGuid().ToString('N'))))
    if (-not $webCache.StartsWith($profileRoot + '\') -or -not $retiredCache.StartsWith($profileRoot + '\')) { throw 'Cold cache path escaped isolated profile' }
    if (Test-Path -LiteralPath $webCache) { Move-Item -LiteralPath $webCache -Destination $retiredCache }
    $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $env:LOCALAPPDATA ("com.miyazaki.mycmux\EBWebView-$Name-cold-" + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($env:WEBVIEW2_USER_DATA_FOLDER) | Out-Null
  }
  Microsoft.PowerShell.Management\Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory -WindowStyle Hidden
}
if ($Keep) { & (Join-Path $repo 'scripts\test-profile.ps1') -Name $Name -ExePath $ExePath -Keep }
else { & (Join-Path $repo 'scripts\test-profile.ps1') -Name $Name -ExePath $ExePath -CloneData }
