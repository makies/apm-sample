import * as path from 'node:path'
import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery'
import * as rds from 'aws-cdk-lib/aws-rds'

const CLUSTER_ENVIRONMENT_NAME = 'apm-sample'

// Shared CloudWatch agent config that turns on Application Signals trace and
// metric collection. Every task in this stack mounts this via the
// CW_CONFIG_CONTENT secret on its ecs-cwagent sidecar (the "sidecar
// strategy" for Application Signals on ECS -- works on Fargate, always
// reachable at localhost from the app container in the same task).
// https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Application-Signals-ECS-Sidecar.html
const CW_AGENT_CONFIG = {
  traces: { traces_collected: { application_signals: {} } },
  logs: { metrics_collected: { application_signals: {} } },
}

export class ApmSampleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    // --- Networking -------------------------------------------------------
    // Public-subnets-only VPC: no NAT Gateway, so tasks get a public IP for
    // egress (ECR pull, CloudWatch/X-Ray endpoints, the demo's outbound
    // HTTPS call). Inbound is locked down by security groups below. This is
    // a deliberate cost trade-off for a throwaway sample -- for a real
    // workload, put tasks in private subnets behind a NAT Gateway instead.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        // Isolated (no route to the internet at all) -- Aurora only ever
        // needs to be reachable from other things inside the VPC, so this
        // costs nothing extra (no NAT Gateway) while keeping it off the
        // public internet entirely.
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    })

    // Free gateway endpoint so DynamoDB traffic never has to leave the AWS
    // network, even though there's no NAT Gateway.
    vpc.addGatewayEndpoint('DynamoDbEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    })

    // --- Data ---------------------------------------------------------
    const itemsTable = new dynamodb.Table(this, 'ItemsTable', {
      tableName: 'apm-sample-items',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    // --- ECS cluster + Service Connect namespace ------------------------
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: 'apm-sample',
      enableFargateCapacityProviders: true,
    })
    const cloudMapNamespace = cluster.addDefaultCloudMapNamespace({ name: 'apm-sample.local' })

    // One shared SSM parameter for the CloudWatch agent's Application
    // Signals config, read by every ecs-cwagent sidecar.
    const cwAgentConfigParam = new ssm.StringParameter(this, 'CwAgentConfigParam', {
      parameterName: 'ecs-cwagent',
      stringValue: JSON.stringify(CW_AGENT_CONFIG),
    })

    // --- Security groups -------------------------------------------------
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', { vpc, allowAllOutbound: true })
    const frontendSg = new ec2.SecurityGroup(this, 'FrontendSg', { vpc, allowAllOutbound: true })
    const backendSg = new ec2.SecurityGroup(this, 'BackendSg', { vpc, allowAllOutbound: true })
    const nestSg = new ec2.SecurityGroup(this, 'NestSg', { vpc, allowAllOutbound: true })
    const dbSg = new ec2.SecurityGroup(this, 'DbSg', { vpc, allowAllOutbound: false })

    frontendSg.addIngressRule(albSg, ec2.Port.tcp(8080), 'ALB to frontend')
    backendSg.addIngressRule(frontendSg, ec2.Port.tcp(8080), 'Frontend to backend (Service Connect)')
    nestSg.addIngressRule(albSg, ec2.Port.tcp(8080), 'ALB to nest')
    dbSg.addIngressRule(nestSg, ec2.Port.tcp(5432), 'Nest to Aurora Postgres')

    // NestJS's own data source, independent of the DynamoDB table above --
    // deliberately not shared with frontend/backend, and not reachable from
    // the internet (isolated subnets + this security group only).
    const nestDb = new rds.DatabaseCluster(this, 'NestDb', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_17_9 }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      defaultDatabaseName: 'nestapp',
      credentials: rds.Credentials.fromGeneratedSecret('nestapp'),
      // Scales down to 0 ACU when idle -- this is what keeps a demo Aurora
      // cluster from costing anything close to a fixed RDS instance.
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: 1,
      writer: rds.ClusterInstance.serverlessV2('Writer'),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    // --- Backend service ---------------------------------------------
    const backendService = this.buildService({
      vpc,
      cluster,
      serviceName: 'backend',
      appDir: path.join(__dirname, '../../app/backend'),
      securityGroup: backendSg,
      cwAgentConfigParam,
      environment: {
        TABLE_NAME: itemsTable.tableName,
        // Without this, Application Signals truncates every HTTP operation
        // to its first path segment (so /api/items, /api/external and
        // /api/flaky all collapse into one "GET /api" bucket). Listing the
        // exact routes here gives each endpoint its own operation.
        // https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Application-Signals-EndpointVisibility.html
        OTEL_AWS_HTTP_OPERATION_PATHS: '/health, /api/items, /api/external, /api/flaky',
      },
      grantTaskRole: (taskRole) => itemsTable.grantReadWriteData(taskRole),
      serviceConnect: {
        services: [{ portMappingName: 'backend', dnsName: 'backend', port: 8080 }],
      },
      cloudMapNamespace,
    })

    // --- Frontend service (client-only Service Connect, exposed via ALB) --
    const frontendService = this.buildService({
      vpc,
      cluster,
      serviceName: 'frontend',
      appDir: path.join(__dirname, '../../app/frontend'),
      securityGroup: frontendSg,
      cwAgentConfigParam,
      environment: {
        BACKEND_URL: 'http://backend:8080',
        OTEL_AWS_HTTP_OPERATION_PATHS: '/, /health, /api/items, /api/external, /api/flaky',
      },
      // No services of its own to expose, but still needs to be part of
      // Service Connect so "http://backend:8080" resolves via the injected
      // proxy.
      serviceConnect: {},
      cloudMapNamespace,
    })
    frontendService.node.addDependency(backendService)

    // --- Nest service (standalone, its own Aurora Postgres, no Service
    // Connect -- reached only via the ALB under the /nest/* path) -------
    const nestService = this.buildService({
      vpc,
      cluster,
      serviceName: 'nest',
      appDir: path.join(__dirname, '../../app/nest'),
      securityGroup: nestSg,
      cwAgentConfigParam,
      environment: {
        DB_HOST: nestDb.clusterEndpoint.hostname,
        DB_PORT: nestDb.clusterEndpoint.port.toString(),
        DB_NAME: 'nestapp',
        // The app itself uses "/nest" as its global route prefix so the ALB
        // can path-route to it on the same load balancer as the others.
        OTEL_AWS_HTTP_OPERATION_PATHS: '/nest/health, /nest/notes',
      },
      extraSecrets: {
        DB_USER: ecs.Secret.fromSecretsManager(nestDb.secret!, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(nestDb.secret!, 'password'),
      },
    })
    nestService.node.addDependency(nestDb)

    // --- Load balancer -----------------------------------------------
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
    })
    const listener = alb.addListener('Listener', { port: 80, open: true })
    listener.addTargets('FrontendTarget', {
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [frontendService],
      healthCheck: { path: '/health', interval: cdk.Duration.seconds(30) },
    })
    listener.addTargets('NestTarget', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/nest/*'])],
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [nestService],
      healthCheck: { path: '/nest/health', interval: cdk.Duration.seconds(30) },
    })

    // --- Outputs -------------------------------------------------------
    new cdk.CfnOutput(this, 'SiteUrl', { value: `http://${alb.loadBalancerDnsName}` })
    new cdk.CfnOutput(this, 'NestUrl', { value: `http://${alb.loadBalancerDnsName}/nest/health` })
    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName })
    new cdk.CfnOutput(this, 'BackendServiceName', { value: backendService.serviceName })
    new cdk.CfnOutput(this, 'FrontendServiceName', { value: frontendService.serviceName })
  }

  private buildService(opts: {
    vpc: ec2.IVpc
    cluster: ecs.ICluster
    serviceName: string
    appDir: string
    securityGroup: ec2.ISecurityGroup
    cwAgentConfigParam: ssm.IStringParameter
    environment: Record<string, string>
    grantTaskRole?: (taskRole: iam.IRole) => void
    serviceConnect?: ecs.ServiceConnectProps
    cloudMapNamespace?: servicediscovery.INamespace
    extraSecrets?: Record<string, ecs.Secret>
  }): ecs.FargateService {
    const { serviceName } = opts

    const taskDef = new ecs.FargateTaskDefinition(this, `${serviceName}TaskDef`, {
      cpu: 256,
      memoryLimitMiB: 512,
      // Docker image assets are built on the machine running `cdk deploy`. On
      // Apple Silicon that's arm64, so the task's runtime platform must match
      // or the container fails at startup with "exec format error". The
      // public cloudwatch-agent image is multi-arch, so ARM64 works for both
      // containers.
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    })

    // Application Signals needs the CloudWatch agent's own IAM permissions
    // (metrics, traces, log discovery) on the *task* role, since that's the
    // role the ecs-cwagent sidecar runs under.
    taskDef.taskRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
    )
    opts.grantTaskRole?.(taskDef.taskRole)

    const appLogGroup = new logs.LogGroup(this, `${serviceName}AppLogGroup`, {
      logGroupName: `/ecs/${CLUSTER_ENVIRONMENT_NAME}/${serviceName}`,
      retention: logs.RetentionDays.THREE_DAYS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })
    const cwAgentLogGroup = new logs.LogGroup(this, `${serviceName}CwAgentLogGroup`, {
      logGroupName: `/ecs/${CLUSTER_ENVIRONMENT_NAME}/${serviceName}-cwagent`,
      retention: logs.RetentionDays.THREE_DAYS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    taskDef.addContainer('app', {
      image: ecs.ContainerImage.fromAsset(opts.appDir),
      essential: true,
      portMappings: [
        { name: serviceName, containerPort: 8080, appProtocol: ecs.AppProtocol.http },
      ],
      environment: {
        PORT: '8080',
        ...opts.environment,
        // Application Signals / OTel wiring. Endpoints point at the
        // ecs-cwagent sidecar, reachable at localhost because both
        // containers share the task's network namespace (awsvpc mode).
        OTEL_AWS_APPLICATION_SIGNALS_ENABLED: 'true',
        OTEL_METRICS_EXPORTER: 'none',
        OTEL_LOGS_EXPORTER: 'none',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://localhost:4316/v1/traces',
        OTEL_AWS_APPLICATION_SIGNALS_EXPORTER_ENDPOINT: 'http://localhost:4316/v1/metrics',
        OTEL_TRACES_SAMPLER: 'xray',
        OTEL_TRACES_SAMPLER_ARG: 'endpoint=http://localhost:2000',
        OTEL_PROPAGATORS: 'tracecontext,baggage,b3,xray',
        OTEL_RESOURCE_ATTRIBUTES: [
          `service.name=${serviceName}`,
          `deployment.environment=${CLUSTER_ENVIRONMENT_NAME}`,
          `aws.log.group.names=${appLogGroup.logGroupName}`,
        ].join(','),
      },
      secrets: opts.extraSecrets,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: serviceName, logGroup: appLogGroup }),
    })

    taskDef.addContainer('ecs-cwagent', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/cloudwatch-agent/cloudwatch-agent:latest'),
      essential: true,
      secrets: {
        CW_CONFIG_CONTENT: ecs.Secret.fromSsmParameter(opts.cwAgentConfigParam),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'ecs-cwagent', logGroup: cwAgentLogGroup }),
    })

    const service = new ecs.FargateService(this, `${serviceName}Service`, {
      cluster: opts.cluster,
      serviceName,
      taskDefinition: taskDef,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [opts.securityGroup],
      serviceConnectConfiguration: opts.serviceConnect,
      circuitBreaker: { enable: true, rollback: true },
    })
    if (opts.cloudMapNamespace) {
      // CDK doesn't infer this edge automatically because serviceConnectConfiguration
      // only references the namespace by name, not by construct -- without it, the
      // ECS::Service can be created before the Cloud Map namespace exists and fails
      // with "Failed to retrieve namespace for apm-sample.local".
      service.node.addDependency(opts.cloudMapNamespace)
    }

    return service
  }
}
