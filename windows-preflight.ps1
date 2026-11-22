#Requires -Version 5.1

function New-CompanionProcess([string]$Exe, [string]$Arguments, [switch]$Capture) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $Exe
    $info.Arguments = $Arguments
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = [bool]$Capture
    $info.RedirectStandardError = [bool]$Capture
    $info.CreateNoWindow = [bool]$Capture
    $info.EnvironmentVariables.Remove('NODE_OPTIONS')
    $info.EnvironmentVariables.Remove('NODE_PATH')
    [Diagnostics.Process]::Start($info)
}

function Invoke-CompanionReadCommand([string]$Exe, [string]$Arguments) {
    $process = New-CompanionProcess $Exe $Arguments -Capture
    try {
        $process.StandardInput.Close()
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(4000)) { throw 'The local check timed out.' }
        if ($process.ExitCode -ne 0 -or -not $output.Wait(1000) -or -not $errors.Wait(1000)) {
            throw 'The local check failed. Verify the relevant application or configuration.'
        }
        [pscustomobject]@{ Text = $output.Result }
    } finally {
        if (-not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(2000) }
        $process.Dispose()
    }
}

function Get-CompanionRuntime([string]$Root) {
    $lock = Join-Path $Root 'runtime.json'
    $portable = Test-Path -LiteralPath $lock -PathType Leaf
    if (-not $portable -and (Test-Path -LiteralPath (Join-Path $Root 'runtime'))) {
        throw 'The bundled runtime manifest is missing. Extract a verified package into a new folder.'
    }
    if ($portable) {
        try { $manifest = Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json }
        catch { throw 'The bundled runtime manifest is unreadable. Extract a verified package into a new folder.' }
        $path = Join-Path $Root 'runtime\node.exe'
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $manifest.nodeExeSha256) {
            throw 'The bundled runtime is missing or changed. Extract a verified package into a new folder.'
        }
    } else {
        $path = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
        if (-not $path) { throw 'Use the portable Windows ZIP, or install Node.js 24+ for the source checkout.' }
    }
    $version = (Invoke-CompanionReadCommand $path '--version').Text.Trim()
    if ($version -notmatch '^v(\d+)\.\d+\.\d+$' -or [int]$Matches[1] -lt 24 -or
        ($portable -and $version -cne $manifest.nodeVersion)) {
        throw 'This runtime does not match the required Node.js version.'
    }
    $kind = if ($portable) { 'BUNDLED' } else { 'SYSTEM' }
    [pscustomobject]@{ Path = $path; Version = $version; Kind = $kind }
}

function Get-CompanionProfilePath([string]$Root, [string]$Override) {
    if ($Override) { return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Override) }
    $legacy = Join-Path $Root 'companion.config.json'
    if (Test-Path -LiteralPath $legacy -PathType Leaf) { return $legacy }
    $local = [Environment]::GetFolderPath('LocalApplicationData')
    if (-not $local) { throw 'Windows Local AppData is unavailable.' }
    Join-Path $local 'CodexMobileCompanion\companion.config.json'
}

function New-CompanionProfile([string]$Path, [string]$Origin, [string]$Login) {
    $parent = [IO.Path]::GetDirectoryName($Path)
    $null = [IO.Directory]::CreateDirectory($parent)
    $temp = Join-Path $parent ('.profile-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $profile = @{ origin = $Origin; ownerLogin = $Login; dataDirectory = 'data'; accessProfile = 'continue' }
    try {
        [IO.File]::WriteAllText($temp, ($profile | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        [IO.File]::Move($temp, $Path)
    } finally {
        if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) }
    }
}

function Get-CompanionTailscale {
    foreach ($root in @($env:ProgramW6432, $env:ProgramFiles) | Where-Object { $_ } | Select-Object -Unique) {
        $path = Join-Path $root 'Tailscale\tailscale.exe'
        if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
    }
    throw 'Install official Tailscale on Windows and your phone, then sign in before retrying.'
}

function Get-CompanionTailscaleOrigin([string]$Tailscale) {
    $result = Invoke-CompanionReadCommand $Tailscale 'status --json --peers=false'
    try { $status = $result.Text | ConvertFrom-Json }
    catch { throw 'Unrecognized Tailscale status. No private mapping was assumed.' }
    if ($status.BackendState -cne 'Running') {
        throw 'Connect and sign in using the Tailscale tray app, then retry.'
    }
    $dns = ([string]$status.Self.DNSName).TrimEnd('.').ToLowerInvariant()
    if ($dns -notmatch '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2,}ts\.net$' -or $dns.Length -gt 253) {
        throw 'No supported Tailscale HTTPS hostname. Check MagicDNS and HTTPS setup.'
    }
    "https://$dns"
}

function Test-CompanionShape($Object, [string[]]$Keys) {
    if ($Object -isnot [pscustomobject]) { return $false }
    foreach ($prop in $Object.PSObject.Properties) {
        if ($prop.Name -cnotin $Keys) { return $false }
    }
    return $true
}

function Get-CompanionServeDecision($Config, [string]$Origin, [int]$Port) {
    if (-not (Test-CompanionShape $Config @('TCP', 'Web', 'AllowFunnel', 'Foreground', 'Services'))) { return 'unknown' }
    $hostPort = ([uri]$Origin).Host + ':443'
    $candidates = @($Config)
    if ($null -ne $Config.Foreground) {
        if ($Config.Foreground -isnot [pscustomobject]) { return 'unknown' }
        $candidates += @($Config.Foreground.PSObject.Properties | ForEach-Object Value)
    }
    $found = 0
    foreach ($candidate in $candidates) {
        if (-not (Test-CompanionShape $candidate @('TCP', 'Web', 'AllowFunnel', 'Foreground', 'Services'))) { return 'unknown' }
        if ($null -ne $candidate.Foreground -and -not [object]::ReferenceEquals($candidate, $Config)) { return 'unknown' }
        if ($null -ne $candidate.AllowFunnel -and -not (Test-CompanionShape $candidate.AllowFunnel @())) { return 'funnel-or-unknown' }
        if ($null -ne $candidate.Services -and -not (Test-CompanionShape $candidate.Services @())) { return 'conflict' }
        if ($null -eq $candidate.TCP -and $null -eq $candidate.Web) { continue }
        if (-not (Test-CompanionShape $candidate.TCP @('443')) -or
            -not (Test-CompanionShape $candidate.TCP.'443' @('HTTPS')) -or
            $candidate.TCP.'443'.HTTPS -isnot [bool] -or -not $candidate.TCP.'443'.HTTPS -or
            -not (Test-CompanionShape $candidate.Web @($hostPort)) -or
            -not (Test-CompanionShape $candidate.Web.$hostPort @('Handlers')) -or
            -not (Test-CompanionShape $candidate.Web.$hostPort.Handlers @('/')) -or
            -not (Test-CompanionShape $candidate.Web.$hostPort.Handlers.'/' @('Proxy')) -or
            $candidate.Web.$hostPort.Handlers.'/'.Proxy -cne "http://127.0.0.1:${Port}") { return 'conflict' }
        $found++
    }
    if ($found -eq 1) { return 'private' }
    if ($found -eq 0) { return 'missing' }
    'conflict'
}

function Get-CompanionServeStatus([string]$Tailscale, [string]$Origin, [int]$Port) {
    $result = Invoke-CompanionReadCommand $Tailscale 'serve status --json'
    if ($result.Text.Trim() -ceq 'null') { return 'missing' }
    try { $config = $result.Text | ConvertFrom-Json } catch { return 'unknown' }
    if ($null -eq $config) { return 'unknown' }
    Get-CompanionServeDecision $config $Origin $Port
}

function Start-CompanionForeground([string]$Node, [string]$Gateway, [string]$Config, [int]$DesktopProcessId,
    [string]$Tailscale, [string]$Origin, [int]$Port) {
    $child = New-CompanionProcess $Node ('"' + $Gateway + '" --supervised ' + $DesktopProcessId + ' "' + $Config + '"')
    try {
        Write-Host 'Keep this window open. Ctrl+C stops Companion only.'
        while (-not $child.WaitForExit(5000)) {
            if ((Get-CompanionTailscaleOrigin $Tailscale) -cne $Origin -or
                (Get-CompanionServeStatus $Tailscale $Origin $Port) -ne 'private') {
                throw 'The private Serve mapping changed. The gateway was stopped; no Tailscale settings were changed.'
            }
        }
        if ($child.ExitCode -ne 0) { throw 'The gateway exited. See its status above.' }
    } finally {
        $child.StandardInput.Close()
        if (-not $child.WaitForExit(2500)) { $child.Kill(); $null = $child.WaitForExit(2000) }
        $child.Dispose()
    }
}
