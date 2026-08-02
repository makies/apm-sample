#!/usr/bin/env bash
# One-time, account+region wide: grants Application Signals permission to
# discover services (creates the AWSServiceRoleForCloudWatchApplicationSignals
# service-linked role). Safe to re-run.
set -euo pipefail

REGION="${AWS_REGION:-$(aws configure get region)}"
if [ -z "$REGION" ]; then
  echo "No region configured. Set AWS_REGION or run 'aws configure set region <region>'." >&2
  exit 1
fi

echo "Enabling CloudWatch Application Signals discovery in region: $REGION"
aws application-signals start-discovery --region "$REGION"
echo "Done. It can take a few minutes for the service-linked role to propagate."
