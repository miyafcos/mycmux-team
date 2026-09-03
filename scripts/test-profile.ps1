<#
.SYNOPSIS
  Launches the built mycmux as an isolated test machine, alongside the real one.

.DESCRIPTION
  The test machine starts empty. It does NOT inherit the live workspace layout,
  because that layout carries agent session ids: copying it made the test build
  resume the real Claude and Codex conversations and take them over mid-flight.

  Every launch starts from a known state: the previous run's layout and runtime
  files are renamed aside rather than reused. Pass -Keep to carry them over.

  Pass -CloneData to seed it from the live layout anyway; the agent session ids
  are stripped on the way in, so panes still start as new sessions.

  Still shared with the live machine, and not fixable from this script: the CLI
  credentials under ~/.claude and ~/.codex. Switching accounts on the test
  machine rotates the tokens the live one is using.
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
  # Carry the previous test run's layout over instead of starting fresh.
  [switch]$Keep
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

# A test machine is only worth trusting if it starts from a known state, so the
# previous run's layout is set aside on every launch. Nothing is deleted: the old
# state is renamed, and -Keep skips this entirely.
if (-not $Keep -and (Test-Path -LiteralPath $profileData -PathType Leaf)) {
  $backup = Join-Path $profileDataDir "data.json.bak-$stamp"
  Move-Item -LiteralPath $profileData -Destination $backup
  Write-Host "Set aside the previous test layout: $backup"
}

# The runtime dir carries all mutable profile state. Keeping it is how a
# "fresh" machine quietly reattaches to something it should not know about.
# `bin` is intentionally absent: it contains immutable launcher assets.
$runtimeMutableState = @(
  'pane-sessions', 'sessions', 'mycmux.port', 'mycmux.token', 'remote.port', 'remote-token',
  'savepoint.json', 'savepoints',
  'ailog.db', 'ailog.db-wal', 'ailog.db-shm'
)
if (-not $Keep) {
  foreach ($stale in $runtimeMutableState) {
    $stalePath = Join-Path $runtimeDir $stale
    if (Test-Path -LiteralPath $stalePath) {
      Move-Item -LiteralPath $stalePath -Destination (Join-Path $runtimeDir "$stale.bak-$stamp")
      Write-Host "Set aside stale runtime state: $stale"
    }
  }
}

if ($CloneData) {
  $sourceData = Join-Path $appDataRoot 'data.json'
  if (Test-Path -LiteralPath $sourceData -PathType Leaf) {
    $live = Get-Content -LiteralPath $sourceData -Raw -Encoding UTF8 | ConvertFrom-Json
    # Drop every handle that could reattach the test machine to a live agent
    # conversation. Panes keep their shape and start fresh.
    $stripped = 0
    foreach ($workspace in @($live.workspaces)) {
      foreach ($pane in @($workspace.panes)) {
        foreach ($record in @($pane) + @($pane.tabs)) {
          foreach ($key in @('agent_session_id', 'claude_session_id', 'agent_kind', 'suppressed_agent_sessions', 'launch_env', 'terminal_snapshot')) {
            if ($null -ne $record.PSObject.Properties[$key]) {
              $record.PSObject.Properties.Remove($key)
              $stripped++
            }
          }
        }
      }
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($profileData, ($live | ConvertTo-Json -Depth 100), $utf8NoBom)
    Write-Host "Seeded the layout from the live machine, stripping $stripped agent-session handles"
  }
}

if ($CloneAiLog) {
  $sourceAiLog = Join-Path $HOME '.mycmux\ailog.db'
  if (Test-Path -LiteralPath $sourceAiLog -PathType Leaf) {
    foreach ($suffix in @('', '-wal', '-shm')) {
      $source = "$sourceAiLog$suffix"
      if (Test-Path -LiteralPath $source -PathType Leaf) {
        Copy-Item -LiteralPath $source -Destination (Join-Path $runtimeDir "ailog.db$suffix") -Force
      }
    }
    $size = (Get-Item -LiteralPath (Join-Path $runtimeDir 'ailog.db')).Length
    Write-Host "Copied ailog.db ($size bytes)"
  }
}

if (-not (Test-Path -LiteralPath $profileData -PathType Leaf)) {
  Write-Host "Starting empty: no layout, no sessions, nothing shared with the live machine's window state."
}

# WebView2 runs one browser process per user-data folder, so a test machine
# without a folder of its own rides on the live machine's. On 2026-09-03 that
# left the test window painting nothing and answering no socket calls while its
# PTYs ran fine underneath -- the launcher was on screen in the scrollback and
# nowhere on screen. Its own folder also keeps localStorage separate, which is
# why the test machine starts on default settings.
$webviewFolder = Join-Path $env:LOCALAPPDATA "com.miyazaki.mycmux\EBWebView-$Name"
New-Item -ItemType Directory -Force -Path $webviewFolder | Out-Null

# Start-Process hands this shell's environment to the app, and portable-pty then
# hands it to every pane. A test machine launched from an agent shell would run
# every pane under that shell's NO_COLOR/TERM, which reads as "the build lost all
# its colours". Drop those for the launch only, then put them back.
$launchScrubbed = @{}
# Not $name: PowerShell variable names are case-insensitive, so that would
# overwrite the $Name parameter and launch the wrong profile.
foreach ($envKey in @('NO_COLOR', 'FORCE_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE', 'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'COLORTERM', 'MYCMUX_REMOTE_PORT')) {
  $item = Get-Item -LiteralPath "Env:$envKey" -ErrorAction SilentlyContinue
  if ($item) {
    $launchScrubbed[$envKey] = $item.Value
    Remove-Item -LiteralPath "Env:$envKey" -ErrorAction SilentlyContinue
  }
}
$hadWebviewFolder = Test-Path Env:\WEBVIEW2_USER_DATA_FOLDER
$previousWebviewFolder = $env:WEBVIEW2_USER_DATA_FOLDER
$env:WEBVIEW2_USER_DATA_FOLDER = $webviewFolder
try {
  Start-Process -FilePath $exePath -ArgumentList @('--profile', $Name) -WorkingDirectory (Split-Path -Parent $exePath)
} finally {
  if ($hadWebviewFolder) { $env:WEBVIEW2_USER_DATA_FOLDER = $previousWebviewFolder }
  else { Remove-Item -LiteralPath 'Env:\WEBVIEW2_USER_DATA_FOLDER' -ErrorAction SilentlyContinue }
  foreach ($entry in $launchScrubbed.GetEnumerator()) {
    Set-Item -LiteralPath "Env:$($entry.Key)" -Value $entry.Value
  }
}
Write-Host "WebView2 profile: $webviewFolder"
if ($launchScrubbed.Count -gt 0) {
  Write-Host "Scrubbed from the launch environment: $($launchScrubbed.Keys -join ', ')"
}
