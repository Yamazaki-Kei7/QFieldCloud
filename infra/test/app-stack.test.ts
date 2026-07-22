import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { NetworkStack } from "../lib/network-stack";
import { DataStack } from "../lib/data-stack";
import { FrontendStack } from "../lib/frontend-stack";
import { RegistryStack } from "../lib/registry-stack";
import { AppStack } from "../lib/app-stack";

const synthApp = (): Template => {
  const app = new cdk.App();
  const env = { account: "123456789012", region: "ap-northeast-1" };
  const network = new NetworkStack(app, "TestNetwork", { env });
  const data = new DataStack(app, "TestData", { env, vpc: network.vpc });
  const frontend = new FrontendStack(app, "TestFrontend", { env });
  const registry = new RegistryStack(app, "TestRegistry", { env });
  const appStack = new AppStack(app, "TestApp", {
    env,
    vpc: network.vpc,
    data,
    frontendBucket: frontend.bucket,
    frontendDistribution: frontend.distribution,
    repositories: registry.repositories,
  });
  return Template.fromStack(appStack);
};

test("qgis task definition matches plan-1 executor contract", () => {
  const template = synthApp();
  template.hasResourceProperties("AWS::ECS::TaskDefinition", {
    Family: "qfc-qgis3",
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: "qgis",
        MountPoints: Match.arrayWith([
          Match.objectLike({ ContainerPath: "/io" }),
          Match.objectLike({ ContainerPath: "/transformation_grids", ReadOnly: true }),
        ]),
      }),
    ]),
  });
});

test("worker mounts the io access point at /tmp (EFS contract)", () => {
  const template = synthApp();
  template.hasResourceProperties("AWS::ECS::TaskDefinition", {
    Family: "qfc-worker",
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: "wrapper",
        MountPoints: Match.arrayWith([
          Match.objectLike({ ContainerPath: "/tmp" }),
        ]),
      }),
    ]),
  });
});

test("app task has nginx, app and memcached containers", () => {
  const template = synthApp();
  for (const name of ["nginx", "app", "memcached"]) {
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Family: "qfc-app",
      ContainerDefinitions: Match.arrayWith([Match.objectLike({ Name: name })]),
    });
  }
});

test("internal ALB with 60s idle timeout (below nginx keepalive 65s)", () => {
  const template = synthApp();
  template.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
    Scheme: "internal",
    LoadBalancerAttributes: Match.arrayWith([
      Match.objectLike({ Key: "idle_timeout.timeout_seconds", Value: "60" }),
    ]),
  });
});

test("API distribution uses a VPC origin", () => {
  const template = synthApp();
  template.resourceCountIs("AWS::CloudFront::VpcOrigin", 1);
});

test("app container defines env vars that settings.py reads unconditionally", () => {
  const template = synthApp();
  // these are read at settings.py module top-level; a missing key crashes every
  // Django container on startup (not catchable by synth alone)
  const required = [
    "COMPOSE_PROJECT_NAME",
    "QFIELDCLOUD_HOST",
    "ENVIRONMENT",
    "EMAIL_HOST",
    "EMAIL_USE_TLS",
  ];
  const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
  const appTaskDef = Object.values(taskDefs).find(
    (t) => t.Properties.Family === "qfc-app",
  );
  const appContainer = appTaskDef!.Properties.ContainerDefinitions.find(
    (c: { Name: string }) => c.Name === "app",
  );
  const envNames = new Set(
    (appContainer.Environment as Array<{ Name: string }>).map((e) => e.Name),
  );
  for (const key of required) {
    expect(envNames.has(key)).toBe(true);
  }

  // EMAIL_USE_TLS must be "true"/"false" (settings.py checks .lower() == "true",
  // not parse_string_to_bool), otherwise SES STARTTLS silently stays off
  const tlsEnv = (appContainer.Environment as Array<{ Name: string; Value: string }>).find(
    (e) => e.Name === "EMAIL_USE_TLS",
  );
  expect(tlsEnv?.Value).toBe("true");
});

test("app service waits 300s before failing health checks", () => {
  const template = synthApp();
  template.hasResourceProperties("AWS::ECS::Service", {
    HealthCheckGracePeriodSeconds: 300,
    NetworkConfiguration: Match.objectLike({
      AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: "ENABLED" }),
    }),
  });
});

test("target group health check hits the status endpoint", () => {
  const template = synthApp();
  template.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
    HealthCheckPath: "/api/v1/status/",
  });
});

test("all Fargate task definitions pin X86_64 (QGIS image is amd64-only)", () => {
  const template = synthApp();
  const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
  const families = Object.values(taskDefs).map((t) => t.Properties.Family);
  // app, worker, qgis3, qgis4, migrate, grids-mirror, cron
  expect(families.sort()).toEqual(
    [
      "qfc-app",
      "qfc-cron",
      "qfc-grids-mirror",
      "qfc-migrate",
      "qfc-qgis3",
      "qfc-qgis4",
      "qfc-worker",
    ].sort(),
  );
  for (const t of Object.values(taskDefs)) {
    expect(t.Properties.RuntimePlatform).toMatchObject({ CpuArchitecture: "X86_64" });
  }
});

test("cron runs as its own dedicated single-container task definition (not a worker sidecar)", () => {
  const template = synthApp();
  template.hasResourceProperties("AWS::ECS::TaskDefinition", {
    Family: "qfc-cron",
    ContainerDefinitions: [Match.objectLike({ Name: "cron" })],
  });
  // the worker task definition must no longer carry the cron sidecar
  const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
  const workerTaskDef = Object.values(taskDefs).find(
    (t) => t.Properties.Family === "qfc-worker",
  );
  const containerNames = (
    workerTaskDef!.Properties.ContainerDefinitions as Array<{ Name: string }>
  ).map((c) => c.Name);
  expect(containerNames).not.toContain("cron");
});

test("migrate command creates the postgis extension before running migrate", () => {
  const template = synthApp();
  const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
  const migrateTaskDef = Object.values(taskDefs).find(
    (t) => t.Properties.Family === "qfc-migrate",
  );
  const migrateContainer = migrateTaskDef!.Properties.ContainerDefinitions.find(
    (c: { Name: string }) => c.Name === "migrate",
  );
  const command: string[] = migrateContainer.Command;
  expect(command[command.length - 1]).toEqual(
    expect.stringContaining("CREATE EXTENSION IF NOT EXISTS postgis"),
  );
  expect(command[command.length - 1]).toEqual(expect.stringContaining("manage.py migrate"));
});

test("services default to desiredCount > 0, but scale to 0 when servicesEnabled=false context is set (phased first deploy)", () => {
  const withServices = synthApp();
  const appServiceCounts = Object.values(
    withServices.findResources("AWS::ECS::Service"),
  ).map((s) => s.Properties.DesiredCount);
  expect(appServiceCounts.every((c) => c > 0)).toBe(true);

  const app = new cdk.App({ context: { servicesEnabled: "false" } });
  const env = { account: "123456789012", region: "ap-northeast-1" };
  const network = new NetworkStack(app, "TestNetwork2", { env });
  const data = new DataStack(app, "TestData2", { env, vpc: network.vpc });
  const frontend = new FrontendStack(app, "TestFrontend2", { env });
  const registry = new RegistryStack(app, "TestRegistry2", { env });
  const appStack = new AppStack(app, "TestApp2", {
    env,
    vpc: network.vpc,
    data,
    frontendBucket: frontend.bucket,
    frontendDistribution: frontend.distribution,
    repositories: registry.repositories,
  });
  const disabledTemplate = Template.fromStack(appStack);
  const disabledCounts = Object.values(
    disabledTemplate.findResources("AWS::ECS::Service"),
  ).map((s) => s.Properties.DesiredCount);
  expect(disabledCounts.every((c) => c === 0)).toBe(true);
});
