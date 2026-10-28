param([switch]$Production)

$ErrorActionPreference = 'Stop'

$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'

if (-not (Test-Path -LiteralPath $python)) {
    throw 'Create the backend environment first: python -m venv .venv, then .\.venv\Scripts\python.exe -m pip install -r requirements.txt (from the backend directory).'
}

Push-Location $PSScriptRoot
try {
    & $python (Join-Path $PSScriptRoot 'scripts\check_database_access.py')
    if ($LASTEXITCODE -ne 0) {
        throw 'Backend startup stopped because the drought database preflight failed.'
    }

    if ($Production) {
        & $python -m uvicorn app.main:app
    }
    else {
        & $python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
    }
    $serverExitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}

exit $serverExitCode
