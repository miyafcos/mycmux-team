# DEPRECATED in v0.7.0: agent_kind/cwd are now persisted directly via SocketListener.toConfig().
[CmdletBinding(DefaultParameterSetName = 'DryRun')]
param(
    [Parameter(ParameterSetName = 'DryRun')]
    [switch]$DryRun,

    [Parameter(ParameterSetName = 'Apply', Mandatory = $true)]
    [switch]$Apply,

    [switch]$VerifyJsonl,

    [string]$DataJsonPath = (Join-Path $env:APPDATA 'com.miyazaki.mycmux\data.json'),

    [string]$PaneSessionsDir = (Join-Path $HOME '.mycmux\pane-sessions'),

    [switch]$Lite
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Format-NullableValue {
    param(
        [AllowNull()]
        [object]$Value
    )

    if ($null -eq $Value) {
        return '<null>'
    }

    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) {
        return '""'
    }

    return $text
}

function Write-Utf8NoBom {
    param(
        [string]$Path,
        [string]$Content
    )

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Get-JsonFile {
    param(
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "JSON file not found: $Path"
    }

    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) {
        throw "JSON file is empty: $Path"
    }

    return $raw | ConvertFrom-Json
}

function Get-CacheFileName {
    param(
        [string]$WorkspaceId,
        [string]$PaneId,
        [string]$TabId
    )

    return "pty-$WorkspaceId-$PaneId-$TabId.txt"
}

function ConvertTo-ClaudeProjectDirName {
    param(
        [AllowNull()]
        [string]$Cwd
    )

    if ([string]::IsNullOrWhiteSpace($Cwd)) {
        return $null
    }

    $trimmed = $Cwd.Trim()
    $trimmed = $trimmed -replace '[\\/]+$', ''
    if ([string]::IsNullOrWhiteSpace($trimmed)) {
        return $null
    }

    return ($trimmed -replace '[:\\/]', '-')
}

function Parse-AgentSessionMapping {
    param(
        [string]$Contents,
        [string]$SourcePath
    )

    $trimmed = $Contents.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed)) {
        Write-Warning "Empty pane-session cache skipped: $SourcePath"
        return $null
    }

    $parts = $trimmed.Split(':', 2)
    if ($parts.Count -eq 2) {
        $kind = $parts[0].Trim()
        $sessionId = $parts[1].Trim()
        if ($kind -notin @('claude', 'codex', 'claude-codex')) {
            Write-Warning "Unknown agent kind '$kind' skipped: $SourcePath"
            return $null
        }
        if ([string]::IsNullOrWhiteSpace($sessionId)) {
            Write-Warning "Empty session id skipped: $SourcePath"
            return $null
        }

        return [pscustomobject]@{
            AgentKind     = $kind
            SessionId     = $sessionId
            WasLegacyBare = $false
            Raw           = $trimmed
        }
    }

    # Legacy cache lines were written as a bare Claude session id.
    return [pscustomobject]@{
        AgentKind     = 'claude'
        SessionId     = $trimmed
        WasLegacyBare = $true
        Raw           = $trimmed
    }
}

function Get-PaneSessionCache {
    param(
        [string]$DirectoryPath
    )

    if (-not (Test-Path -LiteralPath $DirectoryPath)) {
        throw "Pane sessions directory not found: $DirectoryPath"
    }

    $pattern = '^pty-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.txt$'
    $cache = @{}
    $invalidCount = 0

    Get-ChildItem -LiteralPath $DirectoryPath -File -Filter 'pty-*.txt' | ForEach-Object {
        if ($_.Name -notmatch $pattern) {
            Write-Warning "Unexpected pane-session filename skipped: $($_.Name)"
            $invalidCount++
            return
        }

        $mapping = Parse-AgentSessionMapping -Contents (Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8) -SourcePath $_.FullName
        if ($null -eq $mapping) {
            $invalidCount++
            return
        }

        $cache[$_.Name] = $mapping
    }

    return [pscustomobject]@{
        Map          = $cache
        InvalidCount = $invalidCount
    }
}

function Test-ClaudeJsonlExists {
    param(
        [string]$SessionId,
        [AllowNull()]
        [string]$Cwd,
        [string]$ProjectsRoot,
        [hashtable]$Memo
    )

    $cacheKey = '{0}|{1}' -f $Cwd, $SessionId
    if ($Memo.ContainsKey($cacheKey)) {
        return [bool]$Memo[$cacheKey]
    }

    if (-not (Test-Path -LiteralPath $ProjectsRoot)) {
        $Memo[$cacheKey] = $false
        return $false
    }

    $encodedDir = ConvertTo-ClaudeProjectDirName -Cwd $Cwd
    if ($encodedDir) {
        $directPath = Join-Path (Join-Path $ProjectsRoot $encodedDir) "$SessionId.jsonl"
        if (Test-Path -LiteralPath $directPath) {
            $Memo[$cacheKey] = $true
            return $true
        }
    }

    $found = Get-ChildItem -LiteralPath $ProjectsRoot -Recurse -File -Filter "$SessionId.jsonl" -ErrorAction SilentlyContinue | Select-Object -First 1
    $exists = $null -ne $found
    $Memo[$cacheKey] = $exists
    return $exists
}

function Add-FieldChange {
    param(
        [System.Collections.IList]$Items,
        [string]$Scope,
        [string]$Field,
        [AllowNull()]
        [object]$OldValue,
        [AllowNull()]
        [object]$NewValue
    )

    if ($OldValue -eq $NewValue) {
        return
    }

    [void]$Items.Add([pscustomobject]@{
            Scope    = $Scope
            Field    = $Field
            OldValue = $OldValue
            NewValue = $NewValue
        })
}

if ($Lite) {
    if (-not $PSBoundParameters.ContainsKey('DataJsonPath')) {
        $DataJsonPath = Join-Path $env:APPDATA 'com.miyazaki.mycmux-lite\data.json'
    }
    if (-not $PSBoundParameters.ContainsKey('PaneSessionsDir')) {
        $PaneSessionsDir = Join-Path $HOME '.mycmux-lite\pane-sessions'
    }
}

$applyMode = $PSCmdlet.ParameterSetName -eq 'Apply'
$modeLabel = if ($applyMode) { 'APPLY' } else { 'DRYRUN' }
$modeName = if ($applyMode) { 'Apply' } else { 'DryRun' }
$projectsRoot = Join-Path $HOME '.claude\projects'
$claudeJsonlMemo = @{}
$paneCacheInfo = Get-PaneSessionCache -DirectoryPath $PaneSessionsDir
$paneCache = $paneCacheInfo.Map
$data = Get-JsonFile -Path $DataJsonPath

$changes = New-Object System.Collections.ArrayList
$totalTabs = 0
$changedTabs = 0
$mirroredPanes = 0
$skipNoCache = 0
$skipJsonlMissing = 0

$workspaces = @($data.workspaces)
for ($workspaceIndex = 0; $workspaceIndex -lt $workspaces.Count; $workspaceIndex++) {
    $workspace = $workspaces[$workspaceIndex]
    $panes = @($workspace.panes)
    for ($paneIndex = 0; $paneIndex -lt $panes.Count; $paneIndex++) {
        $pane = $panes[$paneIndex]
        $tabs = @($pane.tabs)
        for ($tabIndex = 0; $tabIndex -lt $tabs.Count; $tabIndex++) {
            $tab = $tabs[$tabIndex]
            $totalTabs++

            if ([string]::IsNullOrWhiteSpace($workspace.id) -or [string]::IsNullOrWhiteSpace($pane.pane_id) -or [string]::IsNullOrWhiteSpace($tab.tab_id)) {
                Write-Warning "Skipping tab with missing ids: workspace='$($workspace.id)' pane='$($pane.pane_id)' tab='$($tab.tab_id)'"
                $skipNoCache++
                continue
            }

            $cacheFileName = Get-CacheFileName -WorkspaceId $workspace.id -PaneId $pane.pane_id -TabId $tab.tab_id
            if (-not $paneCache.ContainsKey($cacheFileName)) {
                $skipNoCache++
                continue
            }

            $mapping = $paneCache[$cacheFileName]
            $verifyCwd = if (-not [string]::IsNullOrWhiteSpace($tab.cwd)) { $tab.cwd } else { $pane.cwd }
            if ($VerifyJsonl -and $mapping.AgentKind -eq 'claude') {
                if (-not (Test-ClaudeJsonlExists -SessionId $mapping.SessionId -Cwd $verifyCwd -ProjectsRoot $projectsRoot -Memo $claudeJsonlMemo)) {
                    Write-Warning "Claude jsonl not found for $cacheFileName -> $($mapping.SessionId); skipped"
                    $skipJsonlMissing++
                    continue
                }
            }

            $newClaudeSessionId = if ($mapping.AgentKind -eq 'claude') { $mapping.SessionId } else { $null }
            $fieldChanges = New-Object System.Collections.ArrayList

            Add-FieldChange -Items $fieldChanges -Scope 'tab' -Field 'claude_session_id' -OldValue $tab.claude_session_id -NewValue $newClaudeSessionId
            Add-FieldChange -Items $fieldChanges -Scope 'tab' -Field 'agent_kind' -OldValue $tab.agent_kind -NewValue $mapping.AgentKind
            Add-FieldChange -Items $fieldChanges -Scope 'tab' -Field 'agent_session_id' -OldValue $tab.agent_session_id -NewValue $mapping.SessionId

            $paneChanged = $false
            if ($pane.active_tab_id -eq $tab.tab_id) {
                Add-FieldChange -Items $fieldChanges -Scope 'pane' -Field 'claude_session_id' -OldValue $pane.claude_session_id -NewValue $newClaudeSessionId
                Add-FieldChange -Items $fieldChanges -Scope 'pane' -Field 'agent_kind' -OldValue $pane.agent_kind -NewValue $mapping.AgentKind
                Add-FieldChange -Items $fieldChanges -Scope 'pane' -Field 'agent_session_id' -OldValue $pane.agent_session_id -NewValue $mapping.SessionId
                $paneChanged = (@($fieldChanges | Where-Object { $_.Scope -eq 'pane' })).Count -gt 0
            }

            if ($fieldChanges.Count -eq 0) {
                continue
            }

            $workspaceDisplayName = $workspace.id
            if (-not [string]::IsNullOrWhiteSpace($workspace.name)) {
                $workspaceDisplayName = $workspace.name
            }

            [void]$changes.Add([pscustomobject]@{
                    WorkspaceName = $workspaceDisplayName
                    WorkspaceId   = $workspace.id
                    PaneIndex     = $paneIndex
                    TabIndex      = $tabIndex
                    CacheFileName = $cacheFileName
                    MappingKind   = $mapping.AgentKind
                    SessionId     = $mapping.SessionId
                    WasLegacyBare = $mapping.WasLegacyBare
                    FieldChanges  = @($fieldChanges)
                })

            if ($applyMode) {
                $tab.claude_session_id = $newClaudeSessionId
                $tab.agent_kind = $mapping.AgentKind
                $tab.agent_session_id = $mapping.SessionId
                if ($pane.active_tab_id -eq $tab.tab_id) {
                    $pane.claude_session_id = $newClaudeSessionId
                    $pane.agent_kind = $mapping.AgentKind
                    $pane.agent_session_id = $mapping.SessionId
                }
            }

            $changedTabs++
            if ($paneChanged) {
                $mirroredPanes++
            }
        }
    }
}

if ($changes.Count -gt 0) {
    foreach ($change in $changes) {
        $legacyNote = if ($change.WasLegacyBare) { ' [legacy bare -> claude]' } else { '' }
        Write-Output ("[{0}] {1} pane[{2}] tab[{3}] {4} => {5}:{6}{7}" -f `
                $modeLabel, `
                $change.WorkspaceName, `
                $change.PaneIndex, `
                $change.TabIndex, `
                $change.CacheFileName, `
                $change.MappingKind, `
                $change.SessionId, `
                $legacyNote)
        foreach ($fieldChange in $change.FieldChanges) {
            Write-Output ("  {0}.{1}: {2} -> {3}" -f `
                    $fieldChange.Scope, `
                    $fieldChange.Field, `
                    (Format-NullableValue -Value $fieldChange.OldValue), `
                    (Format-NullableValue -Value $fieldChange.NewValue))
        }
    }
}
else {
    Write-Output ("[{0}] No changes detected." -f $modeLabel)
}

$backupPath = $null
$tempPath = $null
if ($applyMode -and $changedTabs -gt 0) {
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupPath = '{0}.bak.{1}' -f $DataJsonPath, $timestamp
    $dataJsonDir = Split-Path -Parent $DataJsonPath
    $tempPath = Join-Path $dataJsonDir ('data.json.tmp.' + [Guid]::NewGuid().ToString('N'))
    $jsonText = $data | ConvertTo-Json -Depth 100

    try {
        Write-Utf8NoBom -Path $tempPath -Content $jsonText
        $usedFallbackWrite = $false
        try {
            [System.IO.File]::Replace($tempPath, $DataJsonPath, $backupPath, $false)
        }
        catch [System.UnauthorizedAccessException], [System.IO.IOException] {
            Copy-Item -LiteralPath $DataJsonPath -Destination $backupPath -Force
            Copy-Item -LiteralPath $tempPath -Destination $DataJsonPath -Force
            Remove-Item -LiteralPath $tempPath -Force
            $usedFallbackWrite = $true
        }
        $tempPath = $null
        Write-Output "Backup created: $backupPath"
        Write-Output "Updated data.json: $DataJsonPath"
        if ($usedFallbackWrite) {
            Write-Warning 'File.Replace was unavailable; used backup + overwrite fallback.'
        }
    }
    finally {
        if ($tempPath -and (Test-Path -LiteralPath $tempPath)) {
            Remove-Item -LiteralPath $tempPath -Force
        }
    }
}
elseif ($applyMode) {
    Write-Output 'Apply mode requested, but no writable changes were found.'
}

$skipTotal = $skipNoCache + $skipJsonlMissing
Write-Output ''
Write-Output ("Summary: target tabs {0}, changed {1}, skipped {2} (no cache {3}, jsonl missing {4})" -f `
        $totalTabs, `
        $changedTabs, `
        $skipTotal, `
        $skipNoCache, `
        $skipJsonlMissing)
Write-Output ("Pane cache files loaded: {0} (invalid skipped: {1})" -f $paneCache.Count, $paneCacheInfo.InvalidCount)
Write-Output ("Pane mirrors updated: {0}" -f $mirroredPanes)
Write-Output ("Mode: {0}" -f $modeName)
Write-Output ("DataJsonPath: {0}" -f $DataJsonPath)
Write-Output ("PaneSessionsDir: {0}" -f $PaneSessionsDir)
