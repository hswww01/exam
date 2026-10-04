param([int]$Port = 8033, [switch]$NoBrowser)
& (Join-Path $PSScriptRoot "start-php.ps1") -Port $Port -NoBrowser:$NoBrowser
