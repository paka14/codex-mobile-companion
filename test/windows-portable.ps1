#Requires -Version 5.1
param([Parameter(Mandatory)][string]$Archive)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\windows-preflight.ps1')
$archivePath = (Resolve-Path -LiteralPath $Archive).ProviderPath
$digest = (Get-Content -LiteralPath "$archivePath.sha256" -Raw).Trim().Split(' ')[0]
if ((Get-FileHash -LiteralPath $archivePath).Hash -ne $digest) { throw 'Portable ZIP digest mismatch.' }
$temp = Join-Path ([IO.Path]::GetTempPath()) ('companion-package-test-' + [guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($temp)
$originalPath = $env:PATH
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $temp)
    $root = Join-Path $temp ([IO.Path]::GetFileNameWithoutExtension($archivePath))
    $env:PATH = ''
    $runtime = Get-CompanionRuntime $root
    if ($runtime.Kind -ne 'BUNDLED') { throw 'System Node must not be used.' }
    $profile = Join-Path $temp 'profile.json'
    $origin = 'https://fixture.tail1234.ts.net'
    New-CompanionProfile $profile $origin 'owner@example.test'
    $gateway = Join-Path $root 'companion.cjs'
    $config = (Invoke-CompanionReadCommand $runtime.Path ('"' + $gateway + '" --check-config "' + $profile + '"')).Text | ConvertFrom-Json
    if ($config.port -ne 4317 -or $config.origin -cne $origin) { throw 'Packaged config check failed.' }
    if (Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object Name -In @('companion.config.json', 'operations.json', 'tailscale.exe', 'Codex.exe')) {
        throw 'A private file or separately installed app was bundled.'
    }
    $bom = Get-Content -LiteralPath (Join-Path $root 'bom.cdx.json') -Raw | ConvertFrom-Json
    if ($bom.components[0].version -ne $runtime.Version.TrimStart('v') -or
        -not (Test-Path -LiteralPath (Join-Path $root 'runtime\LICENSE'))) { throw 'Invalid bundled notices or SBOM.' }
    [IO.File]::AppendAllText($runtime.Path, 'changed')
    $refused = $false
    try { $null = Get-CompanionRuntime $root } catch { $refused = $_.Exception.Message -match 'missing or changed' }
    if (-not $refused) { throw 'Modified bundled runtime was not refused.' }
    Write-Host 'Portable ZIP smoke passed with PATH empty, without Codex or Tailscale.'
} finally {
    $env:PATH = $originalPath
    $resolvedTemp = [IO.Path]::GetFullPath($temp)
    $testRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolvedTemp.StartsWith($testRoot, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolvedTemp) -match '^companion-package-test-[0-9a-f]{32}$') {
        Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
    }
}
