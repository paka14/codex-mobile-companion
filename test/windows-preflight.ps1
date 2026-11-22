#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'windows-preflight.ps1')

function Assert-Equal($Actual, $Expected) {
    if ($Actual -cne $Expected) { throw "Expected '$Expected', got '$Actual'." }
}
$origin = 'https://machine.tailnet.ts.net'
$route = '{"TCP":{"443":{"HTTPS":true}},"Web":{"machine.tailnet.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:4317"}}}}}'
Assert-Equal (Get-CompanionServeDecision ('{}' | ConvertFrom-Json) $origin 4317) missing
Assert-Equal (Get-CompanionServeDecision ($route | ConvertFrom-Json) $origin 4317) private
Assert-Equal (Get-CompanionServeDecision (('{"Foreground":{"synthetic":' + $route + '}}') | ConvertFrom-Json) $origin 4317) private
Assert-Equal (Get-CompanionServeDecision ($route | ConvertFrom-Json) $origin 9229) conflict
Assert-Equal (Get-CompanionServeDecision ($route | ConvertFrom-Json) 'https://other.tailnet.ts.net' 4317) conflict
Assert-Equal (Get-CompanionServeDecision ($route.Replace('127.0.0.1', 'localhost') | ConvertFrom-Json) $origin 4317) conflict
Assert-Equal (Get-CompanionServeDecision ($route.Replace('true', '"true"') | ConvertFrom-Json) $origin 4317) conflict
Assert-Equal (Get-CompanionServeDecision ($route.Replace('"/":', '"/nested":') | ConvertFrom-Json) $origin 4317) conflict
Assert-Equal (Get-CompanionServeDecision ($route.Replace('"TCP"', '"AllowFunnel":{"machine.tailnet.ts.net:443":true},"TCP"') | ConvertFrom-Json) $origin 4317) 'funnel-or-unknown'
Assert-Equal (Get-CompanionServeDecision ($route.Replace('"TCP"', '"Services":{"svc:other":{}},"TCP"') | ConvertFrom-Json) $origin 4317) conflict
Assert-Equal (Get-CompanionServeDecision ('{"unknown":true}' | ConvertFrom-Json) $origin 4317) unknown
Assert-Equal (Get-CompanionServeDecision ($route.Replace('"Handlers":{', '"Handlers":{"/other":{"Proxy":"http://127.0.0.1:9229"},') | ConvertFrom-Json) $origin 4317) conflict

function Invoke-CompanionReadCommand([string]$Exe, [string]$Arguments) {
    if ($Arguments -ceq 'serve status --json') {
        return [pscustomobject]@{ Text = $script:serveStatus }
    }
    Assert-Equal $Arguments 'status --json --peers=false'
    [pscustomobject]@{ Text = $script:status }
}
$script:serveStatus = "null`n"
Assert-Equal (Get-CompanionServeStatus fixture $origin 4317) missing
$script:serveStatus = ''
Assert-Equal (Get-CompanionServeStatus fixture $origin 4317) unknown
$script:serveStatus = 'truncated output'
Assert-Equal (Get-CompanionServeStatus fixture $origin 4317) unknown
$script:status = '{"BackendState":"Running","Self":{"Online":true,"DNSName":"Machine.Tailnet.ts.net."}}'
Assert-Equal (Get-CompanionTailscaleOrigin fixture) $origin
$script:status = '{"BackendState":"NeedsLogin","Self":{}}'
try { Get-CompanionTailscaleOrigin fixture; throw 'Expected refusal.' }
catch { if ($_.Exception.Message -notmatch '^Connect and sign in') { throw } }

$fixture = Join-Path ([IO.Path]::GetTempPath()) ('companion-test-' + [guid]::NewGuid().ToString('N'))
$config = Join-Path $fixture 'profile\companion.config.json'
try {
    New-CompanionProfile $config $origin 'phone@example.test'
    $saved = Get-Content -Raw -LiteralPath $config | ConvertFrom-Json
    Assert-Equal $saved.accessProfile continue
    Assert-Equal $saved.ownerLogin 'phone@example.test'
    Assert-Equal $saved.origin $origin
    $before = (Get-FileHash -LiteralPath $config).Hash
    $overwritten = $true
    try { New-CompanionProfile $config $origin 'other@example.test' } catch { $overwritten = $false }
    Assert-Equal $overwritten $false
    Assert-Equal (Get-FileHash -LiteralPath $config).Hash $before
    Assert-Equal @(Get-ChildItem -LiteralPath (Split-Path -Parent $config) -Force).Count 1
} finally {
    if ([IO.Path]::GetFullPath($fixture) -eq $fixture -and [IO.Path]::GetFileName($fixture) -match '^companion-test-[a-f0-9]{32}$' -and
        (Test-Path -LiteralPath $fixture)) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
'Windows preflight tests passed.'
