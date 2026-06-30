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
  if ([string]::IsNullOrWhiteSpace($Kind)) {
    Set-Content -LiteralPath $mapPath -Value $SessionId -Encoding UTF8
  } else {
    Set-Content -LiteralPath $mapPath -Value ("{0}:{1}" -f $Kind, $SessionId) -Encoding UTF8
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
        Invoke-MycmuxCommandArray -Command @("claude-codex", "--continue")
      }
      return $true
    }
    "claude*" {
      if ($env:MYCMUX_SESSION_ID) {
        Write-MycmuxSessionMapping $env:MYCMUX_PANE_SESSION_ID "claude" $env:MYCMUX_SESSION_ID
        Invoke-MycmuxCommandArray -Command @("claude", "--dangerously-skip-permissions", "--permission-mode", "bypassPermissions", "--resume", $env:MYCMUX_SESSION_ID)
      } else {
        Invoke-MycmuxCommandArray -Command @("claude", "--dangerously-skip-permissions", "--permission-mode", "bypassPermissions", "--continue")
      }
      return $true
    }
    "codex*" {
      if ($env:MYCMUX_SESSION_ID) {
        Write-MycmuxSessionMapping $env:MYCMUX_PANE_SESSION_ID "codex" $env:MYCMUX_SESSION_ID
        Invoke-MycmuxCommandArray -Command @("codex", "resume", "--no-alt-screen", $env:MYCMUX_SESSION_ID)
      } else {
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
  $exe = $Option.Command[0]
  $args = @()
  if ($Option.Command.Count -gt 1) {
    $args = $Option.Command[1..($Option.Command.Count - 1)]
  }
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
