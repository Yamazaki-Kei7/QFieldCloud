#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { CONFIG } from "../lib/config";

const app = new cdk.App();

export const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: CONFIG.region,
};

// Stacks are appended here in later tasks.

app.synth();
