import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { NetworkStack } from "../lib/network-stack";
import { DataStack } from "../lib/data-stack";

const synth = (): Template => {
  const app = new cdk.App();
  const env = { account: "123456789012", region: "ap-northeast-1" };
  const network = new NetworkStack(app, "TestNetwork", { env });
  const data = new DataStack(app, "TestData", { env, vpc: network.vpc });
  return Template.fromStack(data);
};

test("files bucket is versioned and private", () => {
  const template = synth();
  template.hasResourceProperties("AWS::S3::Bucket", {
    VersioningConfiguration: { Status: "Enabled" },
    PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true }),
  });
});

test("EFS has io and grids access points", () => {
  const template = synth();
  template.resourceCountIs("AWS::EFS::AccessPoint", 2);
  template.hasResourceProperties("AWS::EFS::AccessPoint", {
    RootDirectory: Match.objectLike({ Path: "/io" }),
  });
  template.hasResourceProperties("AWS::EFS::AccessPoint", {
    RootDirectory: Match.objectLike({ Path: "/transformation_grids" }),
  });
});

test("Aurora is serverless v2 postgres", () => {
  const template = synth();
  template.hasResourceProperties("AWS::RDS::DBCluster", {
    Engine: "aurora-postgresql",
    ServerlessV2ScalingConfiguration: Match.objectLike({ MinCapacity: 0.5 }),
  });
});

test("app secrets exist for django keys", () => {
  const template = synth();
  // SECRET_KEY + SALT_KEY + SES SMTP (DB credential secret is created by rds)
  template.resourceCountIs("AWS::SecretsManager::Secret", 4);
});

test("access points enforce the cross-container sharing permissions", () => {
  const template = synth();
  template.hasResourceProperties("AWS::EFS::AccessPoint", {
    RootDirectory: Match.objectLike({
      Path: "/io",
      CreationInfo: Match.objectLike({ Permissions: "777", OwnerUid: "0" }),
    }),
  });
  template.hasResourceProperties("AWS::EFS::AccessPoint", {
    RootDirectory: Match.objectLike({
      Path: "/transformation_grids",
      CreationInfo: Match.objectLike({ Permissions: "755" }),
    }),
  });
});

test("app-owned secrets (Django keys, SES SMTP) are retained on stack deletion", () => {
  const template = synth();
  // SALT_KEY/SECRET_KEY loss would make retained EncryptedTextField data
  // undecryptable, so these must survive a stack delete (unlike the RDS
  // master-password secret, which is recoverable via password reset).
  template.hasResource("AWS::SecretsManager::Secret", {
    DeletionPolicy: "Retain",
  });
  const secrets = template.findResources("AWS::SecretsManager::Secret", {
    DeletionPolicy: "Retain",
  });
  expect(Object.keys(secrets)).toHaveLength(3);
});

test("bucket enforces SSL and Aurora pins engine and capacity", () => {
  const template = synth();
  template.hasResourceProperties("AWS::S3::BucketPolicy", {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Effect: "Deny",
          Condition: { Bool: { "aws:SecureTransport": "false" } },
        }),
      ]),
    }),
  });
  template.hasResourceProperties("AWS::RDS::DBCluster", {
    EngineVersion: "16.8",
    StorageEncrypted: true,
    ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 4 },
  });
  template.hasResourceProperties("AWS::SecretsManager::Secret", {
    GenerateSecretString: Match.objectLike({ PasswordLength: 50 }),
  });
});
