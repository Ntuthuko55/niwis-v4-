param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path.TrimEnd('\')
$workspacePrefix = $workspaceRoot + '\'

function Get-ProjectCsv {
    Push-Location -LiteralPath $workspaceRoot
    try {
        $paths = @(& rg --files --hidden --no-ignore -g '*.[cC][sS][vV]' `
            -g '!**/node_modules/**' -g '!**/.venv/**' -g '!**/venv/**' `
            -g '!.git/**' -g '!.codex/**' -g '!.agents/**' -g '!.aws/**')
        if ($LASTEXITCODE -gt 1) { throw 'CSV inventory failed.' }
        return $paths
    } finally { Pop-Location }
}

function Resolve-ProjectFile([string]$Relative) {
    $resolved = (Resolve-Path -LiteralPath (Join-Path $workspaceRoot $Relative)).Path
    if (-not $resolved.StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Target is outside the workspace: $Relative"
    }
    $item = Get-Item -LiteralPath $resolved
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Target must be a regular project file: $Relative"
    }
    return $resolved
}

$csvPaths = @(Get-ProjectCsv)
$retiredCode = @('backend/app/climate_csv_source.py', 'backend/compare_climate_sources.py',
    'scripts/audit_surface_water.py', 'scripts/audit_reservoir_data.py') |
    Where-Object { Test-Path -LiteralPath (Join-Path $workspaceRoot $_) -PathType Leaf }
$targets = @($csvPaths + $retiredCode | Sort-Object -Unique)
if (-not $csvPaths.Count) {
    Write-Output 'No project CSV files remain.'
    exit 0
}
$inventory = @($targets | ForEach-Object {
    $resolved = Resolve-ProjectFile $_
    [pscustomobject]@{ path = $_.Replace('\', '/'); bytes = (Get-Item -LiteralPath $resolved).Length;
        sha256 = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant() }
})
$csvBytes = ($inventory | Where-Object { $_.path -match '(?i)\.csv$' } | Measure-Object bytes -Sum).Sum
if (-not $Apply) {
    [pscustomobject]@{ csv_files = $csvPaths.Count; csv_bytes = $csvBytes;
        retired_code_files = @($retiredCode).Count; action = 'Preview only; use -Apply to archive and remove.' } | ConvertTo-Json
    exit 0
}

$archivePath = Join-Path ([IO.Path]::GetTempPath()) ('niwis-csv-recovery-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
$manifest = [ordered]@{ status = 'archived'; backup = $archivePath; csv_files = $csvPaths.Count;
    csv_bytes = $csvBytes; retired_code_files = @($retiredCode).Count; files = $inventory }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Create)
try {
    $completed = 0
    foreach ($file in $inventory) {
        $resolved = Resolve-ProjectFile $file.path
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $resolved, $file.path, [IO.Compression.CompressionLevel]::Fastest)
        $completed++
        if ($completed % 10 -eq 0) { Write-Output "Archived $completed of $($inventory.Count) files." }
    }
    $manifestEntry = $archive.CreateEntry('_csv-removal-manifest.json')
    $writer = New-Object IO.StreamWriter($manifestEntry.Open())
    try { $writer.Write(($manifest | ConvertTo-Json -Depth 6)) } finally { $writer.Dispose() }
} finally { $archive.Dispose() }

# Verify both the stored archive content and current originals before removal.
$archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    foreach ($file in $inventory) {
        $entry = $archive.GetEntry($file.path)
        if (-not $entry -or $entry.Length -ne $file.bytes) { throw "Archive entry mismatch: $($file.path)" }
        $stream = $entry.Open()
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try { $digest = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
        finally { $algorithm.Dispose(); $stream.Dispose() }
        if ($digest -ne $file.sha256) { throw "Archive checksum mismatch: $($file.path)" }
        $resolved = Resolve-ProjectFile $file.path
        if ((Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) {
            throw "File changed after backup: $($file.path)"
        }
    }
} finally { $archive.Dispose() }

foreach ($file in $inventory) { Remove-Item -LiteralPath (Resolve-ProjectFile $file.path) }
$remaining = @(Get-ProjectCsv)
if ($remaining.Count) { throw 'Unexpected CSV files remain after cleanup.' }
$manifest.status = 'removed'
$manifest.remaining_project_csv_files = $remaining.Count
$manifestPath = Join-Path $workspaceRoot 'output/deployment-audit/csv-removal-manifest.json'
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
[pscustomobject]@{ removed_csv_files = $csvPaths.Count; csv_mib = [math]::Round($csvBytes / 1MB, 2);
    removed_retired_code_files = @($retiredCode).Count; recovery_archive = $archivePath;
    remaining_project_csv_files = $remaining.Count } | ConvertTo-Json
