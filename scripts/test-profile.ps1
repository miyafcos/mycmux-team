<#
.SYNOPSIS
  Launches the built mycmux as an isolated test machine, alongside the real one.

.DESCRIPTION
  The test machine starts empty. It does NOT inherit the live workspace layout,
  because that layout carries agent session ids: copying it made the test build
  resume the real Claude and Codex conversations and take them over mid-flight.

  Pass -CloneData to seed it from the live layout anyway; the agent session ids
  are stripped on the way in, so panes still start as new sessions.
#>
[CmdletBinding()]
param(
  [ValidatePattern('^[A-Za-z0-9_-]{1,64}$')]
  [string]$Name = 'test',
  # Seed the layout from the live machine, minus everything that would resume a
  # real conversation. Off by default: an empty machine is the safe one.
  [switch]$CloneData,
  # Seed the AI log so the usage tab has something to show (it is large).
  [switch]$CloneAiLog,
  # Set aside whatever this test profile accumulated and start over.
  [switch]$Reset
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

$profileData = Join-Path $profileDataDir 'data.json'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# Nothing is deleted here: the old state is renamed aside so it can be restored.
if ($Reset -and (Test-Path -LiteralPath $profileData -PathType Leaf)) {
  $backup = Join-Path $profileDataDir "data.json.bak-$stamp"
  Move-Item -LiteralPath $profileData -Destination $backup
  Write-Host "Set aside the previous test layout: $backup"
}

if ($CloneData) {
  $sourceData = Join-Path $appDataRoot 'data.json'
  if (Test-Path -LiteralPath $sourceData -PathType Leaf) {
    $live = Get-Content -LiteralPath $sourceData -Raw -Encoding UTF8 | ConvertFrom-Json
    # Drop every handle that could reattach the test machine to a live agent
    # conversation. Panes keep their shape and start fresh.
    $stripped = 0
    foreach ($config in @($live.configs)) {
      foreach ($pane in @($config.panes)) {
        foreach ($tab in @($pane.tabs)) {
          foreach ($key in @('agentSessionId', 'agentKind', 'claudeSessionId', 'suppressedAgentSessions')) {
            if ($null -ne $tab.PSObject.Properties[$key]) {
              $tab.PSObject.Properties.Remove($key)
              $stripped++
            }
          }
        }
      }
    }
    $live | ConvertTo-Json -Depth 100 | Out-File -LiteralPath $profileData -Encoding utf8
    Write-Host "Seeded the layout from the live machine, stripping $stripped agent-session handles"
  }
}

if ($CloneAiLog) {
  $sourceAiLog = Join-Path $HOME '.mycmux\ailog.db'
  if (Test-Path -LiteralPath $sourceAiLog -PathType Leaf) {
    Copy-Item -LiteralPath $sourceAiLog -Destination (Join-Path $runtimeDir 'ailog.db') -Force
    $size = (Get-Item -LiteralPath (Join-Path $runtimeDir 'ailog.db')).Length
    Write-Host "Copied ailog.db ($size bytes)"
  }
}

if (-not (Test-Path -LiteralPath $profileData -PathType Leaf)) {
  Write-Host "Starting empty: no layout, no sessions, nothing shared with the live machine's window state."
}

# Start-Process hands this shell's environment to the app, and portable-pty then
# hands it to every pane. A test machine launched from an agent shell would run
# every pane under that shell's NO_COLOR/TERM, which reads as "the build lost all
# its colours". Drop those for the launch only, then put them back.
$launchScrubbed = @{}
# Not $name: PowerShell variable names are case-insensitive, so that would
# overwrite the $Name parameter and launch the wrong profile.
foreach ($envKey in @('NO_COLOR', 'FORCE_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE', 'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'COLORTERM')) {
  $item = Get-Item -LiteralPath "Env:$envKey" -ErrorAction SilentlyContinue
  if ($item) {
    $launchScrubbed[$envKey] = $item.Value
    Remove-Item -LiteralPath "Env:$envKey" -ErrorAction SilentlyContinue
  }
}
try {
  Start-Process -FilePath $exePath -ArgumentList @('--profile', $Name) -WorkingDirectory (Split-Path -Parent $exePath)
} finally {
  foreach ($entry in $launchScrubbed.GetEnumerator()) {
    Set-Item -LiteralPath "Env:$($entry.Key)" -Value $entry.Value
  }
}
if ($launchScrubbed.Count -gt 0) {
  Write-Host "Scrubbed from the launch environment: $($launchScrubbed.Keys -join ', ')"
}
