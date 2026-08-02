#!/usr/bin/env bash
# One-time, account+region wide: required for CloudWatch Application Signals
# support on PHP/Ruby (no ADOT distro exists for those -- AWS routes them
# through Transaction Search instead). Also changes how ALL X-Ray trace
# ingestion works in this account/region (100% of spans ingested as
# structured logs into the `aws/spans` log group; 1% indexed as trace
# summaries by default, which is free).
# https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Enable-TransactionSearch.html
set -euo pipefail

REGION="${AWS_REGION:-$(aws configure get region)}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
INDEX_PERCENT="${INDEX_PERCENT:-1}"

echo "Enabling Transaction Search in $ACCOUNT_ID/$REGION (indexing ${INDEX_PERCENT}% of spans) ..."

POLICY_DOCUMENT=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TransactionSearchXRayAccess",
      "Effect": "Allow",
      "Principal": { "Service": "xray.amazonaws.com" },
      "Action": "logs:PutLogEvents",
      "Resource": [
        "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:aws/spans:*",
        "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/application-signals/data:*"
      ],
      "Condition": {
        "ArnLike": { "aws:SourceArn": "arn:aws:xray:${REGION}:${ACCOUNT_ID}:*" },
        "StringEquals": { "aws:SourceAccount": "${ACCOUNT_ID}" }
      }
    }
  ]
}
EOF
)

aws logs put-resource-policy \
  --region "$REGION" \
  --policy-name "TransactionSearchXRayAccess" \
  --policy-document "$POLICY_DOCUMENT" >/dev/null
echo "  resource policy granted (xray -> logs:PutLogEvents)"

aws xray update-trace-segment-destination --region "$REGION" --destination CloudWatchLogs >/dev/null
echo "  trace segment destination set to CloudWatchLogs"

aws xray update-indexing-rule --region "$REGION" --name "Default" \
  --rule "{\"Probabilistic\": {\"DesiredSamplingPercentage\": ${INDEX_PERCENT}}}" >/dev/null
echo "  indexing rule set to ${INDEX_PERCENT}%"

echo "Verifying ..."
aws xray get-trace-segment-destination --region "$REGION"
echo "Done. Allow up to 10 minutes for spans to become searchable."
