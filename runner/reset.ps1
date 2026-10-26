param([Parameter(Mandatory=$true)][string]$RunId)
$ErrorActionPreference='Stop'
node "$PSScriptRoot/reset.mjs" $RunId
if($LASTEXITCODE -ne 0){throw 'Reset failed'}
