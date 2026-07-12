<#
.SYNOPSIS
  Create Python venv + install ML dependencies for mmo-chip-a sidecar.
#>
$ErrorActionPreference = "Stop"
$root = Split-Path -Path $MyInvocation.MyCommand.Path -Parent
$root = Split-Path -Path $root -Parent
Set-Location -Path $root

Write-Host "Creating Python venv..." -ForegroundColor Green
python -m venv ml\.venv

Write-Host "Installing dependencies..." -ForegroundColor Green
& "ml\.venv\Scripts\pip" install -r ml\requirements.txt

Write-Host "Done!" -ForegroundColor Green
Write-Host "Run 'npm run sidecar' to start the ML sidecar." -ForegroundColor Cyan
