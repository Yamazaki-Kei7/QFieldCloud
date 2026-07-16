import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { NetworkStack } from "../lib/network-stack";

const synth = (): Template => {
  const app = new cdk.App();
  const stack = new NetworkStack(app, "TestNetwork", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  return Template.fromStack(stack);
};

test("VPC is dual stack with no NAT gateways", () => {
  const template = synth();
  template.resourceCountIs("AWS::EC2::NatGateway", 0);
  template.resourceCountIs("AWS::EC2::VPCCidrBlock", 1); // IPv6 CIDR association
  template.hasResourceProperties("AWS::EC2::VPCCidrBlock", {
    AmazonProvidedIpv6CidrBlock: true,
  });
});

test("has public and isolated subnets across 2 AZs", () => {
  const template = synth();
  template.resourceCountIs("AWS::EC2::Subnet", 4);
});

test("has an S3 gateway endpoint", () => {
  const template = synth();
  template.resourceCountIs("AWS::EC2::VPCEndpoint", 1);
});
