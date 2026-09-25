$ErrorActionPreference = "Stop"
$Target = Join-Path $env:LOCALAPPDATA "Khora\EffectifTranscriber"
$StartupCommand = Join-Path ([Environment]::GetFolderPath("Startup")) "Khora-Effectif-Transcriber.cmd"
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*EffectifTranscriber*worker.py*" } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Remove-Item $StartupCommand -Force -ErrorAction SilentlyContinue
Remove-Item $Target -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Motor local Khora Effectif eliminado."