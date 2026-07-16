import * as cdk from "aws-cdk-lib";
import { aws_ec2 as ec2 } from "aws-cdk-lib";
import { Construct } from "constructs";

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // Dual-stack VPC without NAT gateways. Fargate tasks live in the public
    // subnets with public IPv4 (design doc §3.1: launch-time dependencies
    // such as ECR require an IPv4 path, which NAT-less private subnets
    // cannot provide). The internal ALB, Aurora and EFS mount targets live
    // in the isolated subnets.
    this.vpc = new ec2.Vpc(this, "Vpc", {
      ipProtocol: ec2.IpProtocol.DUAL_STACK,
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
          mapPublicIpOnLaunch: true,
          ipv6AssignAddressOnCreation: true,
        },
        {
          name: "isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // Free gateway endpoint: S3 traffic from the tasks stays on the AWS
    // network and does not consume public bandwidth.
    this.vpc.addGatewayEndpoint("S3Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
  }
}
