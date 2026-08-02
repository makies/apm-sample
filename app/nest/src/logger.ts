import winston from 'winston'

// Same pattern as the other two services: ADOT's bundled winston
// auto-instrumentation injects trace_id/span_id into every line automatically.
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  defaultMeta: { service: 'nest' },
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
})
