#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { CONFIG } from "../lib/config";
import { NetworkStack } from "../lib/network-stack";
import { DataStack } from "../lib/data-stack";
import { FrontendStack } from "../lib/frontend-stack";
import { RegistryStack } from "../lib/registry-stack";
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
// Deployed before QfcApp so images can be pushed (infra/scripts/push-images.sh)
// before the ECS services that pull them are created.
const registry = new RegistryStack(app, "QfcRegistry", { env });
const appStack = new AppStack(app, "QfcApp", {
  env,
  vpc: network.vpc,
  data,
  frontendBucket: frontend.bucket,
  frontendDistribution: frontend.distribution,
  repositories: registry.repositories,
});
new OpsStack(app, "QfcOps", { env, appStack, data });

app.synth();
