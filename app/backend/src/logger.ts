import winston from 'winston'

// Plain JSON to stdout -> picked up by the awslogs driver into CloudWatch
// Logs. No extra work needed to get trace_id/span_id onto every line: the
// ADOT auto-instrumentation bundle includes @opentelemetry/instrumentation-winston,
// which patches this logger to inject the active trace context automatically.
// That's what makes "jump from an X-Ray trace to its logs" work in the
// Application Signals console.
// https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Application-Signals-TraceLogCorrelation.html
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  defaultMeta: { service: 'backend' },
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
})
