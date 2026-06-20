$ErrorActionPreference = "Continue"

function Test-MycmuxCommand {
  param([Parameter(Mandatory = $true)][string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
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
  "custom" = $Options[9]
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

if ($env:MYCMUX_LAUNCH_TARGET -and $LaunchTargets.ContainsKey($env:MYCMUX_LAUNCH_TARGET)) {
  Invoke-MycmuxOption $LaunchTargets[$env:MYCMUX_LAUNCH_TARGET]
  return
}

$selected = 0
while ($true) {
  Draw-MycmuxMenu $selected
  $key = [Console]::ReadKey($true)
  switch ($key.Key) {
    "UpArrow" {
      $selected--
      if ($selected -lt 0) { $selected = $Options.Count - 1 }
      continue
    }
    "DownArrow" {
      $selected++
      if ($selected -ge $Options.Count) { $selected = 0 }
      continue
    }
    "Enter" {
      break
    }
    "Q" {
      Clear-Host
      return
    }
    default {
      if ($key.KeyChar -eq "j") {
        $selected++
        if ($selected -ge $Options.Count) { $selected = 0 }
        continue
      }
      if ($key.KeyChar -eq "k") {
        $selected--
        if ($selected -lt 0) { $selected = $Options.Count - 1 }
        continue
      }
      if ($key.KeyChar -eq "/") {
        $selected = 9
        break
      }
      if ($key.KeyChar -match "^[1-9]$") {
        $selected = [int]::Parse([string]$key.KeyChar) - 1
        break
      }
      if ($key.KeyChar -eq "0") {
        $selected = 9
        break
      }
    }
  }
}

Invoke-MycmuxOption $Options[$selected]
