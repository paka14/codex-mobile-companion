#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'windows-launcher.ps1')

function Assert-Equal($Actual, $Expected) {
    if ($Actual -ne $Expected) { throw "Expected '$Expected', got '$Actual'." }
}

$desktop = [pscustomobject]@{ Path = 'C:\Example\app\ChatGPT.exe'; Version = [version]'1.2.3' }
$process = [pscustomobject]@{
    ProcessId = 41
    ExecutablePath = $desktop.Path
    CommandLine = 'ChatGPT.exe --remote-debugging-address=127.0.0.1 --remote-debugging-port=9229'
}
$listener = [pscustomobject]@{ OwningProcess = 41; LocalAddress = '127.0.0.1' }
Assert-Equal (Get-CompanionDesktopDecision $desktop 9229 @() @()) launch
Assert-Equal (Get-CompanionDesktopDecision $desktop 9229 @() @($listener)) occupied
Assert-Equal (Get-CompanionDesktopDecision $desktop 9229 @($process) @()) starting
Assert-Equal (Get-CompanionDesktopDecision $desktop 9229 @($process) @($listener)) ready
Assert-Equal (Get-CompanionDesktopDecision $desktop 9230 @($process) @($listener)) existing-incompatible
Assert-Equal (Get-CompanionDesktopDecision $desktop 9229 @($process, $process) @($listener)) existing-incompatible
$process.CommandLine += ' --remote-debugging-port=8081'
Assert-Equal (Get-CompanionDesktopDecision $desktop 9229 @($process) @($listener)) existing-incompatible
$process.CommandLine = $null
Assert-Equal (Get-CompanionDesktopDecision $desktop 9229 @($process) @($listener)) existing-incompatible
$process.CommandLine = 'ChatGPT.exe --remote-debugging-address 127.0.0.1 --remote-debugging-port 9229'
$listener.LocalAddress = '::1'
Assert-Equal (Get-CompanionDesktopDecision $desktop 9229 @($process) @($listener)) ready
$foreign = [pscustomobject]@{ OwningProcess = 42; LocalAddress = '127.0.0.1' }
Assert-Equal (Get-CompanionDesktopDecision $desktop 9229 @($process) @($listener, $foreign)) unsafe-listener
$listener.LocalAddress = '0.0.0.0'
Assert-Equal (Get-CompanionDesktopDecision $desktop 9229 @($process) @($listener)) unsafe-listener
$listener.LocalAddress = '127.0.0.1'
$listener.OwningProcess = 42
Assert-Equal (Get-CompanionDesktopDecision $desktop 9229 @($process) @($listener)) unsafe-listener

$script:decisions = [Collections.Generic.Queue[string]]::new()
$script:starts = 0
function Get-CompanionDesktopStatus($Desktop, [int]$Port) { $script:decisions.Dequeue() }
function Start-Sleep([int]$Milliseconds) {}
function Start-Process($FilePath, $ArgumentList, $WindowStyle) {
    $script:starts++
    Assert-Equal $FilePath 'C:\Example\app\ChatGPT.exe'
    Assert-Equal ($ArgumentList -join ' ') '--remote-debugging-address=127.0.0.1 --remote-debugging-port=9229'
    Assert-Equal $WindowStyle Normal
}
$script:decisions.Enqueue('launch')
$script:decisions.Enqueue('starting')
$script:decisions.Enqueue('ready')
Enter-CompanionDesktop $desktop 9229 -AllowLaunch
Assert-Equal $script:starts 1
$script:decisions.Enqueue('ready')
Enter-CompanionDesktop $desktop 9229
Assert-Equal $script:starts 1
$script:decisions.Enqueue('existing-incompatible')
try {
    Enter-CompanionDesktop $desktop 9229
    throw 'Expected refusal.'
} catch {
    if ($_.Exception.Message -notmatch '^Codex is already running') { throw }
}
Assert-Equal $script:starts 1
$script:decisions.Enqueue('launch')
try {
    Enter-CompanionDesktop $desktop 9229
    throw 'Expected refusal.'
} catch {
    if ($_.Exception.Message -notmatch '^Codex closed during startup') { throw }
}
Assert-Equal $script:starts 1
'Windows launcher tests passed.'
