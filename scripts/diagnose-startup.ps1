# Run this script as the FIRST Pi launch in each new terminal tab/window.
# It preserves the current cwd, command/shim and inherited TTY handles.
[CmdletBinding()]
param(
    [ValidateSet('normal', 'focus-off', 'no-extensions', 'recap-only')]
    [string]$Case = 'normal',
    [string]$PiCommand = 'pi',
    [string]$OutputDirectory,
    [string[]]$PiArguments = @()
)

$ErrorActionPreference = 'Stop'
$probe = Join-Path $PSScriptRoot 'startup-probe.cjs'
$extension = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../index.ts'))
if (-not (Test-Path -LiteralPath $probe -PathType Leaf)) { throw "Missing probe: $probe" }
if ($probe.Contains('"')) { throw 'The preload path must not contain a double quote.' }
# Resolve only; deliberately do NOT run pi --version, npm or a warm-up Pi first.
$null = Get-Command $PiCommand -ErrorAction Stop
if (-not $OutputDirectory) {
    $root = Join-Path ([IO.Path]::GetTempPath()) 'pi-startup-traces'
    $OutputDirectory = Join-Path $root ((Get-Date -Format 'yyyyMMdd-HHmmss-fff') + "-$Case-$PID")
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$null = New-Item -ItemType Directory -Path $OutputDirectory -Force
@{
    case = $Case
    powershell = $PSVersionTable.PSVersion.ToString()
    started = (Get-Date).ToString('o')
    note = 'No cwd, argv, environment values, prompts or model output are recorded.'
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'run.json') -Encoding utf8

$names = @('NODE_OPTIONS', 'PI_STARTUP_TRACE_DIR', 'PI_RECAP_FOCUS')
$saved = @{}
foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$launchArgs = @($PiArguments)
switch ($Case) {
    'no-extensions' { $launchArgs = @('--no-extensions') + $launchArgs }
    'recap-only' { $launchArgs = @('--no-extensions', '-e', $extension) + $launchArgs }
}
Write-Host "Trace directory: $OutputDirectory"
Write-Host "Case: $Case. Reproduce without changing tabs if possible; no need to send a model prompt."
Write-Host 'If stuck, leave it for about 10 seconds, then Ctrl+C. Logs are already on disk.'
try {
    $env:PI_STARTUP_TRACE_DIR = $OutputDirectory
    $env:NODE_OPTIONS = ((@($saved['NODE_OPTIONS'], ('--require "' + $probe + '"')) | Where-Object { $_ }) -join ' ')
    if ($Case -eq 'focus-off') { $env:PI_RECAP_FOCUS = '0' }
    else { Remove-Item Env:PI_RECAP_FOCUS -ErrorAction SilentlyContinue }
    # No pipe, Tee-Object, redirected stdin/stdout or replacement shell here.
    & $PiCommand @launchArgs
}
finally {
    foreach ($name in $names) {
        [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process')
    }
    Write-Host "Trace saved: $OutputDirectory"
}
