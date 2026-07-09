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
  $mapDir = Join-Path $HOME ".mycmux\pane-sessions"
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
  $cwd = ConvertTo-MycmuxProjectPath (Get-Location).Path
  $mangled = $cwd -replace "[:\\/]", "-"
  return Join-Path (Join-Path $HOME ".claude\projects") $mangled
}

function Get-MycmuxClaudeCodexProjectDir {
  $cwd = ConvertTo-MycmuxProjectPath (Get-Location).Path
  $mangled = $cwd -replace "[:\\/]", "-"
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
  Start-Job -ArgumentList $PaneId, $Kind, $ProjectDir, $homeDir -ScriptBlock {
    param($PaneId, $Kind, $ProjectDir, $HomeDir)
    Start-Sleep -Seconds 4
    if ($Kind -eq "codex") {
      $searchDir = Join-Path $HomeDir ".codex\sessions"
      if (-not (Test-Path -LiteralPath $searchDir)) { return }
      $latest = Get-ChildItem -LiteralPath $searchDir -Recurse -Filter "rollout-*.jsonl" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
      if ($null -eq $latest) { return }
      $match = [regex]::Match([System.IO.Path]::GetFileNameWithoutExtension($latest.Name), "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
      if (-not $match.Success) { return }
      $sessionId = $match.Value
    } else {
      if ([string]::IsNullOrWhiteSpace($ProjectDir) -or -not (Test-Path -LiteralPath $ProjectDir)) { return }
      $latest = Get-ChildItem -LiteralPath $ProjectDir -Filter "*.jsonl" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
      if ($null -eq $latest) { return }
      $sessionId = [System.IO.Path]::GetFileNameWithoutExtension($latest.Name)
    }
    if ([string]::IsNullOrWhiteSpace($sessionId)) { return }
    $mapDir = Join-Path $HomeDir ".mycmux\pane-sessions"
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
  return $trimmed -notmatch "(^|\s)(--resume(=|\s)|--continue(=|\s)|--session-id(=|\s)|-r(=|\s|$))"
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
  switch -Wildcard ($env:MYCMUX_HANDOFF) {
    "claude" {
      Write-MycmuxSessionMapping $env:MYCMUX_PANE_SESSION_ID "claude-handoff" $env:MYCMUX_HANDOFF_FROM_SESSION
      Invoke-MycmuxCommandArray -Command @("claude", "--allow-dangerously-skip-permissions", "--permission-mode", "auto", $bootstrap)
      return $true
    }
    "codex" {
      Write-MycmuxSessionMapping $env:MYCMUX_PANE_SESSION_ID "codex-handoff" $env:MYCMUX_HANDOFF_FROM_SESSION
      Invoke-MycmuxCommandArray -Command @("codex", "--no-alt-screen", $bootstrap)
      return $true
    }
    "claude-codex" {
      Write-MycmuxSessionMapping $env:MYCMUX_PANE_SESSION_ID "claude-codex-handoff" $env:MYCMUX_HANDOFF_FROM_SESSION
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
        Write-MycmuxSessionMapping $env:MYCMUX_PANE_SESSION_ID "claude-codex" $env:MYCMUX_SESSION_ID
        Invoke-MycmuxCommandArray -Command @("claude-codex", "--resume", $env:MYCMUX_SESSION_ID)
      } else {
        Start-MycmuxSessionTracking $env:MYCMUX_PANE_SESSION_ID "claude-codex" (Get-MycmuxClaudeCodexProjectDir)
        Invoke-MycmuxCommandArray -Command @("claude-codex", "--continue")
      }
      return $true
    }
    "claude*" {
      if ($env:MYCMUX_SESSION_ID) {
        Write-MycmuxSessionMapping $env:MYCMUX_PANE_SESSION_ID "claude" $env:MYCMUX_SESSION_ID
        $projectDir = Get-MycmuxClaudeProjectDir
        if (Test-Path -LiteralPath (Join-Path $projectDir "$($env:MYCMUX_SESSION_ID).jsonl")) {
          Invoke-MycmuxCommandArray -Command @("claude", "--dangerously-skip-permissions", "--permission-mode", "bypassPermissions", "--resume", $env:MYCMUX_SESSION_ID)
        } else {
          Start-MycmuxSessionTracking $env:MYCMUX_PANE_SESSION_ID "claude" $projectDir
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
  }
  return $true
}

$Options = @(
  New-MycmuxOption "Claude Code" @("claude", "--allow-dangerously-skip-permissions", "--permission-mode", "auto") "claude"
  New-MycmuxOption "Codex" @("codex", "--no-alt-screen") "codex"
  New-MycmuxOption "claude-codex" @("claude-codex") "claude-codex"
  New-MycmuxOption "Claude Code (dangerous)" @("claude", "--dangerously-skip-permissions", "--permission-mode", "bypassPermissions") "claude"
  New-MycmuxOption "Codex (dangerous)" @("codex", "--no-alt-screen", "--dangerously-bypass-approvals-and-sandbox") "codex"
  New-MycmuxOption "claude-codex (dangerous)" @("claude-codex", "--dangerously-skip-permissions", "--permission-mode", "bypassPermissions") "claude-codex"
  New-MycmuxOption "Claude Code (resume)" @("claude", "--allow-dangerously-skip-permissions", "--permission-mode", "auto", "--resume") "claude"
  New-MycmuxOption "Codex (resume)" @("codex", "resume", "--no-alt-screen") "codex"
  New-MycmuxOption "claude-codex (resume)" @("claude-codex", "--resume") "claude-codex"
  New-MycmuxOption "Codex (Fugu Ultra)" @("codex", "--no-alt-screen", "--profile", "fugu-ultra") "codex"
  New-MycmuxOption "claude-codex (Fugu)" @("claude-codex", "--backend", "fugu") "claude-codex"
  New-MycmuxOption "Custom..." @("__custom__") $null
)

$LaunchTargets = @{
  "claude" = $Options[0]
  "codex" = $Options[1]
  "claude-codex" = $Options[2]
  "claude-dangerous" = $Options[3]
  "codex-dangerous" = $Options[4]
  "claude-codex-dangerous" = $Options[5]
  "claude-resume" = $Options[6]
  "codex-resume" = $Options[7]
  "claude-codex-resume" = $Options[8]
  "codex-fugu-ultra" = $Options[9]
  "claude-codex-fugu" = $Options[10]
  "custom" = $Options[11]
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
  Start-MycmuxCommandSessionTracking $cmd $env:MYCMUX_PANE_SESSION_ID
  Invoke-Expression $cmd
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
  $exe = $command[0]
  $args = @()
  if ($command.Count -gt 1) {
    $args = $command[1..($command.Count - 1)]
  }
  Start-MycmuxCommandSessionTracking ($command -join " ") $env:MYCMUX_PANE_SESSION_ID
  & $exe @args
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

$localHook = Join-Path $HOME ".mycmux\bin\launcher.local.ps1"
if (Test-Path $localHook) { . $localHook }
