#Requires -Version 5.1
param([int]$Port, [int]$DesktopProcessId)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-launcher.ps1')
try {
    if ((Get-CompanionVerifiedDesktopPid (Get-CompanionInstalledDesktop) $Port) -ne $DesktopProcessId) { exit 1 }
} catch { exit 1 }
