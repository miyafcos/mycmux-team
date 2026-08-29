[CmdletBinding()]
param(
    [ValidateSet("Validate", "Plan", "Init", "Doctor", "Run")]
    [string]$Mode = "Validate",

    [string]$TunnelId,

    [string]$TunnelClientPath = "$env:LOCALAPPDATA\mycmux-control\bin\v0.0.12\tunnel-client.exe",

    [string]$ProfileDir = "$env:LOCALAPPDATA\mycmux-control\profiles",

    [ValidatePattern("^[A-Za-z0-9._-]+$")]
    [string]$ProfileName = "mycmux-control"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Path))
}

function Get-ProfilePresent {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string]$Name
    )
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
        return $false
    }
    return [bool](Get-ChildItem -LiteralPath $Directory -File -ErrorAction SilentlyContinue |
        Where-Object { $_.BaseName -eq $Name -and $_.Extension -in ".yaml", ".yml" } |
        Select-Object -First 1)
}

function Assert-ApiKeyReference {
    if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) {
        throw "CONTROL_PLANE_API_KEY is not set. Store the runtime key in that environment variable; do not pass it on the command line."
    }
}

function Invoke-TunnelClient {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    & $script:TunnelClient @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "tunnel-client exited with code $LASTEXITCODE."
    }
}

$TunnelClient = Get-FullPath -Path $TunnelClientPath
$ResolvedProfileDir = Get-FullPath -Path $ProfileDir
$PluginRoot = Get-FullPath -Path (Split-Path -Parent $PSScriptRoot)
$ServerPath = Get-FullPath -Path (Join-Path $PluginRoot "server\mycmux_control_server.py")

if (-not (Test-Path -LiteralPath $TunnelClient -PathType Leaf)) {
    throw "tunnel-client was not found at $TunnelClient"
}
if (-not (Test-Path -LiteralPath $ServerPath -PathType Leaf)) {
    throw "mycmux MCP server was not found at $ServerPath"
}

$PythonCommand = Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1
$PythonPath = Get-FullPath -Path $PythonCommand.Source
$McpCommand = '"{0}" "{1}"' -f $PythonPath, $ServerPath
$ProfilePresent = Get-ProfilePresent -Directory $ResolvedProfileDir -Name $ProfileName
$ApiKeyPresent = -not [string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)

if ($Mode -in "Plan", "Init") {
    if ([string]::IsNullOrWhiteSpace($TunnelId) -or $TunnelId -notmatch "^tunnel_[A-Za-z0-9]+$") {
        throw "TunnelId must use the form tunnel_ followed by letters and digits."
    }
}

$TunnelIdSuffix = if ($TunnelId) {
    $visibleLength = [Math]::Min(6, $TunnelId.Length)
    "***" + $TunnelId.Substring($TunnelId.Length - $visibleLength)
} else {
    $null
}

if ($Mode -eq "Validate") {
    $VersionOutput = (& $TunnelClient --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "tunnel-client version check failed with code $LASTEXITCODE."
    }
    [ordered]@{
        ok = $true
        mode = $Mode
        tunnelClient = $TunnelClient
        tunnelClientVersion = $VersionOutput
        python = $PythonPath
        mcpServer = $ServerPath
        profileDirectory = $ResolvedProfileDir
        profileName = $ProfileName
        profilePresent = $ProfilePresent
        apiKeyPresent = $ApiKeyPresent
        apiKeySource = "env:CONTROL_PLANE_API_KEY"
        healthListenAddress = "127.0.0.1:0"
        maxConcurrentMcpRequests = 1
    } | ConvertTo-Json -Depth 4 -Compress
    exit 0
}

if ($Mode -eq "Plan") {
    [ordered]@{
        ok = $true
        mode = $Mode
        tunnelId = $TunnelIdSuffix
        tunnelClient = $TunnelClient
        profileDirectory = $ResolvedProfileDir
        profileName = $ProfileName
        profilePresent = $ProfilePresent
        mcpCommand = $McpCommand
        apiKeySource = "env:CONTROL_PLANE_API_KEY"
        healthListenAddress = "127.0.0.1:0"
        maxConcurrentMcpRequests = 1
        remoteAdminUiEnabled = $false
        rawHttpLoggingEnabled = $false
    } | ConvertTo-Json -Depth 4 -Compress
    exit 0
}

if ($Mode -eq "Init") {
    New-Item -ItemType Directory -Path $ResolvedProfileDir -Force | Out-Null
    $InitArguments = @(
        "init",
        "--sample", "sample_mcp_stdio_local",
        "--profile", $ProfileName,
        "--profile-dir", $ResolvedProfileDir,
        "--tunnel-id", $TunnelId,
        "--mcp-command", $McpCommand,
        "--control-plane-api-key-ref", "env:CONTROL_PLANE_API_KEY",
        "--health-listen-addr", "127.0.0.1:0"
    )
    $null = & $TunnelClient @InitArguments
    if ($LASTEXITCODE -ne 0) {
        throw "tunnel-client init failed with code $LASTEXITCODE."
    }
    [ordered]@{
        ok = $true
        mode = $Mode
        tunnelId = $TunnelIdSuffix
        profileDirectory = $ResolvedProfileDir
        profileName = $ProfileName
        apiKeySource = "env:CONTROL_PLANE_API_KEY"
    } | ConvertTo-Json -Depth 3 -Compress
    exit 0
}

Assert-ApiKeyReference

if ($Mode -eq "Doctor") {
    Invoke-TunnelClient -Arguments @(
        "doctor",
        "--profile", $ProfileName,
        "--profile-dir", $ResolvedProfileDir,
        "--control-plane.api-key", "env:CONTROL_PLANE_API_KEY",
        "--health.listen-addr", "127.0.0.1:0",
        "--mcp.max-concurrent-requests", "1",
        "--explain"
    )
    exit 0
}

$RuntimeDir = Get-FullPath -Path (Join-Path (Split-Path -Parent $ResolvedProfileDir) "runtime")
$LogDir = Get-FullPath -Path (Join-Path (Split-Path -Parent $ResolvedProfileDir) "logs")
New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

Invoke-TunnelClient -Arguments @(
    "run",
    "--profile", $ProfileName,
    "--profile-dir", $ResolvedProfileDir,
    "--control-plane.api-key", "env:CONTROL_PLANE_API_KEY",
    "--health.listen-addr", "127.0.0.1:0",
    "--health.url-file", (Join-Path $RuntimeDir "health-url.txt"),
    "--pid.file", (Join-Path $RuntimeDir "tunnel-client.pid"),
    "--mcp.max-concurrent-requests", "1",
    "--log.format", "json",
    "--log.file", (Join-Path $LogDir "tunnel-client.jsonl")
)
