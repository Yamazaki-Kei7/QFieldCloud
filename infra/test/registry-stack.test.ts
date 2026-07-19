import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { RegistryStack, REPO_NAMES } from "../lib/registry-stack";

const synth = (): Template => {
  const app = new cdk.App();
  const env = { account: "123456789012", region: "ap-northeast-1" };
  const registry = new RegistryStack(app, "TestRegistry", { env });
  return Template.fromStack(registry);
};

test("creates one ECR repository per image", () => {
  const template = synth();
  template.resourceCountIs("AWS::ECR::Repository", REPO_NAMES.length);
  for (const name of REPO_NAMES) {
    template.hasResourceProperties("AWS::ECR::Repository", {
      RepositoryName: `qfc-${name}`,
    });
  }
});

test("repositories are retained on stack deletion (images must survive a stack teardown)", () => {
  const template = synth();
  const repos = template.findResources("AWS::ECR::Repository", {
    DeletionPolicy: "Retain",
  });
  expect(Object.keys(repos)).toHaveLength(REPO_NAMES.length);
});

test("repositories have image scan on push enabled", () => {
  const template = synth();
  template.hasResourceProperties("AWS::ECR::Repository", {
    ImageScanningConfiguration: { ScanOnPush: true },
  });
});
