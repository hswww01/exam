param([int]$Port = 8033, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$examRoot = $PSScriptRoot
$examUrl = "http://127.0.0.1:$Port"
$examPhp = Join-Path $examRoot '.runtime\php\php.exe'
$examIni = Join-Path $examRoot '.runtime\php\php.ini'
if (-not (Test-Path -LiteralPath $examPhp)) { $examPhp = (Get-Command php.exe -ErrorAction Stop).Source }
$examArgs = @()
if (Test-Path -LiteralPath $examIni) { $examArgs += @('-c', ('"' + $examIni + '"')) }
try {
    $examExisting = Invoke-RestMethod -Uri "$examUrl/api/overview" -TimeoutSec 4
    if ($examExisting.subjects.Count -eq 5) {
        Write-Host "Exam preview already running: $examUrl"
        if (-not $NoBrowser) { Start-Process $examUrl }
        exit 0
    }
} catch {}
$examInstall = Join-Path $examRoot 'php\install.php'
if (Test-Path -LiteralPath $examIni) { & $examPhp -c $examIni $examInstall } else { & $examPhp $examInstall }
if ($LASTEXITCODE -ne 0) { throw 'PHP initialization failed.' }
$examPublic = Join-Path $examRoot 'public'
$examRouter = Join-Path $examPublic 'index.php'
$examServer = Start-Process -FilePath $examPhp -ArgumentList ($examArgs + @('-S', "127.0.0.1:$Port", '-t', ('"' + $examPublic + '"'), ('"' + $examRouter + '"'))) -WorkingDirectory $examRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $examRoot 'server.log') -RedirectStandardError (Join-Path $examRoot 'server-error.log') -PassThru
Set-Content -LiteralPath (Join-Path $examRoot '.exam-php-server.pid') -Value $examServer.Id
$examWorkerScript = Join-Path $examRoot 'php\worker.php'
$examWorker = Start-Process -FilePath $examPhp -ArgumentList ($examArgs + @(('"' + $examWorkerScript + '"'))) -WorkingDirectory $examRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $examRoot 'worker.log') -RedirectStandardError (Join-Path $examRoot 'worker-error.log') -PassThru
Set-Content -LiteralPath (Join-Path $examRoot '.exam-php-worker.pid') -Value $examWorker.Id
Write-Host "PHP preview: $examUrl"
Write-Host "Production: https://cn.tqdream.com/exam/"
if (-not $NoBrowser) { Start-Process $examUrl }
