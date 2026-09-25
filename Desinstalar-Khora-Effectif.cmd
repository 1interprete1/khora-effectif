@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0local-worker\uninstall.ps1"
pause