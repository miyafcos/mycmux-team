$ErrorActionPreference = "Continue"

$global:MycmuxGrokExecutable = Get-Command grok -CommandType Application,ExternalScript -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty Source

function global:Get-MycmuxHookCapability {
  param([Parameter(Mandatory = $true)][string]$Provider)
  if ([string]::IsNullOrWhiteSpace($env:MYCMUX_PANE_SESSION_ID)) {
    return $null
  }
  $runtimeDir = if ($env:MYCMUX_RUNTIME_DIR) { $env:MYCMUX_RUNTIME_DIR } else { Join-Path $HOME ".mycmux" }
  try {
    $port = [int]([System.IO.File]::ReadAllText((Join-Path $runtimeDir "mycmux.port"))).Trim()
    $token = ([System.IO.File]::ReadAllText((Join-Path $runtimeDir "mycmux.token"))).Trim()
    $request = @{
      token = $token
      cmd = "launch.issue_hook_cap"
      args = @{
        terminal_session_id = $env:MYCMUX_PANE_SESSION_ID
        provider = $Provider
      }
    } | ConvertTo-Json -Compress -Depth 4
    $client = [System.Net.Sockets.TcpClient]::new()
    $client.SendTimeout = 400
    $client.ReceiveTimeout = 400
    $client.Connect("127.0.0.1", $port)
    try {
      $stream = $client.GetStream()
      $writer = [System.IO.StreamWriter]::new($stream, [System.Text.UTF8Encoding]::new($false), 1024, $true)
      $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8, $false, 1024, $true)
      $writer.WriteLine($request)
      $writer.Flush()
      $response = $reader.ReadLine() | ConvertFrom-Json -ErrorAction Stop
      $capability = [string]$response.result.hook_cap
      if ([string]::IsNullOrWhiteSpace($capability)) {
        return $null
      }
      return $capability
    } finally {
      $client.Dispose()
    }
  } catch {
    return $null
  }
}

function global:Invoke-MycmuxAgentWithHook {
  param(
    [Parameter(Mandatory = $true)][string]$Provider,
    [Parameter(Mandatory = $true)][string]$Executable,
    [object[]]$AgentArgs
  )
  $previous = [Environment]::GetEnvironmentVariable("MYCMUX_HOOK_CAP", "Process")
  $capability = Get-MycmuxHookCapability $Provider
  try {
    if ([string]::IsNullOrWhiteSpace($capability)) {
      [Environment]::SetEnvironmentVariable("MYCMUX_HOOK_CAP", $null, "Process")
    } else {
      [Environment]::SetEnvironmentVariable("MYCMUX_HOOK_CAP", $capability, "Process")
    }
    & $Executable @AgentArgs
  } finally {
    [Environment]::SetEnvironmentVariable("MYCMUX_HOOK_CAP", $previous, "Process")
  }
}

function global:claude {
  Invoke-MycmuxAgentWithHook "claude" (Join-Path $HOME "bin\claude.cmd") @($args)
}

function global:claude-codex {
  Invoke-MycmuxAgentWithHook "claude" (Join-Path $HOME "bin\claude-codex.cmd") @($args)
}

function global:codex {
  Invoke-MycmuxAgentWithHook "codex" (Join-Path $env:APPDATA "npm\codex.cmd") @($args)
}

function global:grok {
  if ([string]::IsNullOrWhiteSpace($global:MycmuxGrokExecutable)) {
    Write-Error "grok was not found on PATH."
    return
  }
  Invoke-MycmuxAgentWithHook "grok" $global:MycmuxGrokExecutable @($args)
}

if ($env:MYCMUX_HOOK_WRAPPERS_ONLY -eq "1") {
  return
}

function Test-MycmuxCommand {
  param([Parameter(Mandatory = $true)][string]$Name)
  switch ($Name) {
    "claude" { return Test-Path -LiteralPath (Join-Path $HOME "bin\claude.cmd") }
    "claude-codex" { return Test-Path -LiteralPath (Join-Path $HOME "bin\claude-codex.cmd") }
    "codex" { return Test-Path -LiteralPath (Join-Path $env:APPDATA "npm\codex.cmd") }
    "grok" { return -not [string]::IsNullOrWhiteSpace($global:MycmuxGrokExecutable) }
  }
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Import-MycmuxUserEnvIfMissing {
  param([Parameter(Mandatory = $true)][string]$Name)
  if ([Environment]::GetEnvironmentVariable($Name, "Process")) {
    return
  }
  $value = [Environment]::GetEnvironmentVariable($Name, "User")
  if ($value) {
    [Environment]::SetEnvironmentVariable($Name, $value, "Process")
  }
}

function New-MycmuxOption {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [string[]]$Command,
    [string]$RequiredCommand,
    # MYCMUX_LAUNCH_TARGET this row corresponds to. Only set on rows that can
    # take a model / effort, which is what the launch-spec menu keys off.
    [string]$Target
  )
  [pscustomobject]@{
    Label = $Label
    Command = $Command
    RequiredCommand = $RequiredCommand
    Target = $Target
  }
}

function Write-MycmuxSessionMapping {
  param(
    [string]$PaneId,
    [string]$Kind,
    [string]$SessionId
  )
  if ([string]::IsNullOrWhiteSpace($PaneId) -or [string]::IsNullOrWhiteSpace($SessionId)) {
    return
  }
  $mappingId = if ($env:MYCMUX_TAB_ID -match "^[0-9a-fA-F-]{36}$") { $env:MYCMUX_TAB_ID } else { $PaneId }
  if ([string]::IsNullOrWhiteSpace($mappingId)) {
    return
  }
  $runtimeDir = if ($env:MYCMUX_RUNTIME_DIR) { $env:MYCMUX_RUNTIME_DIR } else { Join-Path $HOME ".mycmux" }
  $mapDir = Join-Path $runtimeDir "pane-sessions"
  New-Item -ItemType Directory -Force -Path $mapDir | Out-Null
  $mapPath = Join-Path $mapDir "$mappingId.txt"
  $encoding = New-Object System.Text.UTF8Encoding($false)
  if ([string]::IsNullOrWhiteSpace($Kind)) {
    $content = $SessionId
  } else {
    $content = "{0}:{1}" -f $Kind, $SessionId
  }
  [System.IO.File]::WriteAllText($mapPath, $content + [Environment]::NewLine, $encoding)
}

function ConvertTo-MycmuxProjectPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  if ($Path -match "^/([a-zA-Z])/(.*)$") {
    return ("{0}:\{1}" -f $Matches[1].ToUpperInvariant(), $Matches[2].Replace("/", "\"))
  }
  return $Path
}

function Get-MycmuxClaudeProjectDir {
  $mangled = Get-MycmuxClaudeProjectKey (Get-Location).Path
  return Join-Path (Join-Path $HOME ".claude\projects") $mangled
}

function Get-MycmuxClaudeProjectKey {
  param([Parameter(Mandatory = $true)][string]$Path)
  $normalized = (ConvertTo-MycmuxProjectPath $Path).TrimEnd([char[]]@('\', '/'))
  return ([regex]::Replace($normalized, "[^A-Za-z0-9-]", "-")).TrimStart([char]'-')
}

function Find-MycmuxClaudeSessionFile {
  param([Parameter(Mandatory = $true)][string]$SessionId)
  if ($SessionId -notmatch "^[0-9a-fA-F-]{36}$") {
    return $null
  }
  $root = Join-Path $HOME ".claude\projects"
  if (-not (Test-Path -LiteralPath $root)) {
    return $null
  }
  $candidates = @()
  foreach ($projectDir in Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue) {
    $candidate = Join-Path $projectDir.FullName "$SessionId.jsonl"
    if (Test-Path -LiteralPath $candidate) {
      $item = Get-Item -LiteralPath $candidate -ErrorAction SilentlyContinue
      if ($null -ne $item) {
        $candidates += $item
      }
    }
  }
  return $candidates |
    Sort-Object -Property @{ Expression = "LastWriteTimeUtc"; Descending = $true }, @{ Expression = "Length"; Descending = $true } |
    Select-Object -First 1 -ExpandProperty FullName
}

function Get-MycmuxClaudeSessionCwd {
  param([Parameter(Mandatory = $true)][string]$SessionFile)
  $projectKey = Split-Path -Leaf (Split-Path -Parent $SessionFile)
  foreach ($line in [System.IO.File]::ReadLines($SessionFile, [System.Text.Encoding]::UTF8)) {
    try {
      $value = $line | ConvertFrom-Json -ErrorAction Stop
      if ($value.cwd -and -not [string]::IsNullOrWhiteSpace([string]$value.cwd)) {
        $candidate = [string]$value.cwd
        if ((Get-MycmuxClaudeProjectKey $candidate) -eq $projectKey) {
          return $candidate
        }
      }
    } catch {
      continue
    }
  }
  return $null
}

function Set-MycmuxClaudeResumeLocation {
  param([Parameter(Mandatory = $true)][string]$SessionId)
  $sessionFile = Find-MycmuxClaudeSessionFile $SessionId
  if ([string]::IsNullOrWhiteSpace($sessionFile)) {
    return $false
  }
  $sessionCwd = Get-MycmuxClaudeSessionCwd $sessionFile
  if ([string]::IsNullOrWhiteSpace($sessionCwd) -or -not (Test-Path -LiteralPath $sessionCwd -PathType Container)) {
    return $false
  }
  Set-Location -LiteralPath $sessionCwd
  $currentProjectDir = Get-MycmuxClaudeProjectDir
  return Test-Path -LiteralPath (Join-Path $currentProjectDir "$SessionId.jsonl")
}

function Get-MycmuxClaudeCodexProjectDir {
  $mangled = Get-MycmuxClaudeProjectKey (Get-Location).Path
  return Join-Path (Join-Path $HOME ".claude-codex\config\projects") $mangled
}

function Get-MycmuxStableSessionId {
  param([string]$ProjectDir)
  if ($env:MYCMUX_TAB_ID) {
    $candidate = $env:MYCMUX_TAB_ID
    if ([string]::IsNullOrWhiteSpace($ProjectDir) -or -not (Test-Path -LiteralPath (Join-Path $ProjectDir "$candidate.jsonl"))) {
      return $candidate
    }
  }
  while ($true) {
    $candidate = ([guid]::NewGuid()).ToString().ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($ProjectDir) -or -not (Test-Path -LiteralPath (Join-Path $ProjectDir "$candidate.jsonl"))) {
      return $candidate
    }
  }
}

function Start-MycmuxSessionTracking {
  param(
    [string]$PaneId,
    [Parameter(Mandatory = $true)][string]$Kind,
    [string]$ProjectDir
  )
  if ([string]::IsNullOrWhiteSpace($PaneId)) {
    return
  }
  $homeDir = $HOME
  # Trackers guess which log belongs to the pane just launched. A file that
  # predates the launch cannot be that log, and adopting it would bind the pane
  # to somebody else's session, so anything older than $startedAt is rejected
  # and no mapping is written. Ambiguous candidates are rejected too, because
  # a wrong mapping is worse than leaving attribution to the monitor.
  $startedAt = (Get-Date).ToUniversalTime()
  $launchCwd = (Get-Location).Path
  $runtimeDir = if ($env:MYCMUX_RUNTIME_DIR) { $env:MYCMUX_RUNTIME_DIR } else { Join-Path $homeDir ".mycmux" }
  Start-Job -ArgumentList $PaneId, $Kind, $ProjectDir, $homeDir, $startedAt, $launchCwd, $runtimeDir -ScriptBlock {
    param($PaneId, $Kind, $ProjectDir, $HomeDir, $StartedAt, $LaunchCwd, $RuntimeDir)
    Start-Sleep -Seconds 4

    function Normalize-MycmuxTrackingCwd {
      param([string]$Path)
      if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
      if ($Path -match "^/([a-zA-Z])/(.*)$") {
        $Path = ("{0}:\{1}" -f $Matches[1].ToUpperInvariant(), $Matches[2].Replace("/", "\"))
      }
      try { $Path = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path } catch {
        try { $Path = [System.IO.Path]::GetFullPath($Path) } catch { }
      }
      return $Path.Replace("/", "\").TrimEnd([char[]]@('\', '/')).ToLowerInvariant()
    }

    function Get-MycmuxTrackingCandidate {
      param($File, [string]$CandidateKind, [string]$ExpectedCwd)
      $candidateCwd = $null
      if ($CandidateKind -eq "codex") {
        $firstLine = [System.IO.File]::ReadLines($File.FullName, [System.Text.Encoding]::UTF8) | Select-Object -First 1
        try { $candidateCwd = [string](($firstLine | ConvertFrom-Json -ErrorAction Stop).payload.cwd) } catch { return $null }
      } else {
        $lineCount = 0
        foreach ($line in [System.IO.File]::ReadLines($File.FullName, [System.Text.Encoding]::UTF8)) {
          if (++$lineCount -gt 32) { break }
          try { $value = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }
          $candidateCwd = [string]$value.cwd
          if (-not [string]::IsNullOrWhiteSpace($candidateCwd)) { break }
        }
      }
      if ((Normalize-MycmuxTrackingCwd $candidateCwd) -ne $ExpectedCwd) { return $null }
      if ($CandidateKind -eq "codex") {
        $match = [regex]::Match([System.IO.Path]::GetFileNameWithoutExtension($File.Name), "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        if (-not $match.Success) { return $null }
        $sessionId = $match.Value
      } else {
        $sessionId = [System.IO.Path]::GetFileNameWithoutExtension($File.Name)
      }
      if ([string]::IsNullOrWhiteSpace($sessionId)) { return $null }
      return [pscustomobject]@{ SessionId = $sessionId; File = $File }
    }

    $normalizedLaunchCwd = Normalize-MycmuxTrackingCwd $LaunchCwd
    if ([string]::IsNullOrWhiteSpace($normalizedLaunchCwd)) { return }
    if ($Kind -eq "codex") {
      $searchDir = Join-Path $HomeDir ".codex\sessions"
      if (-not (Test-Path -LiteralPath $searchDir)) { return }
      $files = Get-ChildItem -LiteralPath $searchDir -Recurse -Filter "rollout-*.jsonl" -File -ErrorAction SilentlyContinue
    } else {
      if ([string]::IsNullOrWhiteSpace($ProjectDir) -or -not (Test-Path -LiteralPath $ProjectDir)) { return }
      $files = Get-ChildItem -LiteralPath $ProjectDir -Filter "*.jsonl" -File -ErrorAction SilentlyContinue
    }

    $candidates = @($files |
      Where-Object { $_.LastWriteTimeUtc -ge $StartedAt } |
      ForEach-Object { Get-MycmuxTrackingCandidate $_ $Kind $normalizedLaunchCwd } |
      Where-Object { $null -ne $_ })
    $mapDir = Join-Path $RuntimeDir "pane-sessions"
    $claimedSessionIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    if (Test-Path -LiteralPath $mapDir) {
      foreach ($mapFile in Get-ChildItem -LiteralPath $mapDir -Filter "*.txt" -File -ErrorAction SilentlyContinue) {
        if ($mapFile.BaseName -eq $PaneId) { continue }
        try { $mapping = [System.IO.File]::ReadAllText($mapFile.FullName, [System.Text.Encoding]::UTF8).Trim() } catch { continue }
        if ($mapping -match '^(?:claude|codex|claude-codex):(.+)$') { [void]$claimedSessionIds.Add($Matches[1]) }
      }
    }
    $remainingCandidates = @($candidates |
      Where-Object { -not $claimedSessionIds.Contains($_.SessionId) })
    if ($remainingCandidates.Count -ne 1) { return }
    $sessionId = $remainingCandidates[0].SessionId
    New-Item -ItemType Directory -Force -Path $mapDir | Out-Null
    $mapPath = Join-Path $mapDir "$PaneId.txt"
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($mapPath, ("{0}:{1}" -f $Kind, $sessionId) + [Environment]::NewLine, $encoding)
  } | Out-Null
}

function Start-MycmuxCommandSessionTracking {
  param(
    [Parameter(Mandatory = $true)][string]$CommandText,
    [string]$PaneId
  )
  if ([string]::IsNullOrWhiteSpace($PaneId)) {
    return
  }
  if ($CommandText -like "*claude-codex*") {
    Start-MycmuxSessionTracking $PaneId "claude-codex" (Get-MycmuxClaudeCodexProjectDir)
  } elseif (($CommandText -eq "claude" -or $CommandText.StartsWith("claude ")) -and $CommandText -notmatch "(^|\s)--session-id(=|\s)") {
    Start-MycmuxSessionTracking $PaneId "claude" (Get-MycmuxClaudeProjectDir)
  } elseif ($CommandText -eq "grok" -or $CommandText.StartsWith("grok ")) {
    # Grok receives an explicit id before launch; its log format is not tracked here.
    return
  } elseif ($CommandText -like "*codex*") {
    Start-MycmuxSessionTracking $PaneId "codex" $null
  }
}

function Test-MycmuxClaudeNeedsNewSessionId {
  param([Parameter(Mandatory = $true)][string]$CommandText)
  $trimmed = $CommandText.Trim()
  if (-not ($trimmed -eq "claude" -or $trimmed.StartsWith("claude "))) {
    return $false
  }
  # Every alternative needs the `$` anchor: menu entries end with a bare `--resume`,
  # and without it the guard missed them and injected a fresh --session-id into a
  # resume launch.
  return $trimmed -notmatch "(^|\s)(--resume(=|\s|$)|--continue(=|\s|$)|--session-id(=|\s|$)|-r(=|\s|$))"
}

function Add-MycmuxClaudeSessionIdToCommandText {
  param([Parameter(Mandatory = $true)][string]$CommandText)
  if (-not (Test-MycmuxClaudeNeedsNewSessionId $CommandText)) {
    return $CommandText
  }
  $projectDir = Get-MycmuxClaudeProjectDir
  $sid = Get-MycmuxStableSessionId $projectDir
  if ([string]::IsNullOrWhiteSpace($sid)) {
    return $CommandText
  }
  Write-MycmuxSessionMapping $env:MYCMUX_PANE_SESSION_ID "claude" $sid
  return "claude --session-id $sid$($CommandText.Substring(6))"
}

function Add-MycmuxClaudeSessionIdToCommandArray {
  param([Parameter(Mandatory = $true)][string[]]$Command)
  $commandText = $Command -join " "
  if (-not (Test-MycmuxClaudeNeedsNewSessionId $commandText)) {
    return $Command
  }
  $projectDir = Get-MycmuxClaudeProjectDir
  $sid = Get-MycmuxStableSessionId $projectDir
  if ([string]::IsNullOrWhiteSpace($sid)) {
    return $Command
  }
  Write-MycmuxSessionMapping $env:MYCMUX_PANE_SESSION_ID "claude" $sid
  if ($Command.Count -gt 1) {
    return @("claude", "--session-id", $sid) + $Command[1..($Command.Count - 1)]
  }
  return @("claude", "--session-id", $sid)
}

# Grok stores one directory per conversation under a percent-encoded cwd bucket:
# ~/.grok/sessions/C%3A%5CUsers%5C.../<session-id>/. Handing it an id that already
# has a directory makes it exit at once with "Session ID is already in use", so
# every candidate is checked against all buckets first.
function Test-MycmuxGrokSessionIdTaken {
  param([Parameter(Mandatory = $true)][string]$SessionId)
  if ([string]::IsNullOrWhiteSpace($SessionId)) {
    return $true
  }
  $root = Join-Path $HOME ".grok\sessions"
  if (-not (Test-Path -LiteralPath $root)) {
    return $false
  }
  foreach ($bucket in Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue) {
    if (Test-Path -LiteralPath (Join-Path $bucket.FullName $SessionId)) {
      return $true
    }
  }
  return $false
}

# MYCMUX_TAB_ID stays the same for the life of a tab, so a second grok launch in
# that tab would collide with the first one. Fall back to fresh UUIDs then.
function Get-MycmuxGrokSessionId {
  if ($env:MYCMUX_TAB_ID -and -not (Test-MycmuxGrokSessionIdTaken $env:MYCMUX_TAB_ID)) {
    return $env:MYCMUX_TAB_ID
  }
  while ($true) {
    $candidate = ([guid]::NewGuid()).ToString().ToLowerInvariant()
    if (-not (Test-MycmuxGrokSessionIdTaken $candidate)) {
      return $candidate
    }
  }
}

function Test-MycmuxGrokNeedsNewSessionId {
  param([Parameter(Mandatory = $true)][string]$CommandText)
  $trimmed = $CommandText.Trim()
  if (-not ($trimmed -eq "grok" -or $trimmed.StartsWith("grok "))) {
    return $false
  }
  return $trimmed -notmatch "(^|\s)(--resume(=|\s|$)|--continue(=|\s|$)|--session-id(=|\s|$)|-r(=|\s|$)|-c(=|\s|$)|-s(=|\s|$))"
}

function Add-MycmuxGrokSessionIdToCommandText {
  param([Parameter(Mandatory = $true)][string]$CommandText)
  if (-not (Test-MycmuxGrokNeedsNewSessionId $CommandText)) {
    return $CommandText
  }
  $sid = Get-MycmuxGrokSessionId
  if ([string]::IsNullOrWhiteSpace($sid)) {
    return $CommandText
  }
  Write-MycmuxSessionMapping $env:MYCMUX_PANE_SESSION_ID "grok" $sid
  return "grok --session-id $sid$($CommandText.Substring(4))"
}

function Add-MycmuxGrokSessionIdToCommandArray {
  param([Parameter(Mandatory = $true)][string[]]$Command)
  $commandText = $Command -join " "
  if (-not (Test-MycmuxGrokNeedsNewSessionId $commandText)) {
    return $Command
  }
  $sid = Get-MycmuxGrokSessionId
  if ([string]::IsNullOrWhiteSpace($sid)) {
    return $Command
  }
  Write-MycmuxSessionMapping $env:MYCMUX_PANE_SESSION_ID "grok" $sid
  if ($Command.Count -gt 1) {
    return @("grok", "--session-id", $sid) + $Command[1..($Command.Count - 1)]
  }
  return @("grok", "--session-id", $sid)
}

function Get-MycmuxCommandLeaf {
  param([Parameter(Mandatory = $true)][string]$Command)
  return (Split-Path -Leaf $Command) -replace '\.(exe|cmd|bat|com)$', ''
}

function Test-MycmuxColorSensitiveAgentLeaf {
  param([Parameter(Mandatory = $true)][string]$Leaf)
  return (Get-MycmuxCommandLeaf $Leaf) -in @("agy", "antigravity", "gemini")
}

function Invoke-MycmuxWithNoColorGuard {
  param(
    [Parameter(Mandatory = $true)][string]$Leaf,
    [Parameter(Mandatory = $true)][scriptblock]$Action
  )
  # agy (Antigravity CLI) hardcodes light-background ANSI/256-color escapes and
  # never queries the terminal background (OSC 11); mycmux's ANSI theme cannot
  # patch the truecolor/256-color output it emits directly, and agy has no
  # --theme/--no-color flag (confirmed on agy 1.1.11). NO_COLOR=1 is the only
  # known mitigation. Unlike launcher.sh (which execs into a fresh shell after
  # the command finishes), this host runs -NoExit and stays the same process,
  # so a leaked $env:NO_COLOR would keep suppressing colors after agy exits —
  # always restore the previous value in finally.
  if (-not (Test-MycmuxColorSensitiveAgentLeaf $Leaf)) {
    & $Action
    return
  }
  $hadPrevious = Test-Path Env:\NO_COLOR
  $previous = $env:NO_COLOR
  $env:NO_COLOR = "1"
  try {
    & $Action
  } finally {
    if ($hadPrevious) { $env:NO_COLOR = $previous }
    else { Remove-Item Env:\NO_COLOR -ErrorAction SilentlyContinue }
  }
}

# --- Launch spec (model / effort) --------------------------------------------
# The GUI's New Workspace dialog and this launcher's own model menu both end up
# here, so a fresh start (menu pick or MYCMUX_LAUNCH_TARGET) turns a model and an
# effort into the right flags in one place. Resume and handoff are deliberately
# left alone: they continue a session that already has a model, and launcher.sh
# runs those through their own exec paths, so applying it here would make the two
# launchers behave differently.
$script:MycmuxLaunchModel = ""
$script:MycmuxLaunchEffort = ""

function Get-MycmuxLaunchSpecValue {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  $trimmed = $Value.Trim()
  # The value lands on a command line, so it must not be mistakable for a flag.
  # Mirrors sanitizeLaunchSpecValue in src/lib/agentCatalog.ts.
  if ($trimmed -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { return "" }
  return $trimmed
}

# Read once at startup and clear: this host runs -NoExit and outlives the
# command it starts, so values left in the environment would silently re-apply
# the first pick to whatever is launched next.
function Read-MycmuxLaunchSpecFromEnv {
  $script:MycmuxLaunchModel = Get-MycmuxLaunchSpecValue $env:MYCMUX_LAUNCH_MODEL
  $script:MycmuxLaunchEffort = Get-MycmuxLaunchSpecValue $env:MYCMUX_LAUNCH_EFFORT
  Remove-Item Env:\MYCMUX_LAUNCH_MODEL -ErrorAction SilentlyContinue
  Remove-Item Env:\MYCMUX_LAUNCH_EFFORT -ErrorAction SilentlyContinue
}

function Add-MycmuxLaunchSpecToCommandArray {
  param([string[]]$Command)
  if (-not $Command -or $Command.Count -eq 0) { return $Command }
  $model = $script:MycmuxLaunchModel
  $effort = $script:MycmuxLaunchEffort
  if (-not $model -and -not $effort) { return $Command }

  $leaf = Get-MycmuxCommandLeaf $Command[0]
  $extra = @()
  if ($leaf -eq "claude" -or $leaf -eq "claude-codex") {
    if ($model) { $extra += @("--model", $model) }
    if ($effort) { $extra += @("--effort", $effort) }
  } elseif ($leaf -eq "codex") {
    if ($model) { $extra += @("--model", $model) }
    # codex has no native effort flag; reasoning effort is a config override.
    if ($effort) { $extra += @("-c", "model_reasoning_effort=$effort") }
  } elseif ($leaf -eq "grok") {
    if ($model) { $extra += @("--model", $model) }
    if ($effort) { $extra += @("--reasoning-effort", $effort) }
  } elseif ($leaf -eq "agy") {
    if ($model) { $extra += @("--model", $model) }
    if ($effort) { $extra += @("--effort", $effort) }
  } else {
    return $Command
  }
  if ($extra.Count -eq 0) { return $Command }

  # Flags go right after the executable, never at the end: `codex resume <id>`
  # takes a positional argument that a trailing flag would swallow.
  $rest = @()
  if ($Command.Count -gt 1) { $rest = $Command[1..($Command.Count - 1)] }
  return @($Command[0]) + $extra + $rest
}

function Invoke-MycmuxCommandArray {
  param([Parameter(Mandatory = $true)][string[]]$Command)
  if ($Command.Count -eq 0) {
    return
  }
  if (($Command -join " ") -like "*fugu*") {
    Import-MycmuxUserEnvIfMissing "FUGU_API_KEY"
  }
  $exe = $Command[0]
  $args = @()
  if ($Command.Count -gt 1) {
    $args = $Command[1..($Command.Count - 1)]
  }
  & $exe @args
}

function Invoke-MycmuxHandoffFromEnv {
  if (-not $env:MYCMUX_HANDOFF) {
    return $false
  }
  $handoffFile = $env:MYCMUX_HANDOFF_PROMPT_FILE
  $bootstrap = "Handoff from previous session. Read `"$handoffFile`" and continue from where it left off."
  # A handoff pane starts a brand new agent session, so it must get its own id
  # the same way the normal launch path does. Writing the *source* pane id here
  # (the old "<kind>-handoff:<pane>" mapping) left the pane with no real session
  # id, so restore fell back to `--continue` and adopted another tab's
  # conversation in the same cwd. Mirrors the handoff branch in launcher.sh.
  switch -Wildcard ($env:MYCMUX_HANDOFF) {
    "claude" {
      $sid = Get-MycmuxStableSessionId (Get-MycmuxClaudeProjectDir)
      if ([string]::IsNullOrWhiteSpace($sid)) {
        Start-MycmuxSessionTracking $env:MYCMUX_PANE_SESSION_ID "claude" (Get-MycmuxClaudeProjectDir)
        Invoke-MycmuxCommandArray -Command @("claude", "--allow-dangerously-skip-permissions", "--permission-mode", "auto", $bootstrap)
      } else {
        Write-MycmuxSessionMapping $env:MYCMUX_PANE_SESSION_ID "claude" $sid
        Invoke-MycmuxCommandArray -Command @("claude", "--session-id", $sid, "--allow-dangerously-skip-permissions", "--permission-mode", "auto", $bootstrap)
      }
      return $true
    }
    "codex" {
      # codex has no --session-id flag, so the real id can only be learned after
      # the fact from the rollout log it writes.
      Start-MycmuxSessionTracking $env:MYCMUX_PANE_SESSION_ID "codex" $null
      Invoke-MycmuxCommandArray -Command @("codex", "--no-alt-screen", $bootstrap)
      return $true
    }
    "grok" {
      $sid = Get-MycmuxGrokSessionId
      if ([string]::IsNullOrWhiteSpace($sid)) {
        Invoke-MycmuxCommandArray -Command @("grok", "--no-alt-screen", "--permission-mode", "bypassPermissions", $bootstrap)
      } else {
        Write-MycmuxSessionMapping $env:MYCMUX_PANE_SESSION_ID "grok" $sid
        Invoke-MycmuxCommandArray -Command @("grok", "--no-alt-screen", "--session-id", $sid, "--permission-mode", "bypassPermissions", $bootstrap)
      }
      return $true
    }
    "claude-codex" {
      Start-MycmuxSessionTracking $env:MYCMUX_PANE_SESSION_ID "claude-codex" (Get-MycmuxClaudeCodexProjectDir)
      Invoke-MycmuxCommandArray -Command @("claude-codex", $bootstrap)
      return $true
    }
  }
  return $true
}

function Invoke-MycmuxResumeFromEnv {
  if (-not $env:MYCMUX_RESUME) {
    return $false
  }
  switch -Wildcard ($env:MYCMUX_RESUME) {
    "claude-codex*" {
      if ($env:MYCMUX_SESSION_ID) {
        if ($env:MYCMUX_RESUME_FORK -eq "1") {
          Start-MycmuxSessionTracking $env:MYCMUX_PANE_SESSION_ID "claude-codex" (Get-MycmuxClaudeCodexProjectDir)
          Invoke-MycmuxCommandArray -Command @("claude-codex", "--resume", $env:MYCMUX_SESSION_ID, "--fork-session")
        } else {
          Write-MycmuxSessionMapping $env:MYCMUX_PANE_SESSION_ID "claude-codex" $env:MYCMUX_SESSION_ID
          Invoke-MycmuxCommandArray -Command @("claude-codex", "--resume", $env:MYCMUX_SESSION_ID)
        }
      } else {
        Start-MycmuxSessionTracking $env:MYCMUX_PANE_SESSION_ID "claude-codex" (Get-MycmuxClaudeCodexProjectDir)
        Invoke-MycmuxCommandArray -Command @("claude-codex", "--continue")
      }
      return $true
    }
    "claude*" {
      if ($env:MYCMUX_SESSION_ID) {
        if (Set-MycmuxClaudeResumeLocation $env:MYCMUX_SESSION_ID) {
          if ($env:MYCMUX_RESUME_FORK -eq "1") {
            Start-MycmuxSessionTracking $env:MYCMUX_PANE_SESSION_ID "claude" (Get-MycmuxClaudeProjectDir)
            Invoke-MycmuxCommandArray -Command @("claude", "--dangerously-skip-permissions", "--permission-mode", "bypassPermissions", "--resume", $env:MYCMUX_SESSION_ID, "--fork-session")
          } else {
            Write-MycmuxSessionMapping $env:MYCMUX_PANE_SESSION_ID "claude" $env:MYCMUX_SESSION_ID
            Invoke-MycmuxCommandArray -Command @("claude", "--dangerously-skip-permissions", "--permission-mode", "bypassPermissions", "--resume", $env:MYCMUX_SESSION_ID)
          }
        } else {
          Start-MycmuxSessionTracking $env:MYCMUX_PANE_SESSION_ID "claude" (Get-MycmuxClaudeProjectDir)
          Invoke-MycmuxCommandArray -Command @("claude", "--dangerously-skip-permissions", "--permission-mode", "bypassPermissions", "--continue")
        }
      } else {
        Start-MycmuxSessionTracking $env:MYCMUX_PANE_SESSION_ID "claude" (Get-MycmuxClaudeProjectDir)
        Invoke-MycmuxCommandArray -Command @("claude", "--dangerously-skip-permissions", "--permission-mode", "bypassPermissions", "--continue")
      }
      return $true
    }
    "codex*" {
      if ($env:MYCMUX_SESSION_ID) {
        Write-MycmuxSessionMapping $env:MYCMUX_PANE_SESSION_ID "codex" $env:MYCMUX_SESSION_ID
        Invoke-MycmuxCommandArray -Command @("codex", "resume", "--no-alt-screen", $env:MYCMUX_SESSION_ID)
      } else {
        Start-MycmuxSessionTracking $env:MYCMUX_PANE_SESSION_ID "codex" $null
        Invoke-MycmuxCommandArray -Command @("codex", "resume", "--no-alt-screen", "--last")
      }
      return $true
    }
    "grok*" {
      if ($env:MYCMUX_SESSION_ID) {
        if ($env:MYCMUX_RESUME_FORK -eq "1") {
          Invoke-MycmuxCommandArray -Command @("grok", "--no-alt-screen", "--resume", $env:MYCMUX_SESSION_ID, "--fork-session")
        } else {
          Write-MycmuxSessionMapping $env:MYCMUX_PANE_SESSION_ID "grok" $env:MYCMUX_SESSION_ID
          Invoke-MycmuxCommandArray -Command @("grok", "--no-alt-screen", "--resume", $env:MYCMUX_SESSION_ID)
        }
      } else {
        Invoke-MycmuxCommandArray -Command @("grok", "--no-alt-screen", "--continue")
      }
      return $true
    }
  }
  return $true
}

$Options = @(
  New-MycmuxOption "Claude Code" @("claude", "--allow-dangerously-skip-permissions", "--permission-mode", "auto") "claude" "claude"
  New-MycmuxOption "Codex" @("codex", "--no-alt-screen") "codex" "codex"
  New-MycmuxOption "claude-codex (Codex Models)" @("claude-codex", "--backend", "gpt") "claude-codex" "claude-codex"
  New-MycmuxOption "Grok Build" @("grok", "--no-alt-screen", "--permission-mode", "auto") "grok" "grok"
  New-MycmuxOption "claude-codex (Open Models)" @("claude-codex", "--backend", "fcc") "claude-codex" "claude-codex-open"
  # Gemini CLI was sunset for individual accounts on 2026-06-18; agy (Antigravity CLI) replaces it
  New-MycmuxOption "Antigravity (agy)" @("agy") $null "agy"
  # Not processes: these open a web tab through the socket, handled before exec.
  New-MycmuxOption "ChatGPT (Web)" @("__web_chatgpt__") $null
  New-MycmuxOption "Gemini (Web)" @("__web_gemini__") $null
  New-MycmuxOption "Grok (Web)" @("__web_grok__") $null
  New-MycmuxOption "Claude.ai (Web)" @("__web_claude__") $null
  New-MycmuxOption "NotebookLM (Web)" @("__web_notebooklm__") $null
  New-MycmuxOption "Claude Code (resume)" @("claude", "--allow-dangerously-skip-permissions", "--permission-mode", "auto", "--resume") "claude"
  New-MycmuxOption "Codex (resume)" @("codex", "resume", "--no-alt-screen") "codex"
  New-MycmuxOption "claude-codex (resume)" @("claude-codex", "--resume") "claude-codex"
  New-MycmuxOption "Grok Build (resume)" @("grok", "--no-alt-screen", "--resume") "grok"
  New-MycmuxOption "Custom..." @("__custom__") $null
)

function New-MycmuxModelChoice {
  param([Parameter(Mandatory = $true)][string]$Label, [Parameter(Mandatory = $true)][string]$Value)
  [pscustomobject]@{ Label = $Label; Value = $Value }
}

# What the launch-spec menu offers per target. Mirrors AGENT_CATALOG in
# src/lib/agentCatalog.ts -- tests/test_launcher_catalog_contract.py fails when
# the two lists drift, which is the whole reason the GUI list is a catalog now.
$ClaudeModels = @(
  New-MycmuxModelChoice "Fable (flagship)" "fable"
  New-MycmuxModelChoice "Opus" "opus"
  New-MycmuxModelChoice "Sonnet" "sonnet"
  New-MycmuxModelChoice "Haiku" "haiku"
)
$CodexModels = @(
  New-MycmuxModelChoice "Astra (flagship)" "gpt-6-astra"
  New-MycmuxModelChoice "Sol (5.6 fallback)" "gpt-5.6-sol"
  New-MycmuxModelChoice "Terra (standard)" "gpt-5.6-terra"
  New-MycmuxModelChoice "Luna (light)" "gpt-5.6-luna"
)
$AgyModels = @(
  New-MycmuxModelChoice "Gemini 3.1 Pro (High)" "gemini-3.1-pro-high"
  New-MycmuxModelChoice "Gemini 3.1 Pro (Low)" "gemini-3.1-pro-low"
  New-MycmuxModelChoice "Gemini 3.8 Flash (High)" "gemini-3.8-flash-high"
  New-MycmuxModelChoice "Gemini 3.8 Flash (Medium)" "gemini-3.8-flash-medium"
  New-MycmuxModelChoice "Gemini 3.8 Flash (Low)" "gemini-3.8-flash-low"
  New-MycmuxModelChoice "Claude Opus 4.6 (Thinking)" "claude-opus-4-6-thinking"
  New-MycmuxModelChoice "Claude Sonnet 4.6 (Thinking)" "claude-sonnet-4-6"
)
$ClaudeEfforts = @("low", "medium", "high", "xhigh", "max")
$CodexEfforts = @("none", "low", "medium", "high", "xhigh", "max", "ultra")
$ShortEfforts = @("low", "medium", "high")

$LaunchSpecCatalog = @{
  "claude" = [pscustomobject]@{ Models = $ClaudeModels; Efforts = $ClaudeEfforts }
  "codex" = [pscustomobject]@{ Models = $CodexModels; Efforts = $CodexEfforts }
  "claude-codex" = [pscustomobject]@{ Models = $CodexModels; Efforts = $ClaudeEfforts }
  # grok publishes no model id list, and the fcc backend serves whatever open
  # models the account has: type one in rather than picking from a stale list.
  "grok" = [pscustomobject]@{ Models = @(); Efforts = $ShortEfforts }
  "claude-codex-open" = [pscustomobject]@{ Models = @(); Efforts = $ClaudeEfforts }
  "agy" = [pscustomobject]@{ Models = $AgyModels; Efforts = $ShortEfforts }
}

# Index-based, so inserting an option shifts everything after it. The two Fugu
# entries were dropped on 2026-08-29, ChatGPT (Web) took a slot after agy, and
# on 2026-09-03 four more web entries landed next to it -- every index below
# the web block moved by four.
$LaunchTargets = @{
  "claude" = $Options[0]
  "codex" = $Options[1]
  "claude-codex" = $Options[2]
  "grok" = $Options[3]
  "claude-codex-open" = $Options[4]
  "fcc" = $Options[4]
  "fcc-claude" = $Options[4]
  "agy" = $Options[5]
  # "gemini" stays on the Antigravity CLI: the web tab is "web-gemini".
  "gemini" = $Options[5]
  "antigravity" = $Options[5]
  "chatgpt" = $Options[6]
  "web-chatgpt" = $Options[6]
  "web-gemini" = $Options[7]
  "gemini-web" = $Options[7]
  "web-grok" = $Options[8]
  "grok-web" = $Options[8]
  "web-claude" = $Options[9]
  "claude-web" = $Options[9]
  "claude-ai" = $Options[9]
  "web-notebooklm" = $Options[10]
  "notebooklm" = $Options[10]
  "claude-resume" = $Options[11]
  "codex-resume" = $Options[12]
  "claude-codex-resume" = $Options[13]
  "grok-resume" = $Options[14]
  "custom" = $Options[15]
}

function Invoke-MycmuxCustomCommand {
  Clear-Host
  Write-Host "  Command: (e.g. claude --resume sid:xxx, codex resume --last)"
  Write-Host ""
  $cmd = Read-Host "  >"
  if ([string]::IsNullOrWhiteSpace($cmd)) {
    return
  }
  $cmd = Add-MycmuxClaudeSessionIdToCommandText $cmd
  $cmd = Add-MycmuxGrokSessionIdToCommandText $cmd
  Start-MycmuxCommandSessionTracking $cmd $env:MYCMUX_PANE_SESSION_ID
  $leaf = ($cmd -split '\s+', 2)[0]
  Invoke-MycmuxWithNoColorGuard -Leaf $leaf -Action { Invoke-Expression $cmd }
}

function Invoke-MycmuxWebTab {
  param([Parameter(Mandatory = $true)][string]$Preset)

  # A web tab is not a process, so there is nothing to exec here. Ask the
  # mycmux backend over the socket to open one in place of this tab: every other
  # launcher entry replaces the shell with the program picked, and web-open
  # --replace-anchor is how a tab that cannot host a PTY does the same. spawn
  # without --split lands on pane.spawn_tab, which has no web branch.
  Clear-Host
  $cli = Join-Path $HOME "cmux-for-linux-dev-master\scripts\mycmux_agent_cli.py"
  if (-not (Test-Path $cli)) {
    Write-Host "  mycmux_agent_cli.py was not found:"
    Write-Host "    $cli"
    Write-Host ""
    Write-Host "  Press any key to return to the shell."
    [void][Console]::ReadKey($true)
    return
  }

  Write-Host "  Opening the $Preset web tab..."
  $prevEncoding = $env:PYTHONIOENCODING
  $env:PYTHONIOENCODING = "utf-8"
  try {
    $output = & python $cli web-open --preset $Preset --replace-anchor 2>&1
    $code = $LASTEXITCODE
  } finally {
    $env:PYTHONIOENCODING = $prevEncoding
  }

  if ($code -ne 0) {
    # Never swallow the reason: a silent no-op reads as "the launcher is broken".
    Write-Host ""
    Write-Host "  Could not open the web tab (exit $code):"
    foreach ($line in @($output)) { Write-Host "    $line" }
    Write-Host ""
    Write-Host "  Press any key to return to the shell."
    [void][Console]::ReadKey($true)
  }
}

function Invoke-MycmuxOption {
  param([Parameter(Mandatory = $true)]$Option)

  if ($null -eq $Option.Command) {
    return
  }

  if ($Option.Command[0] -eq "__custom__") {
    Invoke-MycmuxCustomCommand
    return
  }

  # One arm per pseudo command on purpose: a menu entry with no arm is a dead
  # button, and tests/test_web_pane_contract.py checks these pair up by name.
  if ($Option.Command[0] -eq "__web_chatgpt__") {
    Invoke-MycmuxWebTab "chatgpt"
    return
  }
  if ($Option.Command[0] -eq "__web_gemini__") {
    Invoke-MycmuxWebTab "gemini"
    return
  }
  if ($Option.Command[0] -eq "__web_grok__") {
    Invoke-MycmuxWebTab "grok"
    return
  }
  if ($Option.Command[0] -eq "__web_claude__") {
    Invoke-MycmuxWebTab "claude"
    return
  }
  if ($Option.Command[0] -eq "__web_notebooklm__") {
    Invoke-MycmuxWebTab "notebooklm"
    return
  }

  Clear-Host
  if ($Option.RequiredCommand -and -not (Test-MycmuxCommand $Option.RequiredCommand)) {
    Write-Host "  $($Option.RequiredCommand) was not found on PATH."
    Write-Host ""
    Write-Host "  Install it or choose another launcher item."
    Write-Host "  Press any key to return to the shell."
    [void][Console]::ReadKey($true)
    return
  }

  Write-Host "  Starting $($Option.Label)..."
  Write-Host ""
  if (($Option.Command -join " ") -like "*fugu*") {
    Import-MycmuxUserEnvIfMissing "FUGU_API_KEY"
  }
  $command = Add-MycmuxClaudeSessionIdToCommandArray $Option.Command
  $command = Add-MycmuxGrokSessionIdToCommandArray $command
  $command = Add-MycmuxLaunchSpecToCommandArray $command
  $exe = $command[0]
  $args = @()
  if ($command.Count -gt 1) {
    $args = $command[1..($command.Count - 1)]
  }
  Start-MycmuxCommandSessionTracking ($command -join " ") $env:MYCMUX_PANE_SESSION_ID
  Invoke-MycmuxWithNoColorGuard -Leaf $exe -Action { & $exe @args }
}

function Draw-MycmuxMenu {
  param([Parameter(Mandatory = $true)][int]$Selected)
  Clear-Host
  Write-Host ""
  Write-Host "  Launch:"
  Write-Host ""
  for ($i = 0; $i -lt $Options.Count; $i++) {
    $num = $i + 1
    if ($i -eq $Selected) {
      Write-Host ("> {0}. {1}" -f $num, $Options[$i].Label)
    } else {
      Write-Host ("  {0}. {1}" -f $num, $Options[$i].Label)
    }
  }
  Write-Host ""
  Write-Host "  Up/Down or j/k move  Enter/number select  -> model  / custom  q shell"
}

# --- Launch-spec menu (model, then effort) ------------------------------------
# Reached with Right or m from the main menu, never by Enter or a number: the
# existing keys must start what they have always started. Each list leads with
# "(default)", so Enter twice is the same launch as before.

$MYCMUX_SPEC_DEFAULT = "__default__"
$MYCMUX_SPEC_TYPE_IN = "__type__"

# "" = nothing typed, take the default. $null = refused, go back to the list.
# launcher.sh's __spec_menu draws the same distinction; keep them in step.
function Read-MycmuxTypedSpecValue {
  param([Parameter(Mandatory = $true)][string]$Prompt)
  Clear-Host
  Write-Host ""
  Write-Host ("  {0}" -f $Prompt)
  Write-Host ""
  $typed = Read-Host "  >"
  if (-not $typed -or -not $typed.Trim()) { return "" }
  $value = Get-MycmuxLaunchSpecValue $typed
  if (-not $value) {
    Write-Host ""
    Write-Host "  Refused: start with a letter or digit, then letters, digits, . _ - only."
    Start-Sleep -Milliseconds 1200
    return $null
  }
  return $value
}

# Returns the chosen value ("" for the default), or $null when the user backs
# out with Esc / Left / q.
function Show-MycmuxSpecMenu {
  param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Choices,
    [string]$Note
  )
  $rows = @(, [pscustomobject]@{ Label = "(default)"; Value = $MYCMUX_SPEC_DEFAULT })
  foreach ($choice in $Choices) { $rows += $choice }
  $rows += [pscustomobject]@{ Label = "Type it in..."; Value = $MYCMUX_SPEC_TYPE_IN }

  $selected = 0
  while ($true) {
    Clear-Host
    Write-Host ""
    Write-Host ("  {0}" -f $Title)
    if ($Note) { Write-Host ("  {0}" -f $Note) }
    Write-Host ""
    for ($i = 0; $i -lt $rows.Count; $i++) {
      $num = $i + 1
      $suffix = ""
      if ($rows[$i].Value -notin @($MYCMUX_SPEC_DEFAULT, $MYCMUX_SPEC_TYPE_IN) -and $rows[$i].Label -ne $rows[$i].Value) {
        $suffix = "  ($($rows[$i].Value))"
      }
      $line = "{0} {1}. {2}{3}" -f $(if ($i -eq $selected) { ">" } else { " " }), $num, $rows[$i].Label, $suffix
      Write-Host $line
    }
    Write-Host ""
    Write-Host "  Up/Down or j/k move  Enter/number select  Esc back"

    $key = [Console]::ReadKey($true)
    if ($key.Key -eq [ConsoleKey]::UpArrow -or $key.KeyChar -eq "k") {
      $selected--
      if ($selected -lt 0) { $selected = $rows.Count - 1 }
      continue
    }
    if ($key.Key -eq [ConsoleKey]::DownArrow -or $key.KeyChar -eq "j") {
      $selected++
      if ($selected -ge $rows.Count) { $selected = 0 }
      continue
    }
    if ($key.Key -eq [ConsoleKey]::Escape -or $key.Key -eq [ConsoleKey]::LeftArrow -or $key.KeyChar -eq "q") {
      return $null
    }
    if ($key.KeyChar -match "^[1-9]$") {
      $index = [int]::Parse([string]$key.KeyChar) - 1
      if ($index -lt $rows.Count) { $selected = $index } else { continue }
    } elseif ($key.Key -ne [ConsoleKey]::Enter -and $key.Key -ne [ConsoleKey]::RightArrow) {
      continue
    }

    $value = $rows[$selected].Value
    if ($value -eq $MYCMUX_SPEC_DEFAULT) { return "" }
    if ($value -eq $MYCMUX_SPEC_TYPE_IN) {
      $typed = Read-MycmuxTypedSpecValue $Title
      if ($null -eq $typed) { continue }
      return $typed
    }
    return $value
  }
}

# Fills in the model / effort for one menu row. $false means the user backed out
# and the main menu should stay open.
function Invoke-MycmuxLaunchSpecMenu {
  param([Parameter(Mandatory = $true)]$Option)
  if (-not $Option.Target -or -not $LaunchSpecCatalog.ContainsKey($Option.Target)) {
    return $false
  }
  $spec = $LaunchSpecCatalog[$Option.Target]

  $model = Show-MycmuxSpecMenu -Title ("{0} - model" -f $Option.Label) -Choices $spec.Models
  if ($null -eq $model) { return $false }

  $note = if ($model) { "model: $model" } else { "model: (default)" }
  $effortChoices = @()
  foreach ($effort in $spec.Efforts) {
    $effortChoices += [pscustomobject]@{ Label = $effort; Value = $effort }
  }
  $effort = Show-MycmuxSpecMenu -Title ("{0} - effort" -f $Option.Label) -Choices $effortChoices -Note $note
  if ($null -eq $effort) { return $false }

  $script:MycmuxLaunchModel = $model
  $script:MycmuxLaunchEffort = $effort
  return $true
}

Read-MycmuxLaunchSpecFromEnv

if (Invoke-MycmuxHandoffFromEnv) {
  return
}

if (Invoke-MycmuxResumeFromEnv) {
  return
}

if ($env:MYCMUX_LAUNCH_TARGET -and $LaunchTargets.ContainsKey($env:MYCMUX_LAUNCH_TARGET)) {
  Invoke-MycmuxOption $LaunchTargets[$env:MYCMUX_LAUNCH_TARGET]
  return
}

$selected = 0
while ($true) {
  Draw-MycmuxMenu $selected
  $key = [Console]::ReadKey($true)

  if ($key.Key -eq [ConsoleKey]::UpArrow -or $key.KeyChar -eq "k") {
    $selected--
    if ($selected -lt 0) { $selected = $Options.Count - 1 }
    continue
  }

  if ($key.Key -eq [ConsoleKey]::DownArrow -or $key.KeyChar -eq "j") {
    $selected++
    if ($selected -ge $Options.Count) { $selected = 0 }
    continue
  }

  # Right or m picks a model and an effort for this row before launching it.
  # Enter and the number keys are deliberately untouched: they have to start
  # what they have always started, at whatever the CLI defaults to.
  if ($key.Key -eq [ConsoleKey]::RightArrow -or $key.Key -eq [ConsoleKey]::M) {
    if (Invoke-MycmuxLaunchSpecMenu $Options[$selected]) { break }
    continue
  }

  if ($key.Key -eq [ConsoleKey]::Enter) {
    break
  }

  if ($key.Key -eq [ConsoleKey]::Q -or $key.KeyChar -eq "q") {
    Clear-Host
    return
  }

  if ($key.KeyChar -eq "/") {
    $selected = $Options.Count - 1
    break
  }

  if ($key.KeyChar -eq "0") {
    if ($Options.Count -ge 10) {
      $selected = 9
      break
    }
  }

  if ($key.KeyChar -match "^[1-9]$") {
    $index = [int]::Parse([string]$key.KeyChar) - 1
    if ($index -lt $Options.Count) {
      $selected = $index
      break
    }
  }
}

Invoke-MycmuxOption $Options[$selected]

$localRuntimeDir = if ($env:MYCMUX_RUNTIME_DIR) { $env:MYCMUX_RUNTIME_DIR } else { Join-Path $HOME ".mycmux" }
$localHook = Join-Path $localRuntimeDir "bin\launcher.local.ps1"
if (Test-Path $localHook) { . $localHook }
