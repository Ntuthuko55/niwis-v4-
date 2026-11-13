param([switch]$Production)

$ErrorActionPreference = 'Stop'

$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'

if (-not (Test-Path -LiteralPath $python)) {
    throw 'Create the backend environment first: python -m venv .venv, then .\.venv\Scripts\python.exe -m pip install -r requirements.txt (from the backend directory).'
}

$previousNiwisEnvironment = $env:NIWIS_ENV
if ($Production) {
    # Production CORS defaults are deliberately closed unless a same-origin
    # proxy is used or NIWIS_CORS_ORIGINS lists the deployed HTTPS frontend.
    $env:NIWIS_ENV = 'production'
}

Push-Location $PSScriptRoot
try {
    & $python (Join-Path $PSScriptRoot 'scripts\check_database_access.py')
    if ($LASTEXITCODE -ne 0) {
        throw 'Backend startup stopped because the configured database preflight failed.'
    }

    & $python -m app.spatial.prepare_landcover
    if ($LASTEXITCODE -ne 0) {
        throw 'Backend startup stopped because the spatial raster preview could not be prepared.'
    }

    if ($Production) {
        # Bind to the container interface and honor the hosting platform's port.
        # Keep one Uvicorn process because forecast datasets and job state are
        # currently held in process memory.
        $apiPort = 8000
        if ($env:PORT) {
            $apiPort = 0
            if (-not [int]::TryParse($env:PORT, [ref]$apiPort) -or $apiPort -lt 1 -or $apiPort -gt 65535) {
                throw 'PORT must be an integer between 1 and 65535.'
            }
        }
        & $python -m uvicorn app.main:app --host 0.0.0.0 --port $apiPort
    }
    else {
        & $python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
    }
    $serverExitCode = $LASTEXITCODE
}
finally {
    Pop-Location
    if ($Production) {
        if ($null -eq $previousNiwisEnvironment) {
            Remove-Item Env:\NIWIS_ENV -ErrorAction SilentlyContinue
        }
        else {
            $env:NIWIS_ENV = $previousNiwisEnvironment
        }
    }
}

exit $serverExitCode
