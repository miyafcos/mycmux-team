[CmdletBinding()]
param([Parameter(Mandatory=$true)][int]$TargetPid,
      [Parameter(Mandatory=$true)][string]$Output,
      [int]$Samples=181)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$process = Get-Process -Id $TargetPid
$expected = Join-Path $env:LOCALAPPDATA 'mycmux\mycmux.exe'
if ($process.Path -ne $expected) { throw 'PDH target is not the installed production process' }
if (Test-Path -LiteralPath $Output) { throw 'Refusing to overwrite PDH evidence' }
$utf8 = New-Object System.Text.UTF8Encoding($false)
$writer = New-Object System.IO.StreamWriter($Output,$false,$utf8)
try {
  $paths = @('\Process(mycmux*)\ID Process','\Process(mycmux*)\IO Read Bytes/sec','\Process(mycmux*)\IO Write Bytes/sec')
  Get-Counter -Counter $paths -SampleInterval 10 -MaxSamples $Samples | ForEach-Object {
    $counter = $_
    $identity = $counter.CounterSamples | Where-Object { $_.Path.EndsWith('\id process') -and [int]$_.CookedValue -eq $TargetPid } | Select-Object -First 1
    if (-not $identity) { throw 'Production PID disappeared from PDH instances' }
    $prefix = $identity.Path.Substring(0,$identity.Path.LastIndexOf('\')+1)
    $selected = @($counter.CounterSamples | Where-Object { $_.Path.StartsWith($prefix) } | Select-Object Path,CookedValue)
    $writer.WriteLine((@{timestamp=$counter.Timestamp.ToString('o');samples=$selected} | ConvertTo-Json -Depth 5 -Compress))
    $writer.Flush()
  }
} finally { $writer.Dispose() }
