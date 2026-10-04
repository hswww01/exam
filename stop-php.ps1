$ErrorActionPreference = 'Stop'
foreach ($examKind in @('server','worker')) {
    $examPidFile = Join-Path $PSScriptRoot ".exam-php-$examKind.pid"
    if (-not (Test-Path -LiteralPath $examPidFile)) { continue }
    $examProcessId = [int](Get-Content -LiteralPath $examPidFile -Raw).Trim()
    $examProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$examProcessId"
    $examScript = if ($examKind -eq 'server') { Join-Path $PSScriptRoot 'public\index.php' } else { Join-Path $PSScriptRoot 'php\worker.php' }
    if ($examProcess -and $examProcess.Name -eq 'php.exe' -and $examProcess.CommandLine.Contains($examScript)) {
        Stop-Process -Id $examProcessId
    } elseif ($examProcess) { throw 'Recorded PID belongs to another process; it was not stopped.' }
    Remove-Item -LiteralPath $examPidFile
}
Write-Host 'Local PHP preview stopped. Server deployment is unaffected.'
