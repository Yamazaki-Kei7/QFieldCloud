import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { NetworkStack } from "../lib/network-stack";
import { DataStack } from "../lib/data-stack";
import { FrontendStack } from "../lib/frontend-stack";
import { RegistryStack } from "../lib/registry-stack";
import { AppStack } from "../lib/app-stack";
import { OpsStack } from "../lib/ops-stack";

const synth = (): Template => {
  const app = new cdk.App();
  const env = { account: "123456789012", region: "ap-northeast-1" };
  const network = new NetworkStack(app, "TestNetwork", { env });
  const data = new DataStack(app, "TestData", { env, vpc: network.vpc });
  const frontend = new FrontendStack(app, "TestFrontend", { env });
  const registry = new RegistryStack(app, "TestRegistry", { env });
  const appStack = new AppStack(app, "TestApp", {
    env, vpc: network.vpc, data,
    frontendBucket: frontend.bucket, frontendDistribution: frontend.distribution,
    repositories: registry.repositories,
  });
  const ops = new OpsStack(app, "TestOps", { env, appStack, data });
  return Template.fromStack(ops);
};

test("has an SNS topic with email subscription", () => {
  const template = synth();
  template.resourceCountIs("AWS::SNS::Topic", 1);
  template.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email" });
});

test("has alarms for ALB 5xx and unhealthy hosts", () => {
  const template = synth();
  const alarms = template.findResources("AWS::CloudWatch::Alarm");
  expect(Object.keys(alarms).length).toBeGreaterThanOrEqual(4);
});

test("schedules the monthly grids mirror task", () => {
  const template = synth();
  template.resourceCountIs("AWS::Events::Rule", 1);
});
