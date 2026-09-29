[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f-]{36}$')][string]$SessionId,
  [int]$Seconds = 7200,
  [ValidatePattern('^[a-zA-Z0-9_-]+$')][string]$Name = 'perf3'
)
$ErrorActionPreference = 'Stop'
$expectedRuntime = Join-Path $env:USERPROFILE (".mycmux-" + $Name)
if ($env:MYCMUX_RUNTIME_DIR -ne $expectedRuntime) { throw "Fake agent requires the $Name runtime" }
if (-not $env:MYCMUX_PANE_SESSION_ID -or $env:MYCMUX_PANE_SESSION_ID -match '[/\\]') { throw 'Missing safe pane session id' }
$project = Join-Path $env:USERPROFILE '.claude\projects\C--Users-miyaz--work-mycmux-perf3-260924-fixtures'
[IO.Directory]::CreateDirectory($project) | Out-Null
$transcript = Join-Path $project "$SessionId.jsonl"
if (Test-Path -LiteralPath $transcript) { throw 'Refusing to append to a pre-existing transcript' }
$mappingDir = Join-Path $expectedRuntime 'pane-sessions'
[IO.Directory]::CreateDirectory($mappingDir) | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
$mappingId = $env:MYCMUX_PANE_SESSION_ID
if ($mappingId.StartsWith('pty-') -and $mappingId.Length -gt 36) { $mappingId = $mappingId.Substring($mappingId.Length - 36) }
$mapping = Join-Path $mappingDir "$mappingId.txt"
if (Test-Path -LiteralPath $mapping) { Copy-Item -LiteralPath $mapping -Destination "$mapping.pre-fake-$SessionId" }
[IO.File]::WriteAllText($mapping, "claude:$SessionId", $utf8)
$parent = $null
$timer = [Diagnostics.Stopwatch]::StartNew()
$index = 0
while ($timer.Elapsed.TotalSeconds -lt $Seconds) {
  $uuid = [guid]::NewGuid().ToString()
  $text = "Synthetic perf3 line $index"
  $row = @{type='assistant'; uuid=$uuid; parentUuid=$parent; isSidechain=$false;
    timestamp=[DateTime]::UtcNow.ToString('o'); sessionId=$SessionId; cwd=$project;
    message=@{id="msg-$uuid";type='message';role='assistant';model='synthetic';
      content=@(@{type='text';text=$text});stop_reason='end_turn';
      usage=@{input_tokens=$index;output_tokens=1}}}
  [IO.File]::AppendAllText($transcript, (($row | ConvertTo-Json -Depth 10 -Compress) + "`n"), $utf8)
  [Console]::WriteLine(([char]27 + '[36m' + $text + [char]27 + '[0m'))
  $parent = $uuid
  $index++
  Start-Sleep -Milliseconds 2000
}
