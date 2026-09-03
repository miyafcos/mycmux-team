#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Version,
  [switch]$SetPassword,
  [switch]$SkipTests,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$configPath = Join-Path $repoRoot "src-tauri\tauri.conf.json"
$packagePath = Join-Path $repoRoot "package.json"
$keyPath = "C:\Users\miyaz\.tauri\mycmux-updater.key"
$passwordPath = "C:\Users\miyaz\.tauri\mycmux-updater.pass"
$sourceRepo = "miyafcos/mycmux"
$targetRepo = "miyafcos/mycmux-team"
$feedUrl = "https://github.com/miyafcos/mycmux-team/releases/download/mycmux-personal-updater/latest.json"

function Write-Stage {
  param([Parameter(Mandatory = $true)][string]$Message)
  Write-Host "=== $Message ==="
}

function Invoke-NativeVisible {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $previousPreference = $ErrorActionPreference
  try {
    # PowerShell 5.1 can promote native stderr to NativeCommandError under Stop.
    $ErrorActionPreference = "Continue"
    & $FilePath @Arguments
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }

  if ($exitCode -ne 0) {
    throw "$Label に失敗しました (exit code $exitCode)。"
  }
}

function Invoke-NativeCapture {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = @(& $FilePath @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }

  if ($exitCode -ne 0) {
    throw "$Label に失敗しました (exit code $exitCode)。"
  }

  return (($output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine).Trim()
}

function Test-NativeSuccess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $FilePath @Arguments *> $null
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }

  return ($exitCode -eq 0)
}

function Get-ExistingReleaseUrl {
  param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string]$Tag
  )

  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = @(& gh api "repos/$Repo/releases/tags/$Tag" --jq ".html_url" 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }

  $outputText = (($output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine).Trim()
  if ($exitCode -eq 0) {
    return $outputText
  }
  if ($outputText -match "HTTP 404") {
    return $null
  }
  throw "GitHub Release の存在確認に失敗しました (exit code $exitCode)。`n$outputText"
}

function ConvertTo-PlainText {
  param([Parameter(Mandatory = $true)][Security.SecureString]$SecureValue)

  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Save-SigningPassword {
  if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) {
    throw "署名鍵が見つかりません: $keyPath"
  }

  Write-Stage "署名パスワードを検証"
  $securePassword = Read-Host "署名パスワード" -AsSecureString
  $plainPassword = $null
  $temporaryPayload = [System.IO.Path]::GetTempFileName()
  $temporarySignature = "$temporaryPayload.sig"

  try {
    $plainPassword = ConvertTo-PlainText -SecureValue $securePassword
    [System.IO.File]::WriteAllBytes($temporaryPayload, [byte[]](1, 2, 3, 4))

    # Pass the password through the environment, never argv: a command line is
    # readable by any process on the machine while the signer runs.
    $previousPreference = $ErrorActionPreference
    $previousSignPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    try {
      $ErrorActionPreference = "Continue"
      $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $plainPassword
      & npx tauri signer sign -f $keyPath $temporaryPayload *> $null
      $signExitCode = $LASTEXITCODE
    } finally {
      $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $previousSignPassword
      $ErrorActionPreference = $previousPreference
    }

    if ($signExitCode -ne 0 -or -not (Test-Path -LiteralPath $temporarySignature -PathType Leaf)) {
      throw "署名パスワードが鍵と一致しません。保存しませんでした。"
    }

    $encryptedPassword = ConvertFrom-SecureString -SecureString $securePassword
    $passwordDirectory = Split-Path -Parent $passwordPath
    if (-not (Test-Path -LiteralPath $passwordDirectory -PathType Container)) {
      New-Item -ItemType Directory -Path $passwordDirectory | Out-Null
    }
    $utf8Bom = New-Object System.Text.UTF8Encoding($true)
    [System.IO.File]::WriteAllText($passwordPath, $encryptedPassword, $utf8Bom)
    Write-Host "署名パスワードを DPAPI で保存しました: $passwordPath"
  } finally {
    $plainPassword = $null
    try {
      if (Test-Path -LiteralPath $temporarySignature) {
        Remove-Item -LiteralPath $temporarySignature -Force
      }
    } finally {
      if (Test-Path -LiteralPath $temporaryPayload) {
        Remove-Item -LiteralPath $temporaryPayload -Force
      }
    }
  }
}

function Initialize-MsvcEnvironment {
  Write-Stage "MSVC 環境を初期化"
  $vswhere = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
  $vsInstall = $null
  if (Test-Path -LiteralPath $vswhere -PathType Leaf) {
    $vsInstall = (Invoke-NativeCapture -FilePath $vswhere -Arguments @("-latest", "-property", "installationPath") -Label "Visual Studio の検索").Trim()
  }

  if (-not $vsInstall) {
    $candidates = @(
      "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools",
      "C:\Program Files\Microsoft Visual Studio\2022\BuildTools",
      "C:\Program Files\Microsoft Visual Studio\2022\Community",
      "C:\Program Files\Microsoft Visual Studio\2022\Professional",
      "C:\Program Files\Microsoft Visual Studio\2022\Enterprise"
    )
    foreach ($candidate in $candidates) {
      if (Test-Path -LiteralPath (Join-Path $candidate "VC\Auxiliary\Build\vcvarsall.bat") -PathType Leaf) {
        $vsInstall = $candidate
        break
      }
    }
  }

  if (-not $vsInstall) {
    throw "Visual Studio Build Tools が見つかりません。"
  }

  $vcvars = Join-Path $vsInstall "VC\Auxiliary\Build\vcvarsall.bat"
  if (-not (Test-Path -LiteralPath $vcvars -PathType Leaf)) {
    throw "vcvarsall.bat が見つかりません: $vcvars"
  }

  $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH;C:\Program Files (x86)\Microsoft Visual Studio\Installer"
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $vcOutput = @(& cmd.exe /c "`"$vcvars`" x64 && set" 2>$null)
    $vcExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }

  if ($vcExitCode -ne 0) {
    throw "vcvarsall.bat の実行に失敗しました (exit code $vcExitCode)。"
  }

  foreach ($line in $vcOutput) {
    if ($line -match "^([^=]+)=(.*)$") {
      [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
    }
  }
  Write-Host "MSVC 環境を読み込みました: $vsInstall"
}

function Assert-ReleaseGuards {
  Write-Stage "リリース前ガードを確認"

  foreach ($commandName in @("git", "gh", "npx", "npm", "python")) {
    $null = Get-Command $commandName -ErrorAction Stop
  }

  $branch = Invoke-NativeCapture -FilePath "git" -Arguments @("rev-parse", "--abbrev-ref", "HEAD") -Label "ブランチ確認"
  if ($branch -ne "master") {
    # A release may also run from a detached worktree that already contains
    # master. That is how one session ships while another holds the main tree
    # mid-implementation. The guarantee is unchanged: everything master has is
    # in what we are about to build, and the clean-tree check below still runs.
    $containsMaster = $false
    if ($branch -eq "HEAD") {
      # A non-zero exit is the answer here, not a failure, so this one asks git
      # directly instead of going through the throwing helper.
      & git merge-base --is-ancestor master HEAD 2>$null
      $containsMaster = $LASTEXITCODE -eq 0
    }
    if (-not $containsMaster) {
      throw "master ブランチ、または master を内包する worktree で実行してください (現在: $branch)。"
    }
    Write-Host "master を内包する worktree から実行します。"
  }

  $trackedStatus = Invoke-NativeCapture -FilePath "git" -Arguments @("status", "--porcelain", "--untracked-files=no") -Label "追跡ファイル確認"
  if ($trackedStatus) {
    throw "追跡ファイルに未コミット変更があります。commit または stash 後に再実行してください。`n$trackedStatus"
  }

  $allStatus = Invoke-NativeCapture -FilePath "git" -Arguments @("status", "--porcelain", "--untracked-files=all") -Label "未追跡ファイル確認"
  $untracked = @($allStatus -split "`r?`n" | Where-Object { $_ -like "?? *" })
  if ($untracked.Count -gt 0) {
    Write-Host "許容する未追跡ファイル:"
    $untracked | ForEach-Object { Write-Host "  $_" }
  }

  $packageVersion = (Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json).version
  $tauriVersion = (Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json).version
  if ($packageVersion -ne $tauriVersion) {
    throw "package.json ($packageVersion) と tauri.conf.json ($tauriVersion) の version が一致しません。"
  }
  if ($Version -ne $packageVersion) {
    throw "指定 version ($Version) とソース version ($packageVersion) が一致しません。"
  }

  $tag = "v$Version"
  if (-not (Test-NativeSuccess -FilePath "git" -Arguments @("show-ref", "--verify", "--quiet", "refs/tags/$tag"))) {
    throw "ローカルタグ $tag が見つかりません。"
  }
  $headCommit = Invoke-NativeCapture -FilePath "git" -Arguments @("rev-parse", "HEAD") -Label "HEAD commit の確認"
  $localTagCommit = Invoke-NativeCapture -FilePath "git" -Arguments @("rev-list", "-n", "1", $tag) -Label "ローカルタグ commit の確認"
  if ($localTagCommit -ne $headCommit) {
    throw "ローカルタグ $tag は現在の HEAD を指していません (tag: $localTagCommit, HEAD: $headCommit)。新しい version/tag を作成してください。"
  }

  $remoteTagRefs = Invoke-NativeCapture -FilePath "git" -Arguments @("ls-remote", "--exit-code", "--tags", "origin", "refs/tags/$tag", "refs/tags/$tag^{}") -Label "origin タグの確認"
  $remoteTagLines = @($remoteTagRefs -split "`r?`n" | Where-Object { $_ })
  $remoteTagLine = $remoteTagLines | Where-Object { $_ -like "*refs/tags/$tag^{}" } | Select-Object -First 1
  if (-not $remoteTagLine) {
    $remoteTagLine = $remoteTagLines | Where-Object { $_ -like "*refs/tags/$tag" } | Select-Object -First 1
  }
  if (-not $remoteTagLine) {
    throw "origin にタグ $tag が見つかりません。"
  }
  $remoteTagCommit = ($remoteTagLine -split "\s+")[0]
  if ($remoteTagCommit -ne $localTagCommit) {
    throw "origin のタグ $tag がローカルタグと一致しません (origin: $remoteTagCommit, local: $localTagCommit)。"
  }

  Invoke-NativeVisible -FilePath "gh" -Arguments @("auth", "status") -Label "gh 認証確認"
  foreach ($repo in @($sourceRepo, $targetRepo)) {
    $canPush = Invoke-NativeCapture -FilePath "gh" -Arguments @("api", "repos/$repo", "--jq", ".permissions.push") -Label "$repo の権限確認"
    if ($canPush.Trim().ToLowerInvariant() -ne "true") {
      throw "$repo への push 権限がありません。"
    }
  }

  if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) {
    throw "署名鍵が見つかりません: $keyPath"
  }
  Write-Host "リリース前ガード: PASS"
}

function Enable-UpdaterArtifacts {
  $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $config.bundle | Add-Member -MemberType NoteProperty -Name createUpdaterArtifacts -Value $true -Force
  $json = $config | ConvertTo-Json -Depth 100
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($configPath, $json, $utf8NoBom)
}

function Assert-BundleArtifacts {
  $bundleRoot = Join-Path $repoRoot "src-tauri\target\release\bundle"
  $script:setupPath = Join-Path $bundleRoot "nsis\mycmux_${Version}_x64-setup.exe"
  $script:setupSignaturePath = "$script:setupPath.sig"
  $script:msiPath = Join-Path $bundleRoot "msi\mycmux_${Version}_x64_en-US.msi"
  $script:msiSignaturePath = "$script:msiPath.sig"

  foreach ($artifact in @($script:setupPath, $script:setupSignaturePath, $script:msiPath, $script:msiSignaturePath)) {
    if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
      throw "必要な署名済み成果物が見つかりません: $artifact"
    }
  }
  Write-Host "署名済み成果物 4 点: PASS"
}

function New-UpdaterJson {
  param([Parameter(Mandatory = $true)][string]$OutputPath)

  $tag = "v$Version"
  $baseUrl = "https://github.com/$sourceRepo/releases/download/$tag"
  $setupSignature = (Get-Content -LiteralPath $script:setupSignaturePath -Raw -Encoding UTF8).Trim()
  $msiSignature = (Get-Content -LiteralPath $script:msiSignaturePath -Raw -Encoding UTF8).Trim()
  if (-not $setupSignature -or -not $msiSignature) {
    throw "署名ファイルが空です。"
  }

  $setupName = [System.IO.Path]::GetFileName($script:setupPath)
  $msiName = [System.IO.Path]::GetFileName($script:msiPath)
  $setupEntry = [ordered]@{ signature = $setupSignature; url = "$baseUrl/$setupName" }
  $msiEntry = [ordered]@{ signature = $msiSignature; url = "$baseUrl/$msiName" }
  $latest = [ordered]@{
    version = $Version
    notes = "mycmux personal build ($tag). See CHANGELOG.md for details."
    pub_date = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", [Globalization.CultureInfo]::InvariantCulture)
    platforms = [ordered]@{
      # The generic windows-x86_64 key is what the Tauri updater actually reads,
      # and it must stay on the NSIS setup: the installed app lives in the
      # per-user AppData\Local\mycmux path that NSIS writes. Serving the MSI here
      # would install to a different location. This mirrors the feed shipped for
      # v0.21.0, where windows-x86_64 pointed at mycmux_0.21.0_x64-setup.exe.
      "windows-x86_64" = $setupEntry
      "windows-x86_64-msi" = $msiEntry
      "windows-x86_64-nsis" = $setupEntry
    }
  }

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($OutputPath, ($latest | ConvertTo-Json -Depth 10), $utf8NoBom)
  Write-Host "latest.json を生成しました。"
}

Set-Location $repoRoot

if ($SetPassword) {
  Save-SigningPassword
  exit 0
}

if (-not (Test-Path -LiteralPath $passwordPath -PathType Leaf)) {
  throw "署名パスワードが保存されていません。先に powershell -File scripts/release-local.ps1 -SetPassword を実行してください。"
}

if (-not $Version) {
  $Version = (Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json).version
}

Assert-ReleaseGuards

$secureStoredPassword = ConvertTo-SecureString (Get-Content -LiteralPath $passwordPath -Raw -Encoding UTF8).Trim()
$plainStoredPassword = ConvertTo-PlainText -SecureValue $secureStoredPassword
$originalConfigBytes = $null
$configWasModified = $false
$latestTempDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("mycmux-release-" + [Guid]::NewGuid().ToString("N"))
$latestJsonPath = Join-Path $latestTempDirectory "latest.json"
$releaseUrl = $null
$feedVersion = $null

try {
  if (-not $SkipTests) {
    Write-Stage "TypeScript 検証"
    Invoke-NativeVisible -FilePath "npx" -Arguments @("tsc", "--noEmit") -Label "npx tsc --noEmit"
    Write-Host "TypeScript 検証: PASS"

    Write-Stage "Vitest"
    Invoke-NativeVisible -FilePath "npx" -Arguments @("vitest", "run") -Label "npx vitest run"
    Write-Host "Vitest: PASS"

    Write-Stage "Pytest"
    Invoke-NativeVisible -FilePath "python" -Arguments @("-m", "pytest", "tests/") -Label "python -m pytest tests/"
    Write-Host "Pytest: PASS"

    # cargo test --release is intentionally excluded because it is a separate,
    # long-running manual verification on this Windows host.
  } else {
    Write-Host "事前検証をスキップしました (-SkipTests)。"
  }

  if (-not $SkipBuild) {
    Write-Stage "updater 成果物を有効化"
    $originalConfigBytes = [System.IO.File]::ReadAllBytes($configPath)
    $configWasModified = $true
    Enable-UpdaterArtifacts
    Write-Host "updater 成果物の有効化: PASS"

    Initialize-MsvcEnvironment
    Write-Stage "mycmux をビルド・署名"
    $previousPrivateKey = $env:TAURI_SIGNING_PRIVATE_KEY
    $previousPrivateKeyPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    try {
      $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -LiteralPath $keyPath -Raw -Encoding UTF8
      $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $plainStoredPassword
      Invoke-NativeVisible -FilePath "npm" -Arguments @("run", "tauri", "build") -Label "npm run tauri build"
    } finally {
      $env:TAURI_SIGNING_PRIVATE_KEY = $previousPrivateKey
      $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $previousPrivateKeyPassword
    }
    Write-Host "ビルド・署名: PASS"
  } else {
    Write-Host "ビルドをスキップし、既存 bundle 成果物を使います (-SkipBuild)。"
  }

  Assert-BundleArtifacts

  New-Item -ItemType Directory -Path $latestTempDirectory | Out-Null
  New-UpdaterJson -OutputPath $latestJsonPath

  Write-Stage "GitHub Release を作成・更新"
  $tag = "v$Version"
  $releaseName = "mycmux $tag"
  $releaseBody = @"
mycmux personal build ($tag).

See ``CHANGELOG.md`` for details.

**Auto-update**: existing installations will detect this release via the in-app updater (設定 → アプリ情報 → 更新を確認).
"@
  $assets = @($script:setupPath, $script:setupSignaturePath, $script:msiPath, $script:msiSignaturePath, $latestJsonPath)

  $existingReleaseUrl = Get-ExistingReleaseUrl -Repo $sourceRepo -Tag $tag
  if ($existingReleaseUrl) {
    Invoke-NativeVisible -FilePath "gh" -Arguments @("release", "edit", $tag, "--repo", $sourceRepo, "--title", $releaseName, "--notes", $releaseBody, "--draft=false", "--prerelease=false") -Label "GitHub Release 情報の更新"
    Invoke-NativeVisible -FilePath "gh" -Arguments (@("release", "upload", $tag) + $assets + @("--repo", $sourceRepo, "--clobber")) -Label "GitHub Release 資産の差し替え"
  } else {
    Invoke-NativeVisible -FilePath "gh" -Arguments (@("release", "create", $tag) + $assets + @("--repo", $sourceRepo, "--title", $releaseName, "--notes", $releaseBody, "--verify-tag")) -Label "GitHub Release の作成"
  }
  $releaseUrl = Invoke-NativeCapture -FilePath "gh" -Arguments @("release", "view", $tag, "--repo", $sourceRepo, "--json", "url", "--jq", ".url") -Label "GitHub Release URL の確認"
  Write-Host "GitHub Release: PASS ($releaseUrl)"

  Write-Stage "公開 updater feed へミラー"
  $mirrorScript = Join-Path $PSScriptRoot "mirror-personal-updater-feed.ps1"
  Invoke-NativeVisible -FilePath "powershell.exe" -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $mirrorScript, "-SourceTag", $tag) -Label "updater feed のミラー"
  Write-Host "updater feed ミラー: PASS"

  Write-Stage "公開 updater feed を検証"
  $feedRequestUrl = "$feedUrl`?cacheBust=$([Guid]::NewGuid().ToString('N'))"
  $feed = Invoke-RestMethod -Method Get -Uri $feedRequestUrl -Headers @{ "Cache-Control" = "no-cache"; "Pragma" = "no-cache" }
  $feedVersion = [string]$feed.version
  if ($feedVersion -ne $Version) {
    throw "公開 feed の version ($feedVersion) が期待値 ($Version) と一致しません。"
  }
  Write-Host "公開 updater feed: PASS (version $feedVersion)"

  # 版数一致だけでは v0.21.16 事故 (署名鍵ローテート漏れ) を検知できない。
  # 公開 feed の全 platforms[] 署名から minisign key-id を取り出し、
  # tauri.conf.json の pubkey と一致するところまで機械検証する。
  Write-Stage "updater feed の署名 key-id を検証"
  $verifyScript = Join-Path $PSScriptRoot "verify_updater_feed.py"
  Invoke-NativeVisible -FilePath "python" -Arguments @($verifyScript, "--expect-version", $Version) -Label "updater feed の署名 key-id 検証"
  Write-Host "updater feed の署名 key-id 検証: PASS"
  # 公開ミラーはチームに配っている唯一の見える面なので、リリースのたびにここまで
  # 自動で追従させる (2026-09-02 宮崎さん指示: 配っている方はメインの copy として
  # 勝手に更新されて使えるように)。履歴は持ち込まず、master の tree だけを載せた
  # sync コミットを 1 本積む。
  Write-Stage "公開ミラーの master を同期"
  $mirrorRemote = "public"
  $remoteNames = @(Invoke-NativeCapture -FilePath "git" -Arguments @("remote") -Label "git remote の一覧") -split "\r?\n"
  if ($remoteNames -notcontains $mirrorRemote) {
    throw "git remote '$mirrorRemote' が見つかりません ($targetRepo を指す remote を追加してください)。"
  }
  Invoke-NativeVisible -FilePath "git" -Arguments @("fetch", $mirrorRemote, "master") -Label "公開ミラーの取得"
  $mirrorHead = Invoke-NativeCapture -FilePath "git" -Arguments @("rev-parse", "$mirrorRemote/master") -Label "公開ミラー HEAD の確認"
  $localTree = Invoke-NativeCapture -FilePath "git" -Arguments @("rev-parse", "master^{tree}") -Label "master tree の確認"
  $mirrorTree = Invoke-NativeCapture -FilePath "git" -Arguments @("rev-parse", "$mirrorHead^{tree}") -Label "公開ミラー tree の確認"
  if ($mirrorTree -eq $localTree) {
    Write-Host "公開ミラー: SKIP (tree は既に master と一致)"
  } else {
    $syncCommit = Invoke-NativeCapture -FilePath "git" -Arguments @("commit-tree", "master^{tree}", "-p", $mirrorHead, "-m", "sync: mycmux $tag") -Label "sync コミットの作成"
    Invoke-NativeVisible -FilePath "git" -Arguments @("push", $mirrorRemote, "${syncCommit}:refs/heads/master") -Label "公開ミラーへの push"
    # 自己申告ではなく実体で確かめる: push した commit の tree が master と同一か。
    $pushedHead = Invoke-NativeCapture -FilePath "git" -Arguments @("ls-remote", $mirrorRemote, "refs/heads/master") -Label "公開ミラー HEAD の再確認"
    if (-not ($pushedHead -like "$syncCommit*")) {
      throw "公開ミラーの master が push した commit と一致しません (remote: $pushedHead, pushed: $syncCommit)。"
    }
    Write-Host "公開ミラー: PASS (tree $localTree)"
  }

} finally {
  $plainStoredPassword = $null

  try {
    if ($configWasModified) {
      [System.IO.File]::WriteAllBytes($configPath, $originalConfigBytes)
      $previousPreference = $ErrorActionPreference
      try {
        $ErrorActionPreference = "Continue"
        & git diff --quiet -- $configPath
        $diffExitCode = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = $previousPreference
      }
      if ($diffExitCode -ne 0) {
        throw "tauri.conf.json の完全復元を確認できませんでした (git diff exit code $diffExitCode)。"
      }
      Write-Host "tauri.conf.json のバイト単位復元: PASS"
    }
  } finally {
    try {
      if (Test-Path -LiteralPath $latestJsonPath) {
        Remove-Item -LiteralPath $latestJsonPath -Force
      }
    } finally {
      if (Test-Path -LiteralPath $latestTempDirectory) {
        Remove-Item -LiteralPath $latestTempDirectory -Force
      }
    }
  }
}

Write-Host ""
Write-Host "=== ローカルリリース成功 ==="
Write-Host "Version: $Version"
Write-Host "Release: $releaseUrl"
Write-Host "Feed version: $feedVersion"
