$ErrorActionPreference = "Continue"

function Test-MycmuxCommand {
  param([Parameter(Mandatory = $true)][string]$Name)
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
    [string]$RequiredCommand
  )
  [pscustomobject]@{
    Label = $Label
    Command = $Command
    RequiredCommand = $RequiredCommand
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
  $runtimeDir = if ($env:MYCMUX_RUNTIME_DIR) { $env:MYCMUX_RUNTIME_DIR } else { Join-Path $HOME ".mycmux" }
  $mapDir = Join-Path $runtimeDir "pane-sessions"
  New-Item -ItemType Directory -Force -Path $mapDir | Out-Null
  $mapPath = Join-Path $mapDir "$PaneId.txt"
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

function Test-MycmuxColorSensitiveAgentLeaf {
  param([Parameter(Mandatory = $true)][string]$Leaf)
  $bare = (Split-Path -Leaf $Leaf) -replace '\.(exe|cmd|bat|com)$', ''
  return $bare -in @("agy", "antigravity", "gemini")
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
  New-MycmuxOption "Claude Code" @("claude", "--allow-dangerously-skip-permissions", "--permission-mode", "auto") "claude"
  New-MycmuxOption "Codex" @("codex", "--no-alt-screen") "codex"
  New-MycmuxOption "claude-codex (Codex Models)" @("claude-codex", "--backend", "gpt") "claude-codex"
  New-MycmuxOption "Grok Build" @("grok", "--no-alt-screen", "--permission-mode", "auto") "grok"
  New-MycmuxOption "Codex (Fugu Ultra)" @("codex", "--no-alt-screen", "--profile", "fugu-ultra") "codex"
  New-MycmuxOption "claude-codex (Fugu)" @("claude-codex", "--backend", "fugu") "claude-codex"
  New-MycmuxOption "claude-codex (Open Models)" @("claude-codex", "--backend", "fcc") "claude-codex"
  # Gemini CLI was sunset for individual accounts on 2026-06-18; agy (Antigravity CLI) replaces it
  New-MycmuxOption "Antigravity (agy)" @("agy") $null
  New-MycmuxOption "Claude Code (resume)" @("claude", "--allow-dangerously-skip-permissions", "--permission-mode", "auto", "--resume") "claude"
  New-MycmuxOption "Codex (resume)" @("codex", "resume", "--no-alt-screen") "codex"
  New-MycmuxOption "claude-codex (resume)" @("claude-codex", "--resume") "claude-codex"
  New-MycmuxOption "Grok Build (resume)" @("grok", "--no-alt-screen", "--resume") "grok"
  New-MycmuxOption "Custom..." @("__custom__") $null
)

$LaunchTargets = @{
  "claude" = $Options[0]
  "codex" = $Options[1]
  "claude-codex" = $Options[2]
  "grok" = $Options[3]
  "codex-fugu-ultra" = $Options[4]
  "claude-codex-fugu" = $Options[5]
  "claude-codex-open" = $Options[6]
  "fcc" = $Options[6]
  "fcc-claude" = $Options[6]
  "agy" = $Options[7]
  "gemini" = $Options[7]
  "antigravity" = $Options[7]
  "claude-resume" = $Options[8]
  "codex-resume" = $Options[9]
  "claude-codex-resume" = $Options[10]
  "grok-resume" = $Options[11]
  "custom" = $Options[12]
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

function Invoke-MycmuxOption {
  param([Parameter(Mandatory = $true)]$Option)

  if ($null -eq $Option.Command) {
    return
  }

  if ($Option.Command[0] -eq "__custom__") {
    Invoke-MycmuxCustomCommand
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
  Write-Host "  Up/Down or j/k move  Enter/number select  / custom  q shell"
}

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
