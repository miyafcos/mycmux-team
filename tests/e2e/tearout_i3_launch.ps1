param([string]$Name, [string]$Exe, [int]$Port)
$ErrorActionPreference = 'Stop'
if ($Name -notmatch '^[A-Za-z0-9_-]{1,64}$') { throw 'Invalid isolated profile' }
foreach ($item in @(Get-ChildItem Env:)) {
  if ($item.Name -match '^(CLAUDE|MYCMUX_|BASH_FUNC_|CODEX_|FUGU_|OPENAI_|ANTHROPIC_)') {
    Remove-Item -LiteralPath "Env:$($item.Name)" -ErrorAction SilentlyContinue
  }
}
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port --remote-allow-origins=*"
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $env:LOCALAPPDATA "com.miyazaki.mycmux\EBWebView-$Name"
New-Item -ItemType Directory -Path $env:WEBVIEW2_USER_DATA_FOLDER -Force | Out-Null
Start-Process -FilePath $Exe -ArgumentList @('--profile', $Name) -WorkingDirectory (Split-Path -Parent $Exe) -WindowStyle Hidden
