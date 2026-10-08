[CmdletBinding()]
param(
    [ValidateSet("Validate", "Plan", "Init", "Doctor", "Run")]
    [string]$Mode = "Validate",

    [string]$TunnelId,

    [string]$TunnelClientPath = "$env:LOCALAPPDATA\mycmux-control\bin\v0.0.12\tunnel-client.exe",

    [string]$ProfileDir = "$env:LOCALAPPDATA\mycmux-control\profiles",

    [string]$ApiKeyFile = "$env:LOCALAPPDATA\mycmux-control\control-plane.key",

    [switch]$UseEnvironmentApiKey,

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
    if (-not $script:ApiKeyPresent) {
        if ($UseEnvironmentApiKey) {
            throw "CONTROL_PLANE_API_KEY is not set. Supply it in the process environment, never on the command line."
        }
        throw "Runtime key file missing: $script:ResolvedApiKeyFile. Ask the owner to save a Tunnels Read+Use key there with owner-only permissions; never pass its value on the command line."
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
$ResolvedApiKeyFile = Get-FullPath -Path $ApiKeyFile
$ApiKeyReference = if ($UseEnvironmentApiKey) { "env:CONTROL_PLANE_API_KEY" } else { "file:" + $ResolvedApiKeyFile }
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
# A detached tunnel-client has no console, so a console python.exe child gets a window of its own.
# Closing that window ends the MCP server with 0xC000013A and tunnel-client shuts down with it.
# Use the windowless pythonw.exe next to python.exe on Windows; fall back to python.exe and say so.
$McpPythonPath = $PythonPath
$McpPythonWindowless = $false
if ($env:OS -eq "Windows_NT") {
    $WindowlessPython = Join-Path (Split-Path -Parent $PythonPath) "pythonw.exe"
    if (Test-Path -LiteralPath $WindowlessPython -PathType Leaf) {
        $McpPythonPath = Get-FullPath -Path $WindowlessPython
        $McpPythonWindowless = $true
    } else {
        [Console]::Error.WriteLine("pythonw.exe was not found next to $PythonPath; the MCP server will use python.exe, whose console window must stay open.")
    }
}
# tunnel-client parses mcp-command with shell-style escaping; use forward slashes on Windows.
$McpCommand = '"{0}" "{1}"' -f $McpPythonPath.Replace("\", "/"), $ServerPath.Replace("\", "/")
$ProfilePresent = Get-ProfilePresent -Directory $ResolvedProfileDir -Name $ProfileName
$ApiKeyPresent = if ($UseEnvironmentApiKey) {
    -not [string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)
} else {
    Test-Path -LiteralPath $ResolvedApiKeyFile -PathType Leaf
}

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
        mcpPython = $McpPythonPath
        mcpPythonWindowless = $McpPythonWindowless
        mcpServer = $ServerPath
        profileDirectory = $ResolvedProfileDir
        profileName = $ProfileName
        profilePresent = $ProfilePresent
        apiKeyPresent = $ApiKeyPresent
        apiKeySource = $ApiKeyReference
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
        mcpPythonWindowless = $McpPythonWindowless
        apiKeySource = $ApiKeyReference
        healthListenAddress = "127.0.0.1:0"
        maxConcurrentMcpRequests = 1
        remoteAdminUiEnabled = $false
        rawHttpLoggingEnabled = $false
    } | ConvertTo-Json -Depth 4 -Compress
    exit 0
}

if ($Mode -eq "Init") {
    if ($ProfilePresent) {
        throw "Profile already exists. Preserve it and use a new ProfileName for a new configuration."
    }
    New-Item -ItemType Directory -Path $ResolvedProfileDir -Force | Out-Null
    $InitArguments = @(
        "init",
        "--sample", "sample_mcp_stdio_local",
        "--profile", $ProfileName,
        "--profile-dir", $ResolvedProfileDir,
        "--tunnel-id", $TunnelId,
        "--mcp-command", $McpCommand,
        "--control-plane-api-key-ref", $ApiKeyReference,
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
        apiKeySource = $ApiKeyReference
    } | ConvertTo-Json -Depth 3 -Compress
    exit 0
}

Assert-ApiKeyReference
if (-not $ProfilePresent) {
    throw "Profile is missing. Run Init with the tunnel ID supplied by the owner first."
}

if ($Mode -eq "Doctor") {
    Invoke-TunnelClient -Arguments @(
        "doctor",
        "--profile", $ProfileName,
        "--profile-dir", $ResolvedProfileDir,
        "--control-plane.api-key", $ApiKeyReference,
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
    "--control-plane.api-key", $ApiKeyReference,
    "--health.listen-addr", "127.0.0.1:0",
    "--health.url-file", (Join-Path $RuntimeDir "health-url.txt"),
    "--pid.file", (Join-Path $RuntimeDir "tunnel-client.pid"),
    "--mcp.max-concurrent-requests", "1",
    "--log.format", "json",
    "--log.file", (Join-Path $LogDir "tunnel-client.jsonl")
)
