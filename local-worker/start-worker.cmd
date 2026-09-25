@echo off
set "KHORA_HOME=%LOCALAPPDATA%\Khora\EffectifTranscriber"
if not exist "%KHORA_HOME%\.venv\Scripts\pythonw.exe" exit /b 2
start "" /min "%KHORA_HOME%\.venv\Scripts\pythonw.exe" "%KHORA_HOME%\worker.py"