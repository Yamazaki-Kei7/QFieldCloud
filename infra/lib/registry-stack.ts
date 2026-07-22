import * as cdk from "aws-cdk-lib";
import { aws_ecr as ecr } from "aws-cdk-lib";
import { Construct } from "constructs";
import { CONFIG } from "./config";

export const REPO_NAMES = ["app", "worker", "nginx", "qgis3", "qgis4"] as const;
export type RepoName = (typeof REPO_NAMES)[number];

/**
 * ECR repositories, deployed BEFORE any service so images can be pushed before
 * the ECS services that pull them are created (avoids the chicken-and-egg where
 * services fail to stabilize pulling a not-yet-pushed image).
 */
export class RegistryStack extends cdk.Stack {
  public readonly repositories: Record<RepoName, ecr.Repository>;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    this.repositories = Object.fromEntries(
      REPO_NAMES.map((name) => [
        name,
        new ecr.Repository(this, `Repo-${name}`, {
          repositoryName: `${CONFIG.appName}-${name}`,
          imageScanOnPush: true,
          removalPolicy: cdk.RemovalPolicy.RETAIN,
        }),
      ]),
    ) as Record<RepoName, ecr.Repository>;
  }
}
