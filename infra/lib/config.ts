export interface QfcConfig {
  /** Prefix for resource names. */
  readonly appName: string;
  readonly region: string;
  /** Email address that receives CloudWatch alarm notifications. */
  readonly alarmEmail: string;
  /** SES-verified sender address (see infra/README.md bootstrap steps). */
  readonly defaultFromEmail: string;
  /** Fargate CPU architecture. X86_64 because the QGIS image (docker-qgis) is amd64-only. */
  readonly cpuArchitecture: "ARM64" | "X86_64";
  readonly appTask: { readonly cpu: number; readonly memoryMiB: number; readonly desiredCount: number };
  readonly workerTask: { readonly cpu: number; readonly memoryMiB: number; readonly desiredCount: number };
  readonly qgisTask: { readonly cpu: number; readonly memoryMiB: number };
  readonly aurora: { readonly minAcu: number; readonly maxAcu: number };
}

export const CONFIG: QfcConfig = {
  appName: "qfc",
  region: "ap-northeast-1",
  alarmEmail: "yamazaki@mierune.co.jp",
  defaultFromEmail: "yamazaki@mierune.co.jp",
  cpuArchitecture: "X86_64",
  appTask: { cpu: 512, memoryMiB: 2048, desiredCount: 1 },
  workerTask: { cpu: 256, memoryMiB: 1024, desiredCount: 2 },
  qgisTask: { cpu: 1024, memoryMiB: 4096 },
  aurora: { minAcu: 0.5, maxAcu: 4 },
};
