param([switch]$Production)

$ErrorActionPreference = 'Stop'

$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'

if (-not (Test-Path -LiteralPath $python)) {
    throw 'Create the backend environment first: python -m venv .venv, then .\.venv\Scripts\python.exe -m pip install -r requirements.txt (from the backend directory).'
}

Push-Location $PSScriptRoot
try {
    if ($Production) {
        & $python -m uvicorn app.main:app
    }
    else {
        & $python -m uvicorn app.main:app --reload
    }
    $serverExitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}

exit $serverExitCode
