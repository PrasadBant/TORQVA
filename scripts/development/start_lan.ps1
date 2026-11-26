[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^(?:\d{1,3}\.){3}\d{1,3}$')]
    [string]$LanHost,
    [switch]$AutoConnectUsb
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$frontend = Join-Path $repo 'frontend'
$env:TORQVA_LAN_HOST = $LanHost
$env:TORQVA_AUTOCONNECT = if ($AutoConnectUsb) { '1' } else { '0' }

Write-Host "Starting TORQVA LAN mode for $LanHost"
Write-Host 'USB autoconnect:' ($(if ($AutoConnectUsb) { 'enabled' } else { 'disabled; connect deliberately in Hardware Manager' }))
& 'C:\Program Files\nodejs\npm.cmd' run dev:lan --prefix $frontend
exit $LASTEXITCODE
