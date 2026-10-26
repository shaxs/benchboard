$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop'
Push-Location "$PSScriptRoot/.."
try {
 npm ci --no-audit --no-fund
 if($LASTEXITCODE -ne 0){throw 'Owner dependency setup failed'}
 Push-Location starter
 try {npm ci --no-audit --no-fund;if($LASTEXITCODE -ne 0){throw 'Public dependency setup failed'}} finally {Pop-Location}
 npx playwright install chromium
 if($LASTEXITCODE -ne 0){throw 'Browser setup failed'}
 node runner/prepare-manifest.mjs
 if($LASTEXITCODE -ne 0){throw 'Candidate manifest setup failed'}
} finally {Pop-Location}
