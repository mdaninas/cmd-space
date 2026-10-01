@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0terminal-control.ps1" -Action start
if errorlevel 1 pause
