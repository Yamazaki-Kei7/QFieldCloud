import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
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

test("public subnets route to the internet gateway; isolated subnets have no egress", () => {
  const template = synth();

  // public subnets auto-assign public IPv4 (Fargate launch dependencies need an IPv4 path)
  template.hasResourceProperties("AWS::EC2::Subnet", Match.objectLike({ MapPublicIpOnLaunch: true }));

  // IPv4 and IPv6 default routes exist and point at the internet gateway
  template.hasResourceProperties("AWS::EC2::Route", Match.objectLike({
    DestinationCidrBlock: "0.0.0.0/0",
    GatewayId: Match.anyValue(),
  }));
  template.hasResourceProperties("AWS::EC2::Route", Match.objectLike({
    DestinationIpv6CidrBlock: "::/0",
    GatewayId: Match.anyValue(),
  }));

  // Dual-stack VPCs always get one VPC-level EgressOnlyInternetGateway from the
  // ec2.Vpc construct (aws-cdk-lib 2.261.0), regardless of subnet configuration.
  // It stays disconnected here: no AWS::EC2::Route references it (verified below
  // and by direct template inspection), so isolated subnets remain egress-free.
  template.resourceCountIs("AWS::EC2::EgressOnlyInternetGateway", 1);

  // exactly 4 default routes (2 AZs x IPv4+IPv6), all on the public route tables —
  // if an isolated route table ever gains a default route this count breaks
  const routes = template.findResources("AWS::EC2::Route");
  const defaultRoutes = Object.values(routes).filter(
    (route) =>
      route.Properties.DestinationCidrBlock === "0.0.0.0/0" ||
      route.Properties.DestinationIpv6CidrBlock === "::/0",
  );
  expect(defaultRoutes).toHaveLength(4);
});
