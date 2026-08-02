#!/usr/bin/env bash
# Hits every demo endpoint in a loop so Application Signals has traces/metrics
# to show (service map, SLOs, X-Ray traces all need real request volume).
#
# Usage:
#   ./scripts/generate-traffic.sh [SITE_URL] [DURATION_SECONDS]
#
# If SITE_URL is omitted, it's read from the ApmSampleStack CloudFormation
# output. Defaults to 180 seconds of traffic, a few requests per second.
set -euo pipefail

STACK_NAME="${STACK_NAME:-ApmSampleStack}"
SITE_URL="${1:-}"
DURATION="${2:-180}"

if [ -z "$SITE_URL" ]; then
  SITE_URL=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='SiteUrl'].OutputValue" \
    --output text)
fi

if [ -z "$SITE_URL" ] || [ "$SITE_URL" = "None" ]; then
  echo "Could not resolve the site URL. Pass it explicitly: $0 http://<alb-dns-name>" >&2
  exit 1
fi

echo "Generating traffic against $SITE_URL for ${DURATION}s ..."
END=$((SECONDS + DURATION))
count=0
while [ $SECONDS -lt $END ]; do
  curl -s -o /dev/null "$SITE_URL/api/items" || true
  curl -s -o /dev/null -X POST -H 'content-type: application/json' \
    -d "{\"text\":\"traffic-gen $(date -u +%FT%TZ)\"}" "$SITE_URL/api/items" || true
  curl -s -o /dev/null "$SITE_URL/api/external" || true
  # Hit /api/flaky a few times per loop -- it's the operation the SLOs track.
  for _ in 1 2 3; do
    curl -s -o /dev/null "$SITE_URL/api/flaky" || true
  done
  count=$((count + 1))
  sleep 1
done
echo "Sent traffic for ${DURATION}s across $count loop iterations."
echo "Data should start appearing in Application Signals within a few minutes:"
echo "  https://console.aws.amazon.com/cloudwatch/home#application-signals/services"
