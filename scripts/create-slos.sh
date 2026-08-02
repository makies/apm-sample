#!/usr/bin/env bash
# Creates availability + latency Application Signals SLOs for one
# representative operation per service in this sample.
#
# Prerequisites:
#   - ./scripts/enable-application-signals.sh (Node/NestJS) and
#     ./scripts/enable-transaction-search.sh (Laravel) have been run
#   - The stack has received traffic (see generate-traffic.sh) for at
#     least a few minutes, so each operation is discoverable.
#
# Notes on operation names:
#   - backend/nest use OTEL_AWS_HTTP_OPERATION_PATHS (ADOT-only), so their
#     operations are exact routes (e.g. "GET /nest/notes").
#   - laravel has no ADOT distro, so Application Signals collapses every
#     route to its first path segment: both /laravel/health and
#     /laravel/notes show up as "GET /laravel" or "POST /laravel". We
#     target "POST /laravel", which is unambiguous (only /laravel/notes
#     accepts POST).
set -euo pipefail
command -v jq >/dev/null || { echo "jq is required (brew install jq)" >&2; exit 1; }

REGION="${AWS_REGION:-$(aws configure get region)}"
ENVIRONMENT_NAME="${ENVIRONMENT_NAME:-apm-sample}"
NOW=$(date +%s)
START=$((NOW - 3600))

# name-prefix | service | operation | avail-goal | latency-threshold-ms | latency-goal
SLO_DEFS=(
  "backend-flaky|backend|GET /api/flaky|90|1000|90"
  "frontend-home|frontend|GET /|99|500|95"
  "nest-notes|nest|GET /nest/notes|99|500|95"
  "laravel-notes|laravel|POST /laravel|99|1000|95"
)

create_slo() {
  local prefix="$1" service="$2" operation="$3" avail_goal="$4" latency_ms="$5" latency_goal="$6"

  echo "Looking up '$service' in Application Signals ..."
  local key_attrs
  key_attrs=$(aws application-signals list-services \
    --region "$REGION" \
    --start-time "$START" --end-time "$NOW" \
    --query "ServiceSummaries[?KeyAttributes.Name=='${service}' && KeyAttributes.Environment=='${ENVIRONMENT_NAME}'].KeyAttributes | [0]" \
    --output json)

  if [ -z "$key_attrs" ] || [ "$key_attrs" = "null" ]; then
    echo "  '$service' not found yet, skipping. Deploy + send traffic + retry." >&2
    return
  fi

  local operations
  operations=$(aws application-signals list-service-operations \
    --region "$REGION" --start-time "$START" --end-time "$NOW" \
    --key-attributes "$key_attrs" --query 'ServiceOperations[].Name' --output json)
  if ! echo "$operations" | jq -e --arg op "$operation" 'index($op)' >/dev/null; then
    echo "  operation '$operation' not seen yet for '$service' (seen: $(echo "$operations" | jq -c .)), skipping." >&2
    return
  fi

  echo "  creating ${prefix}-availability (${operation}, >=${avail_goal}%) ..."
  aws application-signals create-service-level-objective \
    --region "$REGION" \
    --name "${prefix}-availability" \
    --description "At least ${avail_goal}% of ${operation} requests must succeed" \
    --sli-config "$(jq -n --argjson ka "$key_attrs" --arg op "$operation" '{
      SliMetricConfig: { KeyAttributes: $ka, OperationName: $op, MetricType: "AVAILABILITY", PeriodSeconds: 60 },
      MetricThreshold: 99,
      ComparisonOperator: "GreaterThanOrEqualTo"
    }')" \
    --goal "$(jq -n --argjson g "$avail_goal" '{Interval:{RollingInterval:{DurationUnit:"DAY",Duration:1}},AttainmentGoal:$g,WarningThreshold:50}')" \
    >/dev/null 2>&1 && echo "    created" || echo "    already exists or failed, skipping"

  echo "  creating ${prefix}-latency-p90 (${operation}, P90 <= ${latency_ms}ms) ..."
  aws application-signals create-service-level-objective \
    --region "$REGION" \
    --name "${prefix}-latency-p90" \
    --description "P90 latency of ${operation} must stay under ${latency_ms}ms" \
    --sli-config "$(jq -n --argjson ka "$key_attrs" --arg op "$operation" --argjson threshold "$latency_ms" '{
      SliMetricConfig: { KeyAttributes: $ka, OperationName: $op, MetricType: "LATENCY", Statistic: "p90", PeriodSeconds: 60 },
      MetricThreshold: $threshold,
      ComparisonOperator: "LessThanOrEqualTo"
    }')" \
    --goal "$(jq -n --argjson g "$latency_goal" '{Interval:{RollingInterval:{DurationUnit:"DAY",Duration:1}},AttainmentGoal:$g,WarningThreshold:50}')" \
    >/dev/null 2>&1 && echo "    created" || echo "    already exists or failed, skipping"
}

for def in "${SLO_DEFS[@]}"; do
  IFS='|' read -r prefix service operation avail_goal latency_ms latency_goal <<< "$def"
  create_slo "$prefix" "$service" "$operation" "$avail_goal" "$latency_ms" "$latency_goal"
done

echo "Done. View SLOs at:"
echo "  https://console.aws.amazon.com/cloudwatch/home?region=${REGION}#application-signals/slos"
