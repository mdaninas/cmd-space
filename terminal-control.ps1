param([ValidateSet('start', 'stop')][string]$Action = 'start', [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$statePath = Join-Path $PSScriptRoot '.terminal-process.json'
$entryPath = Join-Path $PSScriptRoot 'server\index.js'
$stdoutPath = Join-Path $PSScriptRoot 'server.stdout.log'
$stderrPath = Join-Path $PSScriptRoot 'server.stderr.log'
function Get-ManagedProcess($state) {
    if (-not $state) { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($state.processId)" -ErrorAction SilentlyContinue
    if ($process -and $process.Name -eq 'node.exe' -and
        $process.CommandLine.Contains('"' + $entryPath + '"') -and
        $process.CreationDate.ToUniversalTime().ToString('o') -eq $state.createdAt) { return $process }
    return $null
}
try {
    $state = $null
    if (Test-Path -LiteralPath $statePath) { $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json }
    $managed = Get-ManagedProcess $state
    if ($Action -eq 'stop') {
        if ($managed) {
            & taskkill.exe /PID $managed.ProcessId /T /F | Out-Host
            if ($LASTEXITCODE -ne 0) { throw 'Server gagal dihentikan. Coba ulangi stop-terminal.cmd.' }
            Write-Host 'Web Terminal sudah dihentikan.'
        } else { Write-Host 'Tidak ada server yang aktif dari launcher ini.' }
        if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath }
        exit 0
    }
    if ($managed) {
        $url = "http://localhost:$($state.port)"
        Write-Host "Web Terminal sudah berjalan: $url"
        if (-not $NoBrowser) { Start-Process $url }
        exit 0
    }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $version = & $node -p 'process.versions.node'
    if ([version]$version -lt [version]'22.12.0') { throw 'Pasang Node.js 22.12 atau lebih baru.' }
    $port = 3000
    if ($env:PORT) { $port = [int]$env:PORT }
    if ($port -lt 1 -or $port -gt 65535) { throw 'PORT harus 1-65535.' }
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
        throw "Port $port sedang dipakai. Hentikan server lama (Ctrl+C pada jendelanya), atau gunakan PORT lain."
    }
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'Instalasi dependensi gagal.' }
    }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Build gagal. Server belum dijalankan.' }
    $child = Start-Process -FilePath $node -ArgumentList ('"' + $entryPath + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($child.Id)"
    if (-not $process) { throw "Server gagal mulai. Periksa $stderrPath" }
    @{ processId = $child.Id; createdAt = $process.CreationDate.ToUniversalTime().ToString('o'); port = $port } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
    $url = "http://localhost:$port"
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $child.Refresh()
        if ($child.HasExited) { throw "Server berhenti saat startup. Periksa $stderrPath" }
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/config" -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 300
    }
    if (-not $ready) { throw "Server belum siap. Periksa $stderrPath; gunakan stop-terminal.cmd untuk menghentikannya." }
    Write-Host "Web Terminal berjalan: $url"
    Write-Host 'Gunakan stop-terminal.cmd untuk menghentikan server dan seluruh sesi terminal.'
    if (-not $NoBrowser) { Start-Process $url }
} catch {
    Write-Host "Gagal: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
