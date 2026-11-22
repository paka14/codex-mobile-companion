#Requires -Version 5.1

function Get-CompanionInstalledDesktop {
    $package = Get-AppxPackage -Name OpenAI.Codex |
        Where-Object PublisherId -eq '2p2nqsd0c76g0' |
        Sort-Object Version -Descending | Select-Object -First 1
    if (-not $package) { throw 'Install the official Codex desktop app for this Windows user.' }
    $path = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw 'This Codex desktop package does not have the supported Windows layout.'
    }
    [pscustomobject]@{ Path = $path; Version = $package.Version }
}

function Get-CompanionDesktopProcess {
    $session = (Get-Process -Id $PID).SessionId
    Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe' AND SessionId=$session" |
        Where-Object {
            (-not $_.ExecutablePath -or $_.ExecutablePath -match '[\\/]OpenAI\.Codex_') -and
                $_.CommandLine -notmatch '(?:^|\s)--type(?:=|\s)'
        }
}

function Get-CompanionPortListener([int]$Port) {
    Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq $Port
}

function Get-CompanionDesktopDecision($Desktop, [int]$Port, [array]$Process, [array]$Listener) {
    if ($Process.Count -eq 0) {
        if ($Listener.Count) { return 'occupied' }
        return 'launch'
    }
    if ($Process.Count -ne 1 -or $Process[0].ExecutablePath -ne $Desktop.Path) {
        return 'existing-incompatible'
    }
    $running = $Process[0]
    # Reject duplicate flags instead of guessing which one the application would honor.
    foreach ($key in @('address', 'port')) {
        $expected = if ($key -eq 'address') { '127.0.0.1' } else { [string]$Port }
        $arguments = [regex]::Matches([string]$running.CommandLine, '(?:^|\s)--remote-debugging-' + $key + '(?:=|\s+)([^\s]+)')
        if ($arguments.Count -ne 1 -or $arguments[0].Groups[1].Value -ne $expected) {
            return 'existing-incompatible'
        }
    }
    if ($Listener.Count -eq 0) { return 'starting' }
    foreach ($item in $Listener) {
        if ($item.OwningProcess -ne $running.ProcessId -or $item.LocalAddress -notin @('127.0.0.1', '::1')) {
            return 'unsafe-listener'
        }
    }
    'ready'
}

function Get-CompanionDesktopStatus($Desktop, [int]$Port) {
    Get-CompanionDesktopDecision $Desktop $Port @(Get-CompanionDesktopProcess) @(Get-CompanionPortListener $Port)
}

function Get-CompanionVerifiedDesktopPid($Desktop, [int]$Port) {
    $processes = @(Get-CompanionDesktopProcess)
    if ((Get-CompanionDesktopDecision $Desktop $Port $processes @(Get-CompanionPortListener $Port)) -ne 'ready') {
        throw 'Codex did not own a verified local debug listener.'
    }
    [int]$processes[0].ProcessId
}

function Enter-CompanionDesktop($Desktop, [int]$Port, [switch]$AllowLaunch) {
    $mutex = [Threading.Mutex]::new($false, 'Local\CodexMobileCompanionDesktop')
    $held = $false
    try {
        try { $held = $mutex.WaitOne(10000) } catch [Threading.AbandonedMutexException] { $held = $true }
        if (-not $held) { throw 'Another companion is checking the desktop. Try again shortly.' }
        $state = Get-CompanionDesktopStatus $Desktop $Port
        if ($state -eq 'launch') {
            if (-not $AllowLaunch) { throw 'Codex closed during startup. Run the launcher again to confirm a fresh start.' }
            $saved = @{}
            foreach ($entry in @(Get-ChildItem Env: | Where-Object { $_.Name -like 'CODEXL_*' -or $_.Name -eq 'CODEX_CLI_PATH' })) {
                $saved[$entry.Name] = $entry.Value
                Remove-Item -LiteralPath ('Env:' + $entry.Name)
            }
            try {
                Start-Process -FilePath $Desktop.Path -ArgumentList '--remote-debugging-address=127.0.0.1', "--remote-debugging-port=$Port" -WindowStyle Normal
            } finally {
                foreach ($name in $saved.Keys) { Set-Item -LiteralPath ('Env:' + $name) -Value $saved[$name] }
            }
        }
        $deadline = (Get-Date).AddSeconds(20)
        while ($true) {
            switch ($state) {
                'ready' { return }
                'existing-incompatible' { throw 'Codex is already running without this companion configuration. Quit it normally when your work is saved, then run this launcher again.' }
                'occupied' { throw 'The desktop debugging port is already in use. Pick a different desktopPort.' }
                'unsafe-listener' { throw 'The debug listener is not exclusively loopback and owned by Codex. No gateway was started. Check it before use.' }
            }
            if ((Get-Date) -ge $deadline) { throw 'Codex did not open its local debug listener before the deadline. No gateway was started.' }
            Start-Sleep -Milliseconds 400
            $state = Get-CompanionDesktopStatus $Desktop $Port
        }
    } finally {
        if ($held) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
