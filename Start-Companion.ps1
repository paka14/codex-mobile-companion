#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$ConfigPath,
    [switch]$Check,
    [switch]$Setup
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-launcher.ps1')
. (Join-Path $PSScriptRoot 'windows-preflight.ps1')

if ($Check -and $Setup) { throw 'Choose either -Check or -Setup.' }
$mutex = $null
$held = $false
$stage = 'RUNTIME'
try {
    $runtime = Get-CompanionRuntime $PSScriptRoot
    Write-Host "[RUNTIME:$($runtime.Kind)] Node $($runtime.Version)"
    $stage = 'PROFILE'
    if (-not $Check) {
        $mutex = [Threading.Mutex]::new($false, 'Local\CodexMobileCompanionLauncher')
        try { $held = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held = $true }
        if (-not $held) { throw 'Another Companion launcher is active. Use its original window to stop it.' }
    }
    $configFile = Get-CompanionProfilePath $PSScriptRoot $ConfigPath
    $gateway = Join-Path $PSScriptRoot 'companion.cjs'
    $stage = 'TAILSCALE'
    $tailscale = Get-CompanionTailscale
    $origin = Get-CompanionTailscaleOrigin $tailscale
    Write-Host '[TAILSCALE:CONNECTED] Windows is connected. The phone must also connect.'
    $stage = 'PROFILE'
    if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) {
        if ($Check) { throw 'Profile not found. Run Start Companion without -Check to set it up.' }
        $login = Read-Host 'Enter the Tailscale login shown on your phone (not your Codex login)'
        if ($login -notmatch '^[\x21-\x7e]{1,254}$' -or $login.Contains(',')) { throw 'Enter one exact Tailscale login without spaces or commas.' }
        if ((Read-Host "Save a private profile for $login at $origin? Type YES") -cne 'YES') { throw 'Setup cancelled. No profile was saved.' }
        New-CompanionProfile $configFile $origin $login
    }
    $settings = (Invoke-CompanionReadCommand $runtime.Path ('"' + $gateway + '" --check-config "' + $configFile + '"')).Text | ConvertFrom-Json
    if ($settings.origin -cne $origin) { throw 'The profile HTTPS name does not match this Tailscale device. Restore the original device or use a separate profile.' }
    Write-Host '[PROFILE:VALID]'
    if ($Setup) { return }

    $stage = 'SERVE'
    $serve = Get-CompanionServeStatus $tailscale $origin $settings.port
    $free = @(Get-CompanionPortListener $settings.port).Count -eq 0
    if ($serve -eq 'missing') {
        if (-not $free) { throw 'No HTTPS mapping and the gateway port is occupied. Do not create a mapping to that port.' }
        throw "No HTTPS mapping. In another PowerShell window run: tailscale serve --https=443 http://127.0.0.1:$($settings.port)`nKeep that window open and retry. Never use Funnel."
    }
    if ($serve -ne 'private') { throw "Not an exclusive private HTTPS gateway mapping ($serve). Do not replace another service or use Funnel." }
    Write-Host '[SERVE:PRIVATE] Verified local mapping; not a phone or certificate test.'

    $stage = 'DESKTOP'
    $desktop = Get-CompanionInstalledDesktop
    $state = Get-CompanionDesktopStatus $desktop $settings.desktopPort
    Write-Host "[DESKTOP:$state] Codex $($desktop.Version)"
    $stage = 'GATEWAY'
    if ($Check) {
        if ($free) { Write-Host '[GATEWAY:FREE] Not running.' }
        else { Write-Host '[GATEWAY:OCCUPIED] This check does not identify who owns the port.' }
        if (-not $free -or $state -notin @('ready', 'launch', 'starting')) { exit 1 }
        return
    }
    if (-not $free) { throw 'Gateway port is occupied. No desktop launch was attempted.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        if ([Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            throw 'Run Companion in a normal Windows PowerShell window, not as administrator.'
        }
    } finally { $identity.Dispose() }
    $stage = 'DESKTOP'
    if ($state -eq 'launch' -and (Read-Host 'Start the official Codex desktop with a local-only debug listener? Type YES') -cne 'YES') {
        throw 'Desktop start cancelled.'
    }
    Enter-CompanionDesktop $desktop $settings.desktopPort -AllowLaunch:($state -eq 'launch')
    $desktopProcessId = Get-CompanionVerifiedDesktopPid $desktop $settings.desktopPort
    $stage = 'GATEWAY'
    Start-CompanionForeground $runtime.Path $gateway $configFile $desktopProcessId $tailscale $origin $settings.port
} catch {
    [Console]::Error.WriteLine("[${stage}:STOPPED] $($_.Exception.Message)")
    exit 1
} finally {
    if ($held) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
