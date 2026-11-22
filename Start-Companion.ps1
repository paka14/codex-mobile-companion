#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'companion.config.json'),
    [switch]$Check
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-launcher.ps1')

$node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$gateway = Join-Path $PSScriptRoot 'companion.cjs'
$configFile = (Resolve-Path -LiteralPath $ConfigPath).ProviderPath
$settings = & $node $gateway --check-config $configFile
if ($LASTEXITCODE -ne 0) { throw 'Companion configuration validation failed.' }
$ports = $settings | ConvertFrom-Json
$desktop = Get-CompanionInstalledDesktop
$gatewayAvailable = @(Get-CompanionPortListener $ports.port).Count -eq 0
if ($Check) {
    [pscustomobject]@{
        CodexVersion = $desktop.Version.ToString()
        DesktopStatus = Get-CompanionDesktopStatus $desktop $ports.desktopPort
        GatewayPortAvailable = $gatewayAvailable
    }
    return
}
if (-not $gatewayAvailable) { throw 'The gateway port is already in use. No desktop launch was attempted.' }
Enter-CompanionDesktop $desktop $ports.desktopPort
& $node $gateway $configFile
exit $LASTEXITCODE
