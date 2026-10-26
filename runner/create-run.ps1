param([Parameter(Mandatory=$true)][string]$RunId,[string]$RunBase=(Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'BenchBoard-Runs'),[Parameter(Mandatory=$true)][int]$TimeCeilingMinutes)
$ErrorActionPreference='Stop'
node "$PSScriptRoot/create-run.mjs" $RunId $RunBase $TimeCeilingMinutes
if($LASTEXITCODE -ne 0){throw 'Run creation failed'}
