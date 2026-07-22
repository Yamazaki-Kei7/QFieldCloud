import * as cdk from "aws-cdk-lib";
import {
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_logs as logs,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_secretsmanager as sm,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { CONFIG } from "./config";
import { buildDjangoEnvironment } from "./app-env";
import { DataStack } from "./data-stack";
import { RepoName } from "./registry-stack";

export interface AppStackProps extends cdk.StackProps {
  readonly vpc: ec2.Vpc;
  readonly data: DataStack;
  readonly frontendBucket: s3.Bucket;
  readonly frontendDistribution: cloudfront.Distribution;
  /** ECR repositories from RegistryStack, deployed before this stack (Fix 4). */
  readonly repositories: Record<RepoName, ecr.Repository>;
}

export class AppStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly apiDistribution: cloudfront.Distribution;
  public readonly appService!: ecs.FargateService;
  public readonly workerService!: ecs.FargateService;
  public readonly appLogGroup: logs.LogGroup;
  public readonly workerLogGroup: logs.LogGroup;
  public readonly targetGroup!: elbv2.ApplicationTargetGroup;
  public readonly gridsTaskDef: ecs.FargateTaskDefinition; // exposed for OpsStack (Task 8)
  public readonly gridsSecurityGroup: ec2.SecurityGroup; // exposed for OpsStack (Task 8)

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    const arch =
      CONFIG.cpuArchitecture === "ARM64"
        ? ecs.CpuArchitecture.ARM64
        : ecs.CpuArchitecture.X86_64;
    const runtimePlatform: ecs.RuntimePlatform = {
      cpuArchitecture: arch,
      operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
    };

    // First deploy brings services up at 0 so `cdk deploy` completes without
    // waiting on tasks that pull not-yet-migrated schema; run the migrate task,
    // then redeploy without this flag to scale services up. See infra/README.md.
    const servicesEnabled =
      this.node.tryGetContext("servicesEnabled") !== "false";
    const desired = (count: number): number => (servicesEnabled ? count : 0);

    // --- ECR repositories (RegistryStack, deployed before this stack; images
    //     are pushed by infra/scripts/push-images.sh) ---
    const repos = props.repositories;

    // --- cluster and log groups ---
    this.cluster = new ecs.Cluster(this, "Cluster", {
      vpc: props.vpc,
      clusterName: `${CONFIG.appName}-cluster`,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    this.appLogGroup = new logs.LogGroup(this, "AppLogs", {
      logGroupName: `/${CONFIG.appName}/app`,
      retention: logs.RetentionDays.ONE_MONTH,
    });
    this.workerLogGroup = new logs.LogGroup(this, "WorkerLogs", {
      logGroupName: `/${CONFIG.appName}/worker`,
      retention: logs.RetentionDays.ONE_MONTH,
    });
    const qgisLogGroup = new logs.LogGroup(this, "QgisLogs", {
      logGroupName: `/${CONFIG.appName}/qgis`,
      retention: logs.RetentionDays.ONE_MONTH,
    });

    // --- security groups ---
    const albSg = new ec2.SecurityGroup(this, "AlbSg", { vpc: props.vpc });
    // The CloudFront VPC origin ENIs live inside the VPC; the CDK cannot
    // reference their managed security group, so allow HTTP from the VPC CIDR.
    albSg.addIngressRule(ec2.Peer.ipv4(props.vpc.vpcCidrBlock), ec2.Port.tcp(80));

    const appSg = new ec2.SecurityGroup(this, "AppSg", { vpc: props.vpc });
    appSg.addIngressRule(albSg, ec2.Port.tcp(80));

    // Attached to the WorkerService's ENIs below.
    const workerSg = new ec2.SecurityGroup(this, "WorkerSg", { vpc: props.vpc });
    const qgisSg = new ec2.SecurityGroup(this, "QgisSg", { vpc: props.vpc });

    // NOTE: `connections.allowFrom(appSg/workerSg/qgisSg, ...)` would add an
    // ingress rule to DataStack's DB/EFS security groups that references an
    // AppStack security group ID. Combined with AppStack's own references
    // into DataStack (fileSystemArn, cluster endpoint, secrets, ...), that
    // creates a cyclic cross-stack reference that `cdk synth` rejects
    // (DependencyCycle: TestData -> TestApp -> TestData). Scope the ingress
    // by the VPC CIDR instead — same technique as albSg above. DataStack
    // already depends on NetworkStack for `vpc`, so this adds no new stack
    // edge, and all of appSg/workerSg/qgisSg live inside this CIDR.
    const vpcCidr = ec2.Peer.ipv4(props.vpc.vpcCidrBlock);
    props.data.dbCluster.connections.allowFrom(vpcCidr, ec2.Port.tcp(5432));
    props.data.fileSystem.connections.allowFrom(vpcCidr, ec2.Port.tcp(2049));

    // --- API distribution is declared before the task definitions because
    //     its domain feeds the Django environment. The ALB is created first. ---
    this.alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc: props.vpc,
      internetFacing: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroup: albSg,
      idleTimeout: cdk.Duration.seconds(60), // below nginx keepalive_timeout 65
    });

    this.apiDistribution = new cloudfront.Distribution(this, "ApiDistribution", {
      comment: `${CONFIG.appName} API`,
      defaultBehavior: {
        origin: origins.VpcOrigin.withApplicationLoadBalancer(this.alb, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
    });

    // --- shared environment / secrets ---
    const environment = buildDjangoEnvironment({
      apiDomainName: this.apiDistribution.distributionDomainName,
      frontendDomainName: props.frontendDistribution.distributionDomainName,
      filesBucketName: props.data.filesBucket.bucketName,
      region: CONFIG.region,
      dbHost: props.data.dbCluster.clusterEndpoint.hostname,
      defaultFromEmail: CONFIG.defaultFromEmail,
      ecsClusterName: this.cluster.clusterName,
      qgis3TaskDefFamily: `${CONFIG.appName}-qgis3`,
      qgis4TaskDefFamily: `${CONFIG.appName}-qgis4`,
      taskSubnetIds: props.vpc.publicSubnets.map((sn) => sn.subnetId).join(","),
      qgisSecurityGroupId: qgisSg.securityGroupId,
      qgisLogGroupName: qgisLogGroup.logGroupName,
    });

    const dbSecret = props.data.dbCluster.secret as sm.ISecret;
    const djangoSecrets: Record<string, ecs.Secret> = {
      SECRET_KEY: ecs.Secret.fromSecretsManager(props.data.djangoSecretKey),
      SALT_KEY: ecs.Secret.fromSecretsManager(props.data.djangoSaltKey),
      POSTGRES_USER: ecs.Secret.fromSecretsManager(dbSecret, "username"),
      POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, "password"),
      EMAIL_HOST_USER: ecs.Secret.fromSecretsManager(props.data.sesSmtpSecret, "username"),
      EMAIL_HOST_PASSWORD: ecs.Secret.fromSecretsManager(props.data.sesSmtpSecret, "password"),
    };

    // --- QGIS job task definitions (started dynamically via RunTask, plan 1) ---
    const makeQgisTaskDef = (family: "qgis3" | "qgis4"): ecs.FargateTaskDefinition => {
      const taskDef = new ecs.FargateTaskDefinition(this, `TaskDef-${family}`, {
        family: `${CONFIG.appName}-${family}`,
        cpu: CONFIG.qgisTask.cpu,
        memoryLimitMiB: CONFIG.qgisTask.memoryMiB,
        runtimePlatform,
      });
      taskDef.addVolume({
        name: "io",
        efsVolumeConfiguration: {
          fileSystemId: props.data.fileSystem.fileSystemId,
          transitEncryption: "ENABLED",
          authorizationConfig: { accessPointId: props.data.ioAccessPoint.accessPointId, iam: "ENABLED" },
        },
      });
      taskDef.addVolume({
        name: "grids",
        efsVolumeConfiguration: {
          fileSystemId: props.data.fileSystem.fileSystemId,
          transitEncryption: "ENABLED",
          authorizationConfig: { accessPointId: props.data.gridsAccessPoint.accessPointId, iam: "ENABLED" },
        },
      });
      const container = taskDef.addContainer("qgis", {
        containerName: "qgis",
        image: ecs.ContainerImage.fromEcrRepository(repos[family], "latest"),
        logging: ecs.LogDrivers.awsLogs({ logGroup: qgisLogGroup, streamPrefix: "qgis" }),
        // command / environment are injected per job via RunTask overrides
      });
      container.addMountPoints(
        { containerPath: "/io", sourceVolume: "io", readOnly: false },
        { containerPath: "/transformation_grids", sourceVolume: "grids", readOnly: true },
      );
      grantEfsAccess(taskDef.taskRole, props.data);
      return taskDef;
    };

    const qgis3TaskDef = makeQgisTaskDef("qgis3");
    const qgis4TaskDef = makeQgisTaskDef("qgis4");

    // --- app task: nginx sidecar + gunicorn + memcached ---
    const appTaskDef = new ecs.FargateTaskDefinition(this, "TaskDef-app", {
      family: `${CONFIG.appName}-app`,
      cpu: CONFIG.appTask.cpu,
      memoryLimitMiB: CONFIG.appTask.memoryMiB,
      runtimePlatform,
    });
    appTaskDef.addVolume({ name: "static" }); // task-local ephemeral volume

    const appContainer = appTaskDef.addContainer("app", {
      containerName: "app",
      image: ecs.ContainerImage.fromEcrRepository(repos.app, "latest"),
      logging: ecs.LogDrivers.awsLogs({ logGroup: this.appLogGroup, streamPrefix: "app" }),
      environment,
      secrets: djangoSecrets,
      command: [
        "bash",
        "-c",
        "python manage.py collectstatic --noinput && exec gunicorn qfieldcloud.wsgi:application --bind 0.0.0.0:8000 --timeout 300 --max-requests 300 --workers 3 --threads 3",
      ],
      essential: true,
    });
    appContainer.addMountPoints({ containerPath: "/usr/src/app/staticfiles", sourceVolume: "static", readOnly: false });

    const nginxContainer = appTaskDef.addContainer("nginx", {
      containerName: "nginx",
      image: ecs.ContainerImage.fromEcrRepository(repos.nginx, "latest"),
      logging: ecs.LogDrivers.awsLogs({ logGroup: this.appLogGroup, streamPrefix: "nginx" }),
      portMappings: [{ containerPort: 80 }],
      essential: true,
    });
    nginxContainer.addMountPoints({ containerPath: "/var/www/html/staticfiles", sourceVolume: "static", readOnly: true });
    nginxContainer.addContainerDependencies({ container: appContainer, condition: ecs.ContainerDependencyCondition.START });

    appTaskDef.addContainer("memcached", {
      containerName: "memcached",
      image: ecs.ContainerImage.fromRegistry("public.ecr.aws/docker/library/memcached:1.6-alpine"),
      logging: ecs.LogDrivers.awsLogs({ logGroup: this.appLogGroup, streamPrefix: "memcached" }),
      essential: false,
    });

    props.data.filesBucket.grantReadWrite(appTaskDef.taskRole);

    // --- worker task: dequeue loop. Mounts the io access point at /tmp — the
    //     cross-container exchange contract (§4.3). ---
    const workerTaskDef = new ecs.FargateTaskDefinition(this, "TaskDef-worker", {
      family: `${CONFIG.appName}-worker`,
      cpu: CONFIG.workerTask.cpu,
      memoryLimitMiB: CONFIG.workerTask.memoryMiB,
      runtimePlatform,
    });
    workerTaskDef.addVolume({
      name: "io",
      efsVolumeConfiguration: {
        fileSystemId: props.data.fileSystem.fileSystemId,
        transitEncryption: "ENABLED",
        authorizationConfig: { accessPointId: props.data.ioAccessPoint.accessPointId, iam: "ENABLED" },
      },
    });

    const wrapperContainer = workerTaskDef.addContainer("wrapper", {
      containerName: "wrapper",
      image: ecs.ContainerImage.fromEcrRepository(repos.worker, "latest"),
      logging: ecs.LogDrivers.awsLogs({ logGroup: this.workerLogGroup, streamPrefix: "wrapper" }),
      environment,
      secrets: djangoSecrets,
      command: ["python", "manage.py", "dequeue"],
      essential: true,
    });
    wrapperContainer.addMountPoints({ containerPath: "/tmp", sourceVolume: "io", readOnly: false });

    props.data.filesBucket.grantReadWrite(workerTaskDef.taskRole);
    grantEfsAccess(workerTaskDef.taskRole, props.data);

    // ECS executor permissions (design doc §4.4)
    workerTaskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:RunTask"],
        resources: [qgis3TaskDef.taskDefinitionArn, qgis4TaskDef.taskDefinitionArn],
      }),
    );
    workerTaskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:DescribeTasks", "ecs:StopTask", "ecs:ListTasks"],
        resources: ["*"],
        conditions: { ArnEquals: { "ecs:cluster": this.cluster.clusterArn } },
      }),
    );
    workerTaskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [
          qgis3TaskDef.taskRole.roleArn,
          qgis4TaskDef.taskRole.roleArn,
          (qgis3TaskDef.executionRole as iam.IRole).roleArn,
          (qgis4TaskDef.executionRole as iam.IRole).roleArn,
        ],
      }),
    );
    workerTaskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["logs:GetLogEvents"],
        resources: [`${qgisLogGroup.logGroupArn}:*`],
      }),
    );
    // Fargate tags on RunTask. `ecs:cluster` is not a valid condition key for
    // TagResource (it isn't part of the tagging request context); the
    // documented way to scope tag-on-create is `ecs:CreateAction` (see AWS
    // ECS developer guide "Grant permission to tag resources on creation").
    workerTaskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:TagResource"],
        resources: ["*"],
        conditions: { StringEquals: { "ecs:CreateAction": "RunTask" } },
      }),
    );

    // --- one-off migrate task (run manually / from CI: see README) ---
    const migrateTaskDef = new ecs.FargateTaskDefinition(this, "TaskDef-migrate", {
      family: `${CONFIG.appName}-migrate`,
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform,
    });
    migrateTaskDef.addContainer("migrate", {
      containerName: "migrate",
      image: ecs.ContainerImage.fromEcrRepository(repos.app, "latest"),
      logging: ecs.LogDrivers.awsLogs({ logGroup: this.appLogGroup, streamPrefix: "migrate" }),
      environment,
      secrets: djangoSecrets,
      command: [
        "bash",
        "-c",
        // Aurora has no postgis extension by default (docker-compose used the
        // postgis/postgis image which pre-creates it). The master DB user has
        // rds_superuser and can create it. Idempotent.
        "python manage.py shell -c \"from django.db import connection; connection.cursor().execute('CREATE EXTENSION IF NOT EXISTS postgis')\" && python manage.py migrate",
      ],
    });

    // --- grids mirror task (scheduled from OpsStack, also run once at bootstrap) ---
    this.gridsSecurityGroup = new ec2.SecurityGroup(this, "GridsSg", { vpc: props.vpc });
    // EFS ingress is already scoped to the VPC CIDR above (covers this SG too);
    // an SG-to-SG rule here would reintroduce the DataStack<->AppStack cycle
    // described above.

    this.gridsTaskDef = new ecs.FargateTaskDefinition(this, "TaskDef-grids", {
      family: `${CONFIG.appName}-grids-mirror`,
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform,
    });
    this.gridsTaskDef.addVolume({
      name: "grids",
      efsVolumeConfiguration: {
        fileSystemId: props.data.fileSystem.fileSystemId,
        transitEncryption: "ENABLED",
        authorizationConfig: { accessPointId: props.data.gridsAccessPoint.accessPointId, iam: "ENABLED" },
      },
    });
    const gridsContainer = this.gridsTaskDef.addContainer("mirror", {
      containerName: "mirror",
      image: ecs.ContainerImage.fromRegistry("public.ecr.aws/docker/library/alpine:3"),
      logging: ecs.LogDrivers.awsLogs({ logGroup: this.workerLogGroup, streamPrefix: "grids" }),
      command: [
        "sh",
        "-c",
        "apk add --no-cache wget && wget --mirror https://cdn.proj.org/ -P /transformation_grids --no-host-directories && chmod -R a+r /transformation_grids",
      ],
    });
    gridsContainer.addMountPoints({ containerPath: "/transformation_grids", sourceVolume: "grids", readOnly: false });
    grantEfsAccess(this.gridsTaskDef.taskRole, props.data);

    // --- services ---
    this.appService = new ecs.FargateService(this, "AppService", {
      cluster: this.cluster,
      taskDefinition: appTaskDef,
      desiredCount: desired(CONFIG.appTask.desiredCount),
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [appSg],
      healthCheckGracePeriod: cdk.Duration.seconds(300),
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    const listener = this.alb.addListener("Http", { port: 80, open: false });
    this.targetGroup = listener.addTargets("AppTargets", {
      port: 80,
      targets: [this.appService.loadBalancerTarget({ containerName: "nginx", containerPort: 80 })],
      healthCheck: {
        path: "/api/v1/status/",
        healthyHttpCodes: "200",
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(15),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    this.workerService = new ecs.FargateService(this, "WorkerService", {
      cluster: this.cluster,
      taskDefinition: workerTaskDef,
      desiredCount: desired(CONFIG.workerTask.desiredCount),
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [workerSg],
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
    });

    // --- cron task: a single runcrons loop. Dedicated service at desiredCount 1
    //     so scheduled jobs (notifications, cleanup) run exactly once, unlike a
    //     sidecar on the multi-replica worker task which would run N times. ---
    const cronTaskDef = new ecs.FargateTaskDefinition(this, "TaskDef-cron", {
      family: `${CONFIG.appName}-cron`,
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform,
    });
    cronTaskDef.addContainer("cron", {
      containerName: "cron",
      image: ecs.ContainerImage.fromEcrRepository(repos.worker, "latest"),
      logging: ecs.LogDrivers.awsLogs({ logGroup: this.workerLogGroup, streamPrefix: "cron" }),
      environment,
      secrets: djangoSecrets,
      command: ["bash", "-c", "while true; do python manage.py runcrons; sleep 60; done"],
    });
    props.data.filesBucket.grantReadWrite(cronTaskDef.taskRole);

    const cronService = new ecs.FargateService(this, "CronService", {
      cluster: this.cluster,
      taskDefinition: cronTaskDef,
      desiredCount: desired(1),
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [workerSg],
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
    });
    void cronService;

    // --- runtime config for the SPA (frontend fetches /config.json) ---
    new s3deploy.BucketDeployment(this, "FrontendConfig", {
      destinationBucket: props.frontendBucket,
      sources: [
        s3deploy.Source.jsonData("config.json", {
          apiUrl: `https://${this.apiDistribution.distributionDomainName}`,
        }),
      ],
      distribution: props.frontendDistribution,
      distributionPaths: ["/config.json"],
      prune: false, // do not delete the SPA assets deployed by plan 3
    });

    new cdk.CfnOutput(this, "ApiUrl", { value: `https://${this.apiDistribution.distributionDomainName}` });
    new cdk.CfnOutput(this, "AlbDnsName", { value: this.alb.loadBalancerDnsName });
  }
}

/** EFS client access via IAM (access-point scoped). */
const grantEfsAccess = (role: iam.IRole, data: DataStack): void => {
  role.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: [
        "elasticfilesystem:ClientMount",
        "elasticfilesystem:ClientWrite",
        "elasticfilesystem:ClientRootAccess",
      ],
      resources: [data.fileSystem.fileSystemArn],
    }),
  );
};
