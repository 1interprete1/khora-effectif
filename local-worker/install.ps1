$ErrorActionPreference = "Stop"
$Version = "0.6.0"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Base = Join-Path $env:LOCALAPPDATA "Khora\EffectifTranscriber"
$Venv = Join-Path $Base ".venv"
$VenvPython = Join-Path $Venv "Scripts\python.exe"
$Worker = Join-Path $Base "worker.py"
$Backup = Join-Path $Base "backups"
$Startup = Join-Path ([Environment]::GetFolderPath("Startup")) "Khora-Effectif-Transcriber.cmd"
$Desktop = [Environment]::GetFolderPath("Desktop")
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Log = Join-Path $Desktop "khora-effectif-instalacion-$Timestamp.log"
$ReportPath = Join-Path $Desktop "khora-effectif-instalacion-$Timestamp.json"
$Phase = "inicio"
$ReusedEnvironment = $false
$RollbackWorker = $null
$PreviousVenv = $null
$EnvironmentSwapped = $false
$TranscriptStarted = $false

function Write-Phase {
    param([string]$Name, [int]$Percent)
    $script:Phase = $Name
    Write-Progress -Activity "Khora Effectif $Version" -Status $Name -PercentComplete $Percent
    Write-Host "[$Percent%] $Name"
}

function Test-RealPython {
    param([string]$Executable, [string[]]$PrefixArguments)
    if (-not $Executable -or -not (Test-Path $Executable)) { return $false }
    if ($Executable -like "*\WindowsApps\*") { return $false }
    try {
        & $Executable @PrefixArguments -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 2)" 2>$null
        return ($LASTEXITCODE -eq 0)
    } catch { return $false }
}

function Find-BasePython {
    $Launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($Launcher -and (Test-RealPython $Launcher.Source @("-3.11"))) {
        return [pscustomobject]@{ Exe = $Launcher.Source; Prefix = @("-3.11") }
    }
    $Candidates = @()
    $Candidates += Get-ChildItem (Join-Path $env:LOCALAPPDATA "Programs\Python\Python*\python.exe") -ErrorAction SilentlyContinue
    $Candidates += Get-ChildItem "C:\Program Files\Python*\python.exe" -ErrorAction SilentlyContinue
    $PathPython = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($PathPython -and $PathPython.Source -notlike "*\WindowsApps\*") {
        $Candidates += Get-Item $PathPython.Source
    }
    foreach ($Candidate in $Candidates | Sort-Object FullName -Descending) {
        if (Test-RealPython $Candidate.FullName @()) {
            return [pscustomobject]@{ Exe = $Candidate.FullName; Prefix = @() }
        }
    }
    return $null
}

function Get-WorkerProcesses {
    return @(
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like "*EffectifTranscriber*worker.py*" }
    )
}

function Stop-Workers {
    $Processes = Get-WorkerProcesses
    foreach ($Process in $Processes) {
        Stop-Process -Id $Process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    for ($Attempt = 0; $Attempt -lt 20; $Attempt++) {
        if ((Get-WorkerProcesses).Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    }
    throw "No se pudieron detener todos los procesos del motor."
}

function Test-LocalPort {
    $Client = New-Object System.Net.Sockets.TcpClient
    try {
        $Async = $Client.BeginConnect("127.0.0.1", 8765, $null, $null)
        if (-not $Async.AsyncWaitHandle.WaitOne(750)) { return $false }
        $Client.EndConnect($Async)
        return $true
    } catch { return $false } finally { $Client.Close() }
}

function Wait-LocalPort {
    param([int]$Seconds)
    for ($Index = 0; $Index -lt ($Seconds * 2); $Index++) {
        if (Test-LocalPort) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Test-Environment {
    param([string]$Python)
    if (-not (Test-RealPython $Python @())) { return $false }
    & $Python -c "import faster_whisper,ctranslate2,httpx,numpy,soundcard,websockets" 2>$null
    return ($LASTEXITCODE -eq 0)
}

function Install-PythonIfMissing {
    $PythonInfo = Find-BasePython
    if ($PythonInfo) { return $PythonInfo }
    $Winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $Winget) {
        throw "No hay Python 3.11 real ni winget. Instala Python 3.11 de python.org y repite."
    }
    & $Winget.Source install --id Python.Python.3.11 --exact --scope user --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "winget no pudo instalar Python 3.11. Codigo $LASTEXITCODE." }
    $Installed = Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\python.exe"
    if (-not (Test-RealPython $Installed @())) {
        throw "Python fue solicitado, pero no se encontro un ejecutable real en $Installed."
    }
    return [pscustomobject]@{ Exe = $Installed; Prefix = @() }
}

function Restore-PreviousEnvironment {
    if (-not $script:EnvironmentSwapped -or -not $script:PreviousVenv -or -not (Test-Path $script:PreviousVenv)) {
        return
    }
    Stop-Workers
    if (Test-Path $script:Venv) {
        $FailedVenv = Join-Path $script:Backup ".venv-fallido-$script:Timestamp"
        Move-Item $script:Venv $FailedVenv -Force
    }
    Move-Item $script:PreviousVenv $script:Venv -Force
    $script:EnvironmentSwapped = $false
}

try {
    Start-Transcript -Path $Log -Force | Out-Null
    $TranscriptStarted = $true
} catch {
    $TranscriptStarted = $false
}
try {
    Write-Host "KHORA EFFECTIF $Version - INSTALADOR TRANSACCIONAL" -ForegroundColor Cyan
    Write-Host "No borra una instalacion funcional y no controla Effectif." -ForegroundColor Green

    Write-Phase "Preflight de sistema" 10
    if (-not [Environment]::Is64BitOperatingSystem) { throw "Se requiere Windows de 64 bits." }
    New-Item -ItemType Directory -Force -Path $Base, $Backup | Out-Null
    $Probe = Join-Path $Base ".write-test-$Timestamp"
    "ok" | Set-Content $Probe -Encoding ASCII
    Remove-Item $Probe -Force
    $DriveName = [IO.Path]::GetPathRoot($Base).Substring(0, 1)
    $FreeBytes = (Get-PSDrive -Name $DriveName).Free
    $RequiredBytes = if (Test-Environment $VenvPython) { 512MB } else { 6GB }
    if ($FreeBytes -lt $RequiredBytes) {
        throw "Espacio insuficiente. Libre: $([math]::Round($FreeBytes/1GB,1)) GB; requerido: $([math]::Round($RequiredBytes/1GB,1)) GB."
    }

    Write-Phase "Validacion del entorno existente" 25
    if (Test-Environment $VenvPython) {
        $ReusedEnvironment = $true
        Write-Host "Entorno existente valido: se reutiliza sin descargar dependencias." -ForegroundColor Green
    } else {
        $PythonInfo = Install-PythonIfMissing
        $Staging = Join-Path $Base ".venv-staging-$Timestamp"
        if (Test-Path $Staging) { Remove-Item $Staging -Recurse -Force }
        $CreateArguments = @($PythonInfo.Prefix) + @("-m", "venv", $Staging)
        & $PythonInfo.Exe $CreateArguments
        if ($LASTEXITCODE -ne 0) { throw "No se pudo crear el entorno provisional." }
        $StagingPython = Join-Path $Staging "Scripts\python.exe"
        & $StagingPython -m pip install --disable-pip-version-check --upgrade pip
        if ($LASTEXITCODE -ne 0) { throw "No se pudo preparar pip." }
        & $StagingPython -m pip install --disable-pip-version-check --prefer-binary -r (Join-Path $Root "requirements.txt")
        if ($LASTEXITCODE -ne 0) { throw "No se pudieron instalar dependencias." }
        if (-not (Test-Environment $StagingPython)) { throw "El entorno provisional no supero la prueba de importacion." }
        Stop-Workers
        if (Test-Path $Venv) {
            $PreviousVenv = Join-Path $Backup ".venv-anterior-$Timestamp"
            Move-Item $Venv $PreviousVenv
        }
        Move-Item $Staging $Venv
        $EnvironmentSwapped = [bool]$PreviousVenv
    }

    Write-Phase "Preparacion atomica de archivos" 55
    $IncomingWorker = Join-Path $Base "worker.py.incoming"
    Copy-Item (Join-Path $Root "worker.py") $IncomingWorker -Force
    & $VenvPython -m py_compile $IncomingWorker
    if ($LASTEXITCODE -ne 0) { throw "El worker nuevo no compila." }
    Stop-Workers
    if (Test-LocalPort) {
        throw "El puerto 8765 sigue ocupado por un proceso ajeno; no se cerrara automaticamente."
    }
    if (Test-Path $Worker) {
        $RollbackWorker = Join-Path $Backup "worker-$Timestamp.py"
        Copy-Item $Worker $RollbackWorker -Force
    }
    Move-Item $IncomingWorker $Worker -Force
    Copy-Item (Join-Path $Root "requirements.txt") (Join-Path $Base "requirements.txt") -Force
    Copy-Item (Join-Path $Root "start-worker.cmd") (Join-Path $Base "start-worker.cmd") -Force

    Write-Phase "Activacion y verificacion" 75
    Start-Process -FilePath (Join-Path $Venv "Scripts\pythonw.exe") -ArgumentList "`"$Worker`""
    if (-not (Wait-LocalPort 15)) {
        Stop-Workers
        Restore-PreviousEnvironment
        if ($RollbackWorker -and (Test-Path $RollbackWorker)) {
            Copy-Item $RollbackWorker $Worker -Force
            Start-Process -FilePath (Join-Path $Venv "Scripts\pythonw.exe") -ArgumentList "`"$Worker`""
        }
        throw "El motor nuevo no abrio el puerto. Se restauro el worker anterior."
    }
    Start-Sleep -Seconds 2
    if (-not (Test-LocalPort)) {
        Stop-Workers
        Restore-PreviousEnvironment
        if ($RollbackWorker -and (Test-Path $RollbackWorker)) {
            Copy-Item $RollbackWorker $Worker -Force
            Start-Process -FilePath (Join-Path $Venv "Scripts\pythonw.exe") -ArgumentList "`"$Worker`""
            [void](Wait-LocalPort 10)
        }
        throw "El motor nuevo no permanecio estable. Se restauro el worker anterior."
    }

    $StartupText = "@echo off`r`ncall `"$Base\start-worker.cmd`"`r`n"
    $StartupText | Set-Content -Path $Startup -Encoding ASCII

    Write-Phase "Informe final" 95
    $Result = [ordered]@{
        schema = "khora-effectif-install/v3"
        version = $Version
        status = "installed"
        generatedAt = (Get-Date).ToString("o")
        reusedEnvironment = $ReusedEnvironment
        modelCachePreserved = $true
        workerProcesses = (Get-WorkerProcesses).Count
        port8765 = (Test-LocalPort)
        extensionPlatformAudioAccess = $false
        extensionPlatformAudioMutation = $false
        log = $Log
    }
    ($Result | ConvertTo-Json -Depth 5) | Set-Content $ReportPath -Encoding UTF8
    Write-Progress -Activity "Khora Effectif $Version" -Completed
    Write-Host "INSTALACION VERIFICADA." -ForegroundColor Green
    Write-Host "Reporte: $ReportPath"
    if ($TranscriptStarted) { Stop-Transcript | Out-Null }
    exit 0
} catch {
    $Message = $_.Exception.Message
    try { Restore-PreviousEnvironment } catch {}
    $Failure = [ordered]@{
        schema = "khora-effectif-install/v3"
        version = $Version
        status = "failed"
        phase = $Phase
        generatedAt = (Get-Date).ToString("o")
        error = $Message
        previousWorkerPreserved = [bool]($RollbackWorker -and (Test-Path $RollbackWorker))
        log = $Log
    }
    ($Failure | ConvertTo-Json -Depth 5) | Set-Content $ReportPath -Encoding UTF8
    Write-Progress -Activity "Khora Effectif $Version" -Completed
    Write-Host "INSTALACION NO ACTIVADA: $Message" -ForegroundColor Red
    Write-Host "La instalacion anterior no fue borrada."
    Write-Host "Reporte: $ReportPath"
    if ($TranscriptStarted) { try { Stop-Transcript | Out-Null } catch {} }
    exit 1
}