#!/usr/bin/env bash
# Builds both app images (via CDK's Docker asset bundling) and deploys the
# stack. Requires Docker running locally and AWS credentials configured
# (aws sso login / aws configure).
set -euo pipefail
cd "$(dirname "$0")/../infra"

npm install
npx cdk bootstrap
npx cdk deploy --require-approval never "$@"
