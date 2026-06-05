# Re-zip and update both Lambdas + re-upload frontend. Run from this folder.
$ErrorActionPreference = "Stop"
$env:AWS_PAGER = ""
$PROFILE_NAME = "gapv50k"
$REGION = "ap-southeast-1"
$WEB_BUCKET = "gapv-label-web-307711587176"
$ROOT = Split-Path $PSScriptRoot -Parent   # ...\app

Write-Host "== Zipping API ==" -ForegroundColor Cyan
Push-Location "$ROOT\backend\api"
Compress-Archive -Path .\index.mjs,.\node_modules,.\package.json -DestinationPath "$PSScriptRoot\api.zip" -Force
Pop-Location

Write-Host "== Zipping Worker ==" -ForegroundColor Cyan
Push-Location "$ROOT\backend\worker"
# Ensure sharp has the Linux x64 native binaries (Lambda runtime), not just Windows.
npm install --omit=dev --include=optional --os=linux --libc=glibc --cpu=x64 sharp | Out-Null
Compress-Archive -Path .\index.mjs,.\holes.mjs,.\textract.mjs,.\node_modules,.\package.json -DestinationPath "$PSScriptRoot\worker.zip" -Force
Pop-Location

Write-Host "== Updating Lambda code ==" -ForegroundColor Cyan
aws lambda update-function-code --function-name gapv-label-api --zip-file "fileb://$PSScriptRoot\api.zip" --region $REGION --profile $PROFILE_NAME --query "LastModified" --output text
aws lambda update-function-code --function-name gapv-label-worker --zip-file "fileb://$PSScriptRoot\worker.zip" --region $REGION --profile $PROFILE_NAME --query "LastModified" --output text

Write-Host "== Uploading frontend ==" -ForegroundColor Cyan
aws s3 cp "$ROOT\frontend" "s3://$WEB_BUCKET/" --recursive --exclude "*" --include "*.html" --include "*.css" --include "*.js" --profile $PROFILE_NAME

Write-Host "Done." -ForegroundColor Green
Write-Host "Site: http://$WEB_BUCKET.s3-website-$REGION.amazonaws.com"
