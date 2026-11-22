#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$NodeArchive,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][ValidatePattern('^[0-9][a-zA-Z0-9.-]{0,39}$')][string]$Version
)
$ErrorActionPreference = 'Stop'
$pin = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'packaging\node-win-x64.json') -Raw | ConvertFrom-Json
$archive = (Resolve-Path -LiteralPath $NodeArchive).ProviderPath
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $pin.sha256) { throw 'Node archive hash does not match the reviewed release pin.' }
$out = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
$null = [IO.Directory]::CreateDirectory($out)
$name = "codex-mobile-companion-$Version-win-x64"
$dest = Join-Path $out "$name.zip"
$checksum = "$dest.sha256"
if ((Test-Path -LiteralPath $dest) -or (Test-Path -LiteralPath $checksum)) { throw 'Output exists. Use a new version or output directory.' }
$temp = Join-Path $out ('.build-' + [guid]::NewGuid().ToString('N'))
$files = @(
    'Start Companion.cmd', 'Start-Companion.ps1', 'windows-launcher.ps1', 'windows-preflight.ps1', 'Confirm-CompanionDesktop.ps1',
    'companion.cjs', 'gateway.cjs', 'desktop-adapter.cjs', 'desktop-bridge.cjs', 'desktop-create-permissions.cjs',
    'desktop-send-adapter.cjs', 'desktop-transport.cjs', 'mobile-access.cjs', 'mobile-automations.cjs', 'mobile-operations.cjs',
    'mobile-page.cjs', 'mobile-snapshot.cjs', 'LICENSE', 'SECURITY.md', 'README.md', 'README.zh-CN.md',
    'companion.config.example.json', 'public\mobile.html', 'public\mobile-controls.js', 'public\mobile-diagnostics.js',
    'public\mobile-diagnostics-sw.js', 'public\mobile-diagnostics-offline.html'
)
try {
    $stage = Join-Path $temp $name
    $runtime = Join-Path $stage 'runtime'
    $null = [IO.Directory]::CreateDirectory($runtime)
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $nodeZip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        $nodeRoot = [IO.Path]::GetFileNameWithoutExtension($pin.archive)
        foreach ($leaf in @('node.exe', 'LICENSE')) {
            $entry = $nodeZip.GetEntry("$nodeRoot/$leaf")
            if (-not $entry) { throw 'The verified Node archive is missing an expected file.' }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $runtime $leaf))
        }
    } finally { $nodeZip.Dispose() }
    $nodeExe = Join-Path $runtime 'node.exe'
    $sign = Get-AuthenticodeSignature -LiteralPath $nodeExe
    if ($sign.Status -ne 'Valid' -or $sign.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=OpenJS Foundation(?:,|$)') {
        throw 'The official Node executable signature could not be verified.'
    }
    foreach ($file in $files) {
        $target = Join-Path $stage $file
        $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $target
    }
    $utf8 = [Text.UTF8Encoding]::new($false)
    $nodeSha = (Get-FileHash -LiteralPath $nodeExe -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifest = [ordered]@{ version = $Version; platform = 'win-x64'; nodeVersion = $pin.version; nodeExeSha256 = $nodeSha; nodeArchiveSha256 = $pin.sha256 }
    [IO.File]::WriteAllText((Join-Path $stage 'runtime.json'), ($manifest | ConvertTo-Json), $utf8)
    $sbom = [ordered]@{
        bomFormat = 'CycloneDX'; specVersion = '1.5'; version = 1
        metadata = @{ component = @{ type = 'application'; name = 'codex-mobile-companion'; version = $Version; licenses = @(@{ license = @{ id = 'MIT' } }) } }
        components = @(@{ type = 'framework'; name = 'Node.js'; version = $pin.version.TrimStart('v'); purl = "pkg:generic/nodejs@$($pin.version.TrimStart('v'))?arch=x86_64&os=windows"
            hashes = @(@{ alg = 'SHA-256'; content = $nodeSha }) })
    }
    [IO.File]::WriteAllText((Join-Path $stage 'bom.cdx.json'), ($sbom | ConvertTo-Json -Depth 8), $utf8)
    $draft = Join-Path $temp 'portable.zip'
    $zip = [IO.Compression.ZipFile]::Open($draft, [IO.Compression.ZipArchiveMode]::Create)
    $timestamp = [DateTimeOffset]::new(2020, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
    try {
        foreach ($file in @($files + @('runtime\node.exe', 'runtime\LICENSE', 'runtime.json', 'bom.cdx.json') | Sort-Object)) {
            $entry = $zip.CreateEntry("$name/" + $file.Replace('\','/'), [IO.Compression.CompressionLevel]::Optimal)
            $entry.LastWriteTime = $timestamp
            $inputFile = [IO.File]::OpenRead((Join-Path $stage $file))
            try {
                $stream = $entry.Open()
                try { $inputFile.CopyTo($stream) } finally { $stream.Dispose() }
            } finally { $inputFile.Dispose() }
        }
    } finally { $zip.Dispose() }
    $hash = (Get-FileHash -LiteralPath $draft -Algorithm SHA256).Hash.ToLowerInvariant()
    $digestDraft = Join-Path $temp 'portable.sha256'
    [IO.File]::WriteAllText($digestDraft, "$hash  $name.zip`n", $utf8)
    [IO.File]::Move($draft, $dest)
    [IO.File]::Move($digestDraft, $checksum)
    Get-Item -LiteralPath $dest, $checksum
} finally {
    if ([IO.Directory]::Exists($temp)) {
        $resolvedOut = [IO.Path]::GetFullPath($out).TrimEnd('\') + '\'
        $resolvedTemp = [IO.Path]::GetFullPath($temp)
        if ($resolvedTemp.StartsWith($resolvedOut, [StringComparison]::OrdinalIgnoreCase) -and
            [IO.Path]::GetFileName($resolvedTemp) -match '^\.build-[0-9a-f]{32}$') {
            Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
        }
    }
}
