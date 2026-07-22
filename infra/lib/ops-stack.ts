import * as cdk from "aws-cdk-lib";
import {
  aws_cloudwatch as cw,
  aws_cloudwatch_actions as cwActions,
  aws_ec2 as ec2,
  aws_elasticloadbalancingv2 as elbv2,
  aws_events as events,
  aws_events_targets as targets,
  aws_logs as logs,
  aws_sns as sns,
  aws_sns_subscriptions as subs,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { CONFIG } from "./config";
import { AppStack } from "./app-stack";
import { DataStack } from "./data-stack";

export interface OpsStackProps extends cdk.StackProps {
  readonly appStack: AppStack;
  readonly data: DataStack;
}

export class OpsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OpsStackProps) {
    super(scope, id, props);

    const topic = new sns.Topic(this, "Alarms");
    topic.addSubscription(new subs.EmailSubscription(CONFIG.alarmEmail));
    const notify = new cwActions.SnsAction(topic);

    const alarms: cw.Alarm[] = [
      new cw.Alarm(this, "Alb5xx", {
        metric: props.appStack.alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, {
          period: cdk.Duration.minutes(5),
          statistic: "Sum",
        }),
        threshold: 10,
        evaluationPeriods: 1,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }),
      // ターゲット異常（設計書 §6.2）
      new cw.Alarm(this, "UnhealthyHosts", {
        metric: props.appStack.targetGroup.metrics.unhealthyHostCount({
          period: cdk.Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 2,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }),
      new cw.Alarm(this, "AppCpuHigh", {
        metric: props.appStack.appService.metricCpuUtilization({ period: cdk.Duration.minutes(5) }),
        threshold: 85,
        evaluationPeriods: 3,
      }),
      new cw.Alarm(this, "DbCpuHigh", {
        metric: props.data.dbCluster.metricCPUUtilization({ period: cdk.Duration.minutes(5) }),
        threshold: 85,
        evaluationPeriods: 3,
      }),
      new cw.Alarm(this, "DbAcuNearMax", {
        metric: props.data.dbCluster.metricServerlessDatabaseCapacity({ period: cdk.Duration.minutes(5) }),
        threshold: CONFIG.aurora.maxAcu * 0.9,
        evaluationPeriods: 3,
      }),
      // アプリ/ワーカーログの ERROR 急増検知（設計書 §6.2）
      new cw.Alarm(this, "AppLogErrors", {
        metric: new logs.MetricFilter(this, "AppErrorFilter", {
          logGroup: props.appStack.appLogGroup,
          metricNamespace: "QFieldCloud",
          metricName: "AppLogErrors",
          filterPattern: logs.FilterPattern.anyTerm("ERROR", "CRITICAL", "Traceback"),
          metricValue: "1",
        }).metric({ period: cdk.Duration.minutes(5), statistic: "Sum" }),
        threshold: 10,
        evaluationPeriods: 1,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }),
    ];

    for (const alarm of alarms) {
      alarm.addAlarmAction(notify);
    }

    // Monthly PROJ transformation grids refresh (design doc §3.3)
    new events.Rule(this, "GridsMirrorSchedule", {
      schedule: events.Schedule.cron({ minute: "0", hour: "18", day: "1", month: "*", year: "*" }),
      targets: [
        new targets.EcsTask({
          cluster: props.appStack.cluster,
          taskDefinition: props.appStack.gridsTaskDef,
          subnetSelection: { subnetType: ec2.SubnetType.PUBLIC },
          assignPublicIp: true,
          securityGroups: [props.appStack.gridsSecurityGroup],
        }),
      ],
    });
  }
}
