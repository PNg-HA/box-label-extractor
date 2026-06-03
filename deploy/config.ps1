# Shared config for deploy scripts
$ErrorActionPreference = "Stop"
$env:AWS_PAGER = ""

$PROFILE_NAME  = "gapv50k"
$REGION        = "ap-southeast-1"
$ACCOUNT_ID    = "307711587176"
$MODEL_ID      = "global.anthropic.claude-opus-4-6-v1"

$PREFIX        = "gapv-label"
$STORAGE_BUCKET = "$PREFIX-storage-$ACCOUNT_ID"
$WEB_BUCKET     = "$PREFIX-web-$ACCOUNT_ID"
$API_FN         = "$PREFIX-api"
$WORKER_FN      = "$PREFIX-worker"
$API_ROLE       = "$PREFIX-api-role"
$WORKER_ROLE    = "$PREFIX-worker-role"
$API_NAME       = "$PREFIX-http-api"

function AWS { param([Parameter(ValueFromRemainingArguments=$true)]$args)
  & aws @args --profile $PROFILE_NAME --region $REGION
}
