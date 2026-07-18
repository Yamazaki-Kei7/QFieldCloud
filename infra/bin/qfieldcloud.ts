#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { CONFIG } from "../lib/config";
import { NetworkStack } from "../lib/network-stack";
import { DataStack } from "../lib/data-stack";
import { FrontendStack } from "../lib/frontend-stack";
import { AppStack } from "../lib/app-stack";
import { OpsStack } from "../lib/ops-stack";

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: CONFIG.region,
};

const network = new NetworkStack(app, "QfcNetwork", { env });
const data = new DataStack(app, "QfcData", { env, vpc: network.vpc });
const frontend = new FrontendStack(app, "QfcFrontend", { env });
const appStack = new AppStack(app, "QfcApp", {
  env,
  vpc: network.vpc,
  data,
  frontendBucket: frontend.bucket,
  frontendDistribution: frontend.distribution,
});
new OpsStack(app, "QfcOps", { env, appStack, data });

app.synth();
