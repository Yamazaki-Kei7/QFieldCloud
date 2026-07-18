export interface DjangoEnvInputs {
  /** API CloudFront distribution domain, e.g. dxxxx.cloudfront.net */
  readonly apiDomainName: string;
  /** Frontend CloudFront distribution domain (CORS origin). */
  readonly frontendDomainName: string;
  readonly filesBucketName: string;
  readonly region: string;
  readonly dbHost: string;
  readonly defaultFromEmail: string;
  readonly ecsClusterName: string;
  readonly qgis3TaskDefFamily: string;
  readonly qgis4TaskDefFamily: string;
  readonly taskSubnetIds: string; // comma separated
  readonly qgisSecurityGroupId: string;
  readonly qgisLogGroupName: string;
}

/**
 * Environment shared by the app and worker containers. Mirrors the
 * docker-compose x-django-env block / .env.example defaults, adapted for AWS
 * (see design doc §3.3). Secrets (SECRET_KEY, DB password, SMTP) are injected
 * separately via ECS secrets.
 */
export const buildDjangoEnvironment = (inputs: DjangoEnvInputs): Record<string, string> => ({
  ENVIRONMENT: "production",
  DEBUG: "0",
  DJANGO_SETTINGS_MODULE: "qfieldcloud.settings",
  // read unconditionally at settings.py module top-level (custom CA volume name);
  // a missing value crashes every Django container on startup with KeyError.
  COMPOSE_PROJECT_NAME: "qfc",
  // '*' is safe here: CloudFront cannot forward a Host that does not match
  // the distribution, the ALB is internal-only, and ALB health checks use
  // the task IP as Host (design doc §3.2).
  DJANGO_ALLOWED_HOSTS: "*",
  DJANGO_USE_X_FORWARDED_HOST: "1",
  QFIELDCLOUD_HOST: inputs.apiDomainName,
  QFIELDCLOUD_ADMIN_URI: "admin/",
  QFIELDCLOUD_WORKER_QFIELDCLOUD_URL: `https://${inputs.apiDomainName}/api/v1/`,
  QFIELDCLOUD_SUBSCRIPTION_MODEL: "subscription.Subscription",
  QFIELDCLOUD_ACCOUNT_ADAPTER: "qfieldcloud.core.adapters.AccountAdapterSignUpOpen",
  QFIELDCLOUD_AUTH_TOKEN_EXPIRATION_HOURS: "720",
  QFIELDCLOUD_PASSWORD_LOGIN_IS_ENABLED: "1",
  QFIELDCLOUD_USE_I18N: "1",
  QFIELDCLOUD_DEFAULT_LANGUAGE: "ja",
  QFIELDCLOUD_DEFAULT_TIME_ZONE: "Asia/Tokyo",
  QFIELDCLOUD_MEMCACHED_LOCATION: "127.0.0.1:11211",
  ACCOUNT_EMAIL_VERIFICATION: "optional",
  SOCIALACCOUNT_PROVIDERS: "{}",
  SENTRY_DSN: "",
  SENTRY_RELEASE: "cdk",
  SENTRY_ENVIRONMENT: "production",
  SENTRY_SAMPLE_RATE: "1",
  POSTGRES_DB: "qfieldcloud_db",
  POSTGRES_HOST: inputs.dbHost,
  POSTGRES_PORT: "5432",
  POSTGRES_SSLMODE: "require",
  STORAGES: JSON.stringify({
    default: {
      BACKEND: "qfieldcloud.filestorage.backend.QfcS3Boto3Storage",
      OPTIONS: {
        bucket_name: inputs.filesBucketName,
        region_name: inputs.region,
      },
    },
  }),
  STORAGES_PROJECT_DEFAULT_STORAGE: "default",
  EMAIL_HOST: `email-smtp.${inputs.region}.amazonaws.com`,
  EMAIL_PORT: "587",
  // NOTE: settings.py parses these two as `os.environ[...].lower() == "true"`
  // (not the shared parse_string_to_bool "0"/"1" convention used elsewhere
  // in this file) — "1"/"0" here would silently disable TLS.
  EMAIL_USE_TLS: "true",
  EMAIL_USE_SSL: "false",
  DEFAULT_FROM_EMAIL: inputs.defaultFromEmail,
  CORS_ALLOWED_ORIGINS: `https://${inputs.frontendDomainName}`,
  CORS_ALLOW_CREDENTIALS: "0",
  // Required by settings.py but only used by the docker executor path:
  QFIELDCLOUD_QGIS3_IMAGE_NAME: "qfieldcloud-qgis3",
  QFIELDCLOUD_QGIS4_IMAGE_NAME: "qfieldcloud-qgis4",
  QFIELDCLOUD_TRANSFORMATION_GRIDS_VOLUME_NAME: "efs-grids",
  // ECS executor wiring (plan 1):
  QFIELDCLOUD_WORKER_EXECUTOR: "ecs",
  QFIELDCLOUD_ECS_CLUSTER: inputs.ecsClusterName,
  QFIELDCLOUD_ECS_QGIS3_TASK_DEFINITION: inputs.qgis3TaskDefFamily,
  QFIELDCLOUD_ECS_QGIS4_TASK_DEFINITION: inputs.qgis4TaskDefFamily,
  QFIELDCLOUD_ECS_SUBNET_IDS: inputs.taskSubnetIds,
  QFIELDCLOUD_ECS_SECURITY_GROUP_IDS: inputs.qgisSecurityGroupId,
  QFIELDCLOUD_ECS_QGIS_LOG_GROUP: inputs.qgisLogGroupName,
  QFIELDCLOUD_ECS_ASSIGN_PUBLIC_IP: "1",
});
