@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0terminal-control.ps1" -Action stop
if errorlevel 1 pause
