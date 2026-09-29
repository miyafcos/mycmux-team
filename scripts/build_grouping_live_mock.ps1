# Windows-only: this visual fixture intentionally drives installed Microsoft
# Edge. macOS release and updater verification do not depend on this script.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $repoRoot 'vite.mock.config.ts'
$outputParent = 'C:\Users\miyaz\reports\_quick\2026-08'
$stamp = Get-Date -Format 'yyMMdd-HHmmss'
$folderPrefix = -join ([char[]]@(0x30BF, 0x30D6, 0x518D, 0x914D, 0x7F6E, 0x005F, 0x52D5, 0x304F, 0x30E2, 0x30C3, 0x30AF, 0x005F))
$outputDirectory = Join-Path $outputParent "$folderPrefix$stamp"
$indexPath = Join-Path $outputDirectory 'index.html'
$previewStep1 = Join-Path $outputDirectory 'preview_step1.png'
$previewLight = Join-Path $outputDirectory 'preview_light.png'
$previewStep2 = Join-Path $outputDirectory 'preview_step2.png'
$previewStep2Light = Join-Path $outputDirectory 'preview_step2_light.png'
$previewStep3 = Join-Path $outputDirectory 'preview_step3.png'
$previewStep3Light = Join-Path $outputDirectory 'preview_step3_light.png'
$previewStep4 = Join-Path $outputDirectory 'preview_step4.png'
$previewStep4Light = Join-Path $outputDirectory 'preview_step4_light.png'
$screenshotWaitAttempts = 150
if (Test-Path -LiteralPath $outputDirectory) {
  throw "Fresh output directory already exists: $outputDirectory"
}
Push-Location $repoRoot
try {
  & npx.cmd vite build --config $configPath --outDir $outputDirectory
  if ($LASTEXITCODE -ne 0) {
    throw "Vite build failed with exit code $LASTEXITCODE"
  }
}
finally {
  Pop-Location
}

if (-not (Test-Path -LiteralPath $indexPath -PathType Leaf)) {
  throw "index.html was not generated: $indexPath"
}

$html = Get-Content -LiteralPath $indexPath -Raw -Encoding UTF8
if ($html -match '<script\b[^>]*\bsrc=' -or $html -match '<link\b[^>]*\bhref=' -or $html -match 'https?://') {
  throw 'index.html still contains an external reference.'
}
if ($html -notmatch 'cmux-tab-grouping' -or $html -notmatch 'MYCMUX_GROUPING_LIVE_MOCK') {
  throw 'index.html does not contain the real Panel or the live mock marker.'
}

$unexpectedBundleFiles = Get-ChildItem -LiteralPath $outputDirectory -File -Recurse |
  Where-Object { $_.Extension -in @('.js', '.css') }
if ($unexpectedBundleFiles) {
  throw "External JS/CSS remains: $($unexpectedBundleFiles.FullName -join ', ')"
}

$edgeCandidates = @(
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
)
$edgePath = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $edgePath) {
  throw 'Microsoft Edge was not found.'
}

$fileUri = [System.Uri]::new($indexPath).AbsoluteUri
$edgeCommon = @(
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--run-all-compositor-stages-before-draw',
  '--virtual-time-budget=3000',
  '--window-size=1600,1000'
)
$edgeStep3 = @(
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--run-all-compositor-stages-before-draw',
  '--virtual-time-budget=8000',
  '--window-size=1600,1000'
)

function Assert-GuideAndZeroError {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Dom,
    [Parameter(Mandatory = $true)]
    [int]$Step
  )

  $operationGuide = -join ([char[]]@(0x64CD, 0x4F5C, 0x30AC, 0x30A4, 0x30C9))
  $errorLabel = -join ([char[]]@(0x30A8, 0x30E9, 0x30FC))
  if (-not $Dom.Contains("$operationGuide $Step / 4")) {
    throw "The step-$Step mock does not contain its operation guide."
  }
  if ($Dom -notmatch "<span>\s*$errorLabel\s*<strong>\s*0\s*</strong>\s*</span>") {
    throw "The step-$Step mock does not visibly report zero errors."
  }
}

function Assert-MoveEvidence {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Dom,
    [Parameter(Mandatory = $true)]
    [int]$Step
  )

  $badgeCount = [regex]::Matches($Dom, 'class="[^"]*\bcmux-tab-grouping-movebadge\b[^"]*"').Count
  $lineCount = [regex]::Matches(
    $Dom,
    '<path\b(?=[^>]*\bclass="[^"]*\bcmux-tab-grouping-line\b[^"]*")(?=[^>]*\bdata-tab-id=)[^>]*>'
  ).Count
  $arrowCount = [regex]::Matches($Dom, 'class="[^"]*\bcmux-tab-grouping-line-arrow\b[^"]*"').Count
  $startCount = [regex]::Matches($Dom, 'class="[^"]*\bcmux-tab-grouping-line-start\b[^"]*"').Count
  $visibleEndpointCount = [regex]::Matches($Dom, 'data-mock-endpoint-visible="true"').Count
  $sourceLanes = [regex]::Matches($Dom, 'data-route-source-lane="([^"]+)"') |
    ForEach-Object { $_.Groups[1].Value } |
    Select-Object -Unique
  $destinationEdges = [regex]::Matches($Dom, 'data-route-destination-edge="([^"]+)"') |
    ForEach-Object { $_.Groups[1].Value } |
    Select-Object -Unique
  if ($badgeCount -lt 1) {
    throw "The step-$Step mock does not contain a within-workspace move badge."
  }
  if ($lineCount -lt 2) {
    throw "The step-$Step mock contains fewer than two cross-workspace move lines."
  }
  if ($arrowCount -lt $lineCount -or $startCount -lt $lineCount) {
    throw "The step-$Step mock does not pin every move line with start and arrow markers."
  }
  if ($visibleEndpointCount -lt $lineCount) {
    throw "The step-$Step mock does not prove every move-line endpoint is visible in the viewport."
  }
  if ($destinationEdges.Count -lt 2) {
    throw "The step-$Step mock does not use both near and far destination edges."
  }
  if ($sourceLanes.Count -lt 2) {
    throw "The step-$Step mock does not keep the two detour source lanes distinct."
  }
}

$savedErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'SilentlyContinue'
try {
  $step1Dom = (& $edgePath @edgeCommon '--dump-dom' $fileUri 2>$null | Out-String)
  $step1ExitCode = $LASTEXITCODE
}
finally {
  $ErrorActionPreference = $savedErrorActionPreference
}
if ($step1ExitCode -ne 0 -or $step1Dom -notmatch 'data-live-mock="MYCMUX_GROUPING_LIVE_MOCK"') {
  throw 'The step-1 mock did not reach its initial state.'
}
Assert-GuideAndZeroError -Dom $step1Dom -Step 1

if (-not (Test-Path -LiteralPath $previewStep1 -PathType Leaf)) {
  & $edgePath @edgeCommon "--screenshot=$previewStep1" $fileUri
  for ($attempt = 0; $attempt -lt $screenshotWaitAttempts -and -not (Test-Path -LiteralPath $previewStep1 -PathType Leaf); $attempt++) {
    Start-Sleep -Milliseconds 100
  }
}
if (-not (Test-Path -LiteralPath $previewStep1 -PathType Leaf) -or (Get-Item -LiteralPath $previewStep1).Length -lt 10000) {
  throw 'The initial screenshot was not generated.'
}

& $edgePath @edgeCommon "--screenshot=$previewLight" "${fileUri}?theme=paper"
for ($attempt = 0; $attempt -lt $screenshotWaitAttempts -and -not (Test-Path -LiteralPath $previewLight -PathType Leaf); $attempt++) {
  Start-Sleep -Milliseconds 100
}
if (-not (Test-Path -LiteralPath $previewLight -PathType Leaf) -or (Get-Item -LiteralPath $previewLight).Length -lt 10000) {
  throw 'The light-theme screenshot was not generated.'
}

& $edgePath @edgeStep3 "--screenshot=$previewStep2" "${fileUri}?step=2"
for ($attempt = 0; $attempt -lt $screenshotWaitAttempts -and -not (Test-Path -LiteralPath $previewStep2 -PathType Leaf); $attempt++) {
  Start-Sleep -Milliseconds 100
}
if (-not (Test-Path -LiteralPath $previewStep2 -PathType Leaf) -or (Get-Item -LiteralPath $previewStep2).Length -lt 10000) {
  throw 'The step-2 screenshot was not generated.'
}

& $edgePath @edgeStep3 "--screenshot=$previewStep2Light" "${fileUri}?step=2&theme=paper"
for ($attempt = 0; $attempt -lt $screenshotWaitAttempts -and -not (Test-Path -LiteralPath $previewStep2Light -PathType Leaf); $attempt++) {
  Start-Sleep -Milliseconds 100
}
if (-not (Test-Path -LiteralPath $previewStep2Light -PathType Leaf) -or (Get-Item -LiteralPath $previewStep2Light).Length -lt 10000) {
  throw 'The light-theme step-2 screenshot was not generated.'
}

& $edgePath @edgeStep3 "--screenshot=$previewStep3" "${fileUri}?step=3"
for ($attempt = 0; $attempt -lt $screenshotWaitAttempts -and -not (Test-Path -LiteralPath $previewStep3 -PathType Leaf); $attempt++) {
  Start-Sleep -Milliseconds 100
}
if (-not (Test-Path -LiteralPath $previewStep3 -PathType Leaf) -or (Get-Item -LiteralPath $previewStep3).Length -lt 10000) {
  throw 'The step-3 screenshot was not generated.'
}

& $edgePath @edgeStep3 "--screenshot=$previewStep3Light" "${fileUri}?step=3&theme=paper"
for ($attempt = 0; $attempt -lt $screenshotWaitAttempts -and -not (Test-Path -LiteralPath $previewStep3Light -PathType Leaf); $attempt++) {
  Start-Sleep -Milliseconds 100
}
if (-not (Test-Path -LiteralPath $previewStep3Light -PathType Leaf) -or (Get-Item -LiteralPath $previewStep3Light).Length -lt 10000) {
  throw 'The light-theme step-3 screenshot was not generated.'
}

& $edgePath @edgeStep3 "--screenshot=$previewStep4" "${fileUri}?step=4"
for ($attempt = 0; $attempt -lt $screenshotWaitAttempts -and -not (Test-Path -LiteralPath $previewStep4 -PathType Leaf); $attempt++) {
  Start-Sleep -Milliseconds 100
}
if (-not (Test-Path -LiteralPath $previewStep4 -PathType Leaf) -or (Get-Item -LiteralPath $previewStep4).Length -lt 10000) {
  throw 'The step-4 screenshot was not generated.'
}

& $edgePath @edgeStep3 "--screenshot=$previewStep4Light" "${fileUri}?step=4&theme=paper"
for ($attempt = 0; $attempt -lt $screenshotWaitAttempts -and -not (Test-Path -LiteralPath $previewStep4Light -PathType Leaf); $attempt++) {
  Start-Sleep -Milliseconds 100
}
if (-not (Test-Path -LiteralPath $previewStep4Light -PathType Leaf) -or (Get-Item -LiteralPath $previewStep4Light).Length -lt 10000) {
  throw 'The light-theme step-4 screenshot was not generated.'
}

$ErrorActionPreference = 'SilentlyContinue'
try {
  $step2Dom = (& $edgePath @edgeStep3 '--dump-dom' "${fileUri}?step=2" 2>$null | Out-String)
  $step2ExitCode = $LASTEXITCODE
}
finally {
  $ErrorActionPreference = $savedErrorActionPreference
}
if ($step2ExitCode -ne 0 -or $step2Dom -notmatch 'data-mock-step="2"') {
  throw 'The step-2 mock did not reach the edit map.'
}
if ($step2Dom -notmatch 'data-error-count="0"') {
  throw 'The step-2 in-page error counter is not zero.'
}
$dragCancelHint = -join ([char[]]@(0x30C9, 0x30E9, 0x30C3, 0x30B0, 0x4E2D, 0x306B, 0x0020, 0x0045, 0x0073, 0x0063, 0x0020, 0x3092, 0x62BC, 0x3059, 0x3068, 0x4E2D, 0x65AD, 0x3067, 0x304D, 0x307E, 0x3059))
if (-not $step2Dom.Contains($dragCancelHint)) {
  throw 'The step-2 mock does not contain the drag cancellation hint.'
}
$step2GripCount = [regex]::Matches(
  $step2Dom,
  '<span[^>]*class="[^"]*cmux-tab-grouping-grip[^"]*"[^>]*aria-hidden="true"[^>]*>'
).Count
if ($step2GripCount -lt 1) {
  throw 'The step-2 edit map does not contain a rendered drag grip.'
}
Assert-GuideAndZeroError -Dom $step2Dom -Step 2

$ErrorActionPreference = 'SilentlyContinue'
try {
  $step3Dom = (& $edgePath @edgeStep3 '--dump-dom' "${fileUri}?step=3" 2>$null | Out-String)
  $step3ExitCode = $LASTEXITCODE
}
finally {
  $ErrorActionPreference = $savedErrorActionPreference
}
if ($step3ExitCode -ne 0 -or $step3Dom -notmatch 'data-mock-step="3"') {
  throw 'The step-3 mock did not reach confirmation.'
}
if ($step3Dom -notmatch 'data-error-count="0"') {
  throw 'The step-3 in-page error counter is not zero.'
}
Assert-GuideAndZeroError -Dom $step3Dom -Step 3
if ($step3Dom -notmatch '<span\b(?=[^>]*\bclass="[^"]*\bcmux-tab-grouping-workspace-color\b[^"]*")(?=[^>]*\baria-hidden="true")[^>]*>') {
  throw 'The step-3 mock does not contain workspace colour chips.'
}
if ($step3Dom -notmatch 'cmux-tab-grouping-lineage') {
  throw 'The step-3 mock does not contain the lineage preview.'
}
if ($step3Dom -notmatch '<span\b(?=[^>]*\bclass="[^"]*\bcmux-tab-grouping-live\b[^"]*")(?=[^>]*\bdata-status="working")[^>]*>') {
  throw 'The step-3 mock does not contain a working live-status badge.'
}
if ($step3Dom -notmatch 'cmux-tab-grouping-line-halo') {
  throw 'The step-3 mock does not contain a move-line halo.'
}
if ($step3Dom -notmatch 'cmux-tab-grouping-movectx') {
  throw 'The step-3 mock does not contain a persistent move context.'
}
Assert-MoveEvidence -Dom $step3Dom -Step 3

$ErrorActionPreference = 'SilentlyContinue'
try {
  $step4Dom = (& $edgePath @edgeStep3 '--dump-dom' "${fileUri}?step=4" 2>$null | Out-String)
  $step4ExitCode = $LASTEXITCODE
}
finally {
  $ErrorActionPreference = $savedErrorActionPreference
}
if ($step4ExitCode -ne 0 -or $step4Dom -notmatch 'data-mock-step="4"') {
  throw 'The step-4 mock did not reach the undo state.'
}
if ($step4Dom -notmatch 'data-error-count="0"' -or $step4Dom -notmatch 'cmux-tab-grouping-undo') {
  throw 'The step-4 mock does not contain an error-free undo bar.'
}
if ($step4Dom -notmatch 'cmux-tab-grouping-lines') {
  throw 'The step-4 mock does not retain the applied move lines.'
}
Assert-GuideAndZeroError -Dom $step4Dom -Step 4
Assert-MoveEvidence -Dom $step4Dom -Step 4

$ErrorActionPreference = 'SilentlyContinue'
try {
  $flowDom = (& $edgePath @edgeCommon '--dump-dom' "${fileUri}?selftest=1" 2>$null | Out-String)
  $flowExitCode = $LASTEXITCODE
}
finally {
  $ErrorActionPreference = $savedErrorActionPreference
}
if ($flowExitCode -ne 0 -or $flowDom -notmatch 'data-flow-check="passed"') {
  throw 'The apply, save, and undo self-test did not pass.'
}
if ($flowDom -notmatch 'data-error-count="0"') {
  throw 'The in-page error counter is not zero.'
}

Write-Output "OUTPUT_DIRECTORY=$outputDirectory"
Write-Output "INDEX_HTML=$indexPath"
Write-Output "PREVIEW_STEP1=$previewStep1"
Write-Output "PREVIEW_LIGHT=$previewLight"
Write-Output "PREVIEW_STEP2=$previewStep2"
Write-Output "PREVIEW_STEP2_LIGHT=$previewStep2Light"
Write-Output "PREVIEW_STEP3=$previewStep3"
Write-Output "PREVIEW_STEP3_LIGHT=$previewStep3Light"
Write-Output "PREVIEW_STEP4=$previewStep4"
Write-Output "PREVIEW_STEP4_LIGHT=$previewStep4Light"
Write-Output 'FLOW_CHECK=passed'
