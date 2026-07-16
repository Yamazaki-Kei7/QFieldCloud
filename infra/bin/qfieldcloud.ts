#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { CONFIG } from "../lib/config";

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: CONFIG.region,
};
// `env` is not yet consumed because no stack exists (noUnusedLocals). Remove
// this line once Task 3 wires `env` into the first stack's props.
void env;

// Stacks are appended here in later tasks.

app.synth();
