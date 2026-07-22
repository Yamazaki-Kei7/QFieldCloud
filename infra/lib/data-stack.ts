import * as cdk from "aws-cdk-lib";
import {
  aws_ec2 as ec2,
  aws_efs as efs,
  aws_rds as rds,
  aws_s3 as s3,
  aws_secretsmanager as sm,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { CONFIG } from "./config";

export interface DataStackProps extends cdk.StackProps {
  readonly vpc: ec2.Vpc;
}

export class DataStack extends cdk.Stack {
  public readonly filesBucket: s3.Bucket;
  public readonly fileSystem: efs.FileSystem;
  public readonly ioAccessPoint: efs.AccessPoint;
  public readonly gridsAccessPoint: efs.AccessPoint;
  public readonly dbCluster: rds.DatabaseCluster;
  public readonly djangoSecretKey: sm.Secret;
  public readonly djangoSaltKey: sm.Secret;
  public readonly sesSmtpSecret: sm.Secret;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    // Project files. Versioning is a hard QFieldCloud requirement (file
    // history is stored as S3 object versions) — do NOT add lifecycle rules
    // that expire noncurrent versions (design doc §6.3).
    this.filesBucket = new s3.Bucket(this, "FilesBucket", {
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: cdk.Duration.days(7) }],
    });

    // Shared filesystem for the wrapper<->QGIS job file exchange contract
    // (design doc §4.3): the wrapper mounts the "io" access point at /tmp,
    // the QGIS task definitions mount the SAME access point at /io.
    this.fileSystem = new efs.FileSystem(this, "FileSystem", {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      encrypted: true,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_7_DAYS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.ioAccessPoint = this.fileSystem.addAccessPoint("IoAccessPoint", {
      path: "/io",
      createAcl: { ownerUid: "0", ownerGid: "0", permissions: "777" },
    });

    this.gridsAccessPoint = this.fileSystem.addAccessPoint("GridsAccessPoint", {
      path: "/transformation_grids",
      createAcl: { ownerUid: "0", ownerGid: "0", permissions: "755" },
    });

    // Aurora Serverless v2 with PostGIS support (PostgreSQL 16 family).
    this.dbCluster = new rds.DatabaseCluster(this, "Database", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_8,
      }),
      writer: rds.ClusterInstance.serverlessV2("Writer"),
      serverlessV2MinCapacity: CONFIG.aurora.minAcu,
      serverlessV2MaxCapacity: CONFIG.aurora.maxAcu,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      defaultDatabaseName: "qfieldcloud_db",
      credentials: rds.Credentials.fromGeneratedSecret("qfieldcloud_db_admin"),
      storageEncrypted: true,
      backup: { retention: cdk.Duration.days(7) },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // SALT_KEY/SECRET_KEY loss would make retained EncryptedTextField data undecryptable
    const generated = (name: string): sm.Secret =>
      new sm.Secret(this, name, {
        generateSecretString: {
          passwordLength: 50,
          excludeCharacters: "\"'`\\",
        },
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

    this.djangoSecretKey = generated("DjangoSecretKey");
    this.djangoSaltKey = generated("DjangoSaltKey");

    // Placeholder — filled manually after SES setup (see infra/README.md).
    this.sesSmtpSecret = new sm.Secret(this, "SesSmtpSecret", {
      secretObjectValue: {
        username: cdk.SecretValue.unsafePlainText("CHANGE_ME"),
        password: cdk.SecretValue.unsafePlainText("CHANGE_ME"),
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
