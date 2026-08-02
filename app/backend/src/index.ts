import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'
import { trace, SpanStatusCode } from '@opentelemetry/api'
import { logger } from './logger'

const TABLE_NAME = process.env.TABLE_NAME ?? 'apm-sample-items'
const PORT = Number(process.env.PORT ?? 8080)

const ddbClient = new DynamoDBClient({})
const ddb = DynamoDBDocumentClient.from(ddbClient)

// Auto-instrumentation only sees HTTP calls and AWS SDK calls -- it has no
// idea about our own business logic. This tracer is for spans around code
// that auto-instrumentation can't see on its own.
const tracer = trace.getTracer('apm-sample-backend')

const app = new Hono()

app.use('*', async (c, next) => {
  const start = Date.now()
  logger.info('request received', { method: c.req.method, path: c.req.path })
  await next()
  logger.info('request completed', {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration_ms: Date.now() - start,
  })
})

app.onError((err, c) => {
  logger.error('unhandled error', {
    method: c.req.method,
    path: c.req.path,
    error: err.message,
    stack: err.stack,
  })
  return c.json({ error: 'internal error' }, 500)
})

app.get('/health', (c) => c.json({ status: 'ok' }))

// Backed by DynamoDB -> shows up as an AWS::DynamoDB::Table dependency in the
// Application Signals service map.
app.get('/api/items', async (c) => {
  const result = await ddb.send(new ScanCommand({ TableName: TABLE_NAME, Limit: 20 }))
  logger.info('items scanned', { table: TABLE_NAME, count: result.Items?.length ?? 0 })
  return c.json({ items: result.Items ?? [] })
})

app.post('/api/items', async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)

  const item = tracer.startActiveSpan('items.build', (span) => {
    const hadText = typeof body.text === 'string' && body.text.length > 0
    span.setAttribute('items.had_text', hadText)
    const built = {
      id: randomUUID(),
      text: hadText ? (body.text as string) : 'untitled',
      createdAt: new Date().toISOString(),
    }
    span.setAttribute('items.id', built.id)
    span.end()
    return built
  })

  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }))
  logger.info('item created', { table: TABLE_NAME, itemId: item.id })
  return c.json({ item }, 201)
})

// Calls a public API over HTTPS -> shows up as a remote/external dependency
// node in the service map, distinct from the in-account services.
app.get('/api/external', async (c) => {
  const start = Date.now()
  const res = await fetch('https://api.github.com/zen', {
    headers: { 'user-agent': 'apm-sample' },
  })
  const zen = await res.text()
  logger.info('external api call', {
    url: 'https://api.github.com/zen',
    status: res.status,
    duration_ms: Date.now() - start,
  })
  return c.json({ zen })
})

// Randomized latency + ~12% error rate so a Service Level Objective built on
// top of this operation actually has something to alarm on. The decision
// logic itself gets its own span (a child of the HTTP server span) so it's
// visible as a distinct step in the trace, separate from the request as a
// whole.
app.get('/api/flaky', async (c) => {
  return tracer.startActiveSpan('flaky.decide', async (span) => {
    try {
      const isSlow = Math.random() < 0.2
      const delayMs = isSlow ? 800 + Math.random() * 1500 : Math.random() * 150
      span.setAttribute('flaky.slow', isSlow)
      span.setAttribute('flaky.delay_ms', Math.round(delayMs))

      await new Promise((resolve) => setTimeout(resolve, delayMs))

      const failureInjected = Math.random() < 0.12
      span.setAttribute('flaky.failure_injected', failureInjected)

      if (failureInjected) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'injected failure' })
        logger.warn('flaky endpoint injected failure', { delay_ms: Math.round(delayMs) })
        return c.json({ error: 'random failure injected for SLO demo' }, 500)
      }
      logger.info('flaky endpoint ok', { delay_ms: Math.round(delayMs), slow: isSlow })
      return c.json({ ok: true, delayMs: Math.round(delayMs) })
    } finally {
      span.end()
    }
  })
})

serve({ fetch: app.fetch, port: PORT }, (info) => {
  logger.info('backend listening', { port: info.port })
})
