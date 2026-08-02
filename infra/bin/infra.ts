#!/usr/bin/env node
import 'source-map-support/register'
import * as cdk from 'aws-cdk-lib'
import { ApmSampleStack } from '../lib/apm-sample-stack'

const app = new cdk.App()

new ApmSampleStack(app, 'ApmSampleStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
})
