import winston from 'winston'

// See the matching comment in app/backend/src/logger.ts: the ADOT
// auto-instrumentation bundle patches winston to inject trace_id/span_id
// automatically, which is what makes trace-to-log correlation work.
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  defaultMeta: { service: 'frontend' },
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
})
