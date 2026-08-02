#!/usr/bin/env bash
# Tears down every resource this sample created. Run this when you're done
# so you stop paying for the ALB / Fargate tasks.
set -euo pipefail
cd "$(dirname "$0")/../infra"

npx cdk destroy --force "$@"

echo
echo "Note: SLOs created by scripts/create-slos.sh are not part of the CDK"
echo "stack and are NOT deleted by cdk destroy. Remove them with:"
echo "  aws application-signals delete-service-level-objective --name backend-flaky-availability"
echo "  aws application-signals delete-service-level-objective --name backend-flaky-latency-p90"
