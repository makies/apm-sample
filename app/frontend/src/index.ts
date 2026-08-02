import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from './logger'

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://backend:8080'
const PORT = Number(process.env.PORT ?? 8080)

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

app.get('/', (c) => c.html(page()))

// Every route below is a thin proxy to the backend service. The fetch() call
// carries the OTel trace context header (injected by the ADOT auto-
// instrumentation) so a single browser click produces one connected trace
// across frontend -> backend -> (DynamoDB | external API).
app.get('/api/items', async (c) => {
  const res = await fetch(`${BACKEND_URL}/api/items`)
  logger.info('proxied to backend', { target: '/api/items', status: res.status })
  return c.json(await res.json(), res.status as 200)
})

app.post('/api/items', async (c) => {
  const body = await c.req.text()
  const res = await fetch(`${BACKEND_URL}/api/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  logger.info('proxied to backend', { target: '/api/items', method: 'POST', status: res.status })
  return c.json(await res.json(), res.status as 200)
})

app.get('/api/external', async (c) => {
  const res = await fetch(`${BACKEND_URL}/api/external`)
  logger.info('proxied to backend', { target: '/api/external', status: res.status })
  return c.json(await res.json(), res.status as 200)
})

app.get('/api/flaky', async (c) => {
  const res = await fetch(`${BACKEND_URL}/api/flaky`)
  const body = await res.json().catch(() => ({}))
  logger.info('proxied to backend', { target: '/api/flaky', status: res.status })
  return c.json(body, res.status as 200)
})

function page() {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<title>CloudWatch APM Sample</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; }
  button { margin: 0.25rem; padding: 0.5rem 1rem; cursor: pointer; }
  pre { background: #f3f3f3; padding: 1rem; overflow-x: auto; white-space: pre-wrap; }
  h1 { font-size: 1.4rem; }
</style>
</head>
<body>
  <h1>CloudWatch Application Signals サンプル</h1>
  <p>frontend (Hono) → backend (Hono) → DynamoDB / 外部API</p>
  <button onclick="call('/api/items')">Items 一覧</button>
  <button onclick="post('/api/items')">Item 追加</button>
  <button onclick="call('/api/external')">外部API呼び出し</button>
  <button onclick="call('/api/flaky')">Flaky エンドポイント (SLO用)</button>
  <pre id="out">ここに結果が表示されます</pre>
  <script>
    async function call(path) {
      const out = document.getElementById('out');
      out.textContent = 'loading...';
      try {
        const res = await fetch(path);
        out.textContent = res.status + '\\n' + JSON.stringify(await res.json(), null, 2);
      } catch (e) {
        out.textContent = 'error: ' + e;
      }
    }
    async function post(path) {
      const out = document.getElementById('out');
      out.textContent = 'loading...';
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'hello ' + new Date().toISOString() }),
        });
        out.textContent = res.status + '\\n' + JSON.stringify(await res.json(), null, 2);
      } catch (e) {
        out.textContent = 'error: ' + e;
      }
    }
  </script>
</body>
</html>`
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  logger.info('frontend listening', { port: info.port })
})
