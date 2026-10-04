@echo off
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-php.ps1"
if errorlevel 1 pause
