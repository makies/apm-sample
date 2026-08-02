#!/usr/bin/env bash
# Creates two Application Signals SLOs against the backend service's
# GET /api/flaky operation: an availability target and a latency target.
#
# Prerequisites:
#   - ./scripts/enable-application-signals.sh has been run
#   - The stack is deployed and has received traffic (see generate-traffic.sh)
#     for at least a few minutes, so the operation is discoverable.
set -euo pipefail
command -v jq >/dev/null || { echo "jq is required (brew install jq)" >&2; exit 1; }

REGION="${AWS_REGION:-$(aws configure get region)}"
SERVICE_NAME="${SERVICE_NAME:-backend}"
ENVIRONMENT_NAME="${ENVIRONMENT_NAME:-apm-sample}"
OPERATION_MATCH="${OPERATION_MATCH:-flaky}"

NOW=$(date +%s)
START=$((NOW - 3600))

echo "Looking up '$SERVICE_NAME' in Application Signals (region: $REGION) ..."
KEY_ATTRS=$(aws application-signals list-services \
  --region "$REGION" \
  --start-time "$START" --end-time "$NOW" \
  --query "ServiceSummaries[?KeyAttributes.Name=='${SERVICE_NAME}' && KeyAttributes.Environment=='${ENVIRONMENT_NAME}'].KeyAttributes | [0]" \
  --output json)

if [ -z "$KEY_ATTRS" ] || [ "$KEY_ATTRS" = "null" ]; then
  echo "Service '$SERVICE_NAME' not found yet. Deploy, send traffic, wait a few" >&2
  echo "minutes, then re-run this script." >&2
  exit 1
fi
echo "Found service: $KEY_ATTRS"

echo "Looking up an operation matching '*${OPERATION_MATCH}*' ..."
OPERATION_NAME=$(aws application-signals list-service-operations \
  --region "$REGION" \
  --start-time "$START" --end-time "$NOW" \
  --key-attributes "$KEY_ATTRS" \
  --query "ServiceOperations[?contains(Name, '${OPERATION_MATCH}')].Name | [0]" \
  --output text)

if [ -z "$OPERATION_NAME" ] || [ "$OPERATION_NAME" = "None" ]; then
  echo "No operation matching '*${OPERATION_MATCH}*' found yet. Send more traffic" >&2
  echo "with ./scripts/generate-traffic.sh and retry." >&2
  exit 1
fi
echo "Found operation: $OPERATION_NAME"

echo "Creating availability SLO ..."
aws application-signals create-service-level-objective \
  --region "$REGION" \
  --name "backend-flaky-availability" \
  --description "At least 90% of GET /api/flaky requests must succeed" \
  --sli-config "$(jq -n --argjson ka "$KEY_ATTRS" --arg op "$OPERATION_NAME" '{
    SliMetricConfig: { KeyAttributes: $ka, OperationName: $op, MetricType: "AVAILABILITY", PeriodSeconds: 60 },
    MetricThreshold: 99,
    ComparisonOperator: "GreaterThanOrEqualTo"
  }')" \
  --goal '{"Interval":{"RollingInterval":{"DurationUnit":"DAY","Duration":1}},"AttainmentGoal":90,"WarningThreshold":50}' \
  >/dev/null && echo "  created: backend-flaky-availability"

echo "Creating latency SLO (P90 <= 1000ms) ..."
aws application-signals create-service-level-objective \
  --region "$REGION" \
  --name "backend-flaky-latency-p90" \
  --description "P90 latency of GET /api/flaky must stay under 1000ms" \
  --sli-config "$(jq -n --argjson ka "$KEY_ATTRS" --arg op "$OPERATION_NAME" '{
    SliMetricConfig: { KeyAttributes: $ka, OperationName: $op, MetricType: "LATENCY", Statistic: "p90", PeriodSeconds: 60 },
    MetricThreshold: 1000,
    ComparisonOperator: "LessThanOrEqualTo"
  }')" \
  --goal '{"Interval":{"RollingInterval":{"DurationUnit":"DAY","Duration":1}},"AttainmentGoal":90,"WarningThreshold":50}' \
  >/dev/null && echo "  created: backend-flaky-latency-p90"

echo "Done. View them at:"
echo "  https://console.aws.amazon.com/cloudwatch/home?region=${REGION}#application-signals/slos"
