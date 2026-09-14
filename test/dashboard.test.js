import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { EvolutionError } from '../src/evolution.js'

const config = {
  evolutionApiUrl: 'http://evolution-api:8080',
  evolutionApiKey: 'test-key',
  evolutionInstance: 'auto-quote',
  autoQuoteToken: 'test-token',
  dashboardPassword: 'dashboard-secret',
  port: 0,
}

const FAKE_QR = 'data:image/png;base64,iVBORw0KGgo='

function buildTestApp(t, overrides = {}) {
  const evolutionClient = {
    getConnectionState: async () => 'open',
    sendText: async () => ({ key: { id: 'x' } }),
    connect: async () => ({ qrBase64: FAKE_QR, pairingCode: null }),
    logout: async () => {},
    ...overrides,
  }
  const app = buildApp(config, { evolutionClient, logger: false })
  t.after(() => app.close())
  return app
}

/** Logs in and returns the session cookie header value for subsequent requests. */
async function login(app, password = 'dashboard-secret') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password },
  })
  const setCookie = res.headers['set-cookie']
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return raw ? raw.split(';')[0] : null
}

test('GET / serves the dashboard page without auth', async (t) => {
  const app = buildTestApp(t)
  const res = await app.inject({ method: 'GET', url: '/' })
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /text\/html/)
  assert.match(res.body, /Session dashboard/)
})

test('the dashboard page shows no message history, chats, or contacts', async (t) => {
  const app = buildTestApp(t)
  const res = await app.inject({ method: 'GET', url: '/' })
  // Guards CLAUDE.md's explicit "Must NOT show" constraint.
  const forbidden = [/chat log/i, /message history/i, /contact list/i, /\binbox\b/i]
  for (const pattern of forbidden) {
    assert.ok(
      !pattern.test(res.body.replace(/no message history, chats, or contacts/i, '')),
      `dashboard must not reference ${pattern}`
    )
  }
})

test('POST /api/login with the wrong password → 401', async (t) => {
  const app = buildTestApp(t)
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: 'wrong' },
  })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { ok: false, error: 'invalid_password' })
  assert.equal(res.headers['set-cookie'], undefined)
})

test('POST /api/login with no password field → 401', async (t) => {
  const app = buildTestApp(t)
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: {} })
  assert.equal(res.statusCode, 401)
})

test('POST /api/login with the right password sets an httpOnly session cookie', async (t) => {
  const app = buildTestApp(t)
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: 'dashboard-secret' },
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true })
  const raw = res.headers['set-cookie']
  const cookie = Array.isArray(raw) ? raw[0] : raw
  assert.match(cookie, /aq_session=/)
  assert.match(cookie, /HttpOnly/i)
  assert.match(cookie, /SameSite=Lax/i)
})

test('GET /api/status without a session → 401', async (t) => {
  const app = buildTestApp(t)
  const res = await app.inject({ method: 'GET', url: '/api/status' })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { ok: false, error: 'unauthorized' })
})

test('GET /api/status with a forged session cookie → 401', async (t) => {
  const app = buildTestApp(t)
  const res = await app.inject({
    method: 'GET',
    url: '/api/status',
    headers: { cookie: 'aq_session=authenticated' }, // unsigned, so invalid
  })
  assert.equal(res.statusCode, 401)
})

test('GET /api/qr and POST /api/reconnect without a session → 401', async (t) => {
  const app = buildTestApp(t)
  const qr = await app.inject({ method: 'GET', url: '/api/qr' })
  const reconnect = await app.inject({ method: 'POST', url: '/api/reconnect' })
  assert.equal(qr.statusCode, 401)
  assert.equal(reconnect.statusCode, 401)
})

test('GET /api/status maps Evolution "open" → Active', async (t) => {
  const app = buildTestApp(t, { getConnectionState: async () => 'open' })
  const cookie = await login(app)
  const res = await app.inject({ method: 'GET', url: '/api/status', headers: { cookie } })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.status, 'Active')
  assert.equal(body.evolutionState, 'open')
  assert.match(body.checkedAt, /^\d{4}-\d{2}-\d{2}T/)
})

test('GET /api/status maps "connecting" and "close" → Inactive', async (t) => {
  for (const state of ['connecting', 'close']) {
    const app = buildTestApp(t, { getConnectionState: async () => state })
    const cookie = await login(app)
    const res = await app.inject({ method: 'GET', url: '/api/status', headers: { cookie } })
    assert.equal(res.json().status, 'Inactive', `${state} should map to Inactive`)
  }
})

test('GET /api/status maps an unreachable Evolution → Error', async (t) => {
  const app = buildTestApp(t, {
    getConnectionState: async () => {
      throw new EvolutionError('unreachable', { code: 'upstream_unavailable' })
    },
  })
  const cookie = await login(app)
  const res = await app.inject({ method: 'GET', url: '/api/status', headers: { cookie } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().status, 'Error')
})

test('GET /api/status maps an unrecognized state → Error', async (t) => {
  const app = buildTestApp(t, { getConnectionState: async () => 'unknown' })
  const cookie = await login(app)
  const res = await app.inject({ method: 'GET', url: '/api/status', headers: { cookie } })
  assert.equal(res.json().status, 'Error')
})

test('GET /api/qr returns the QR for a logged-in session', async (t) => {
  const app = buildTestApp(t)
  const cookie = await login(app)
  const res = await app.inject({ method: 'GET', url: '/api/qr', headers: { cookie } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, qrBase64: FAKE_QR, pairingCode: null })
})

test('GET /api/qr reports upstream failure rather than throwing', async (t) => {
  const app = buildTestApp(t, {
    connect: async () => {
      throw new EvolutionError('down', { code: 'upstream_unavailable' })
    },
  })
  const cookie = await login(app)
  const res = await app.inject({ method: 'GET', url: '/api/qr', headers: { cookie } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: false, error: 'upstream_unavailable' })
})

test('POST /api/reconnect logs out first, then returns a fresh QR', async (t) => {
  const calls = []
  const app = buildTestApp(t, {
    logout: async () => { calls.push('logout') },
    connect: async () => { calls.push('connect'); return { qrBase64: FAKE_QR, pairingCode: null } },
  })
  const cookie = await login(app)
  const res = await app.inject({ method: 'POST', url: '/api/reconnect', headers: { cookie } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().qrBase64, FAKE_QR)
  assert.deepEqual(calls, ['logout', 'connect'], 'logout must happen before connect')
})

test('POST /api/reconnect still returns a QR when logout fails', async (t) => {
  // An instance that was never connected can't be logged out — that must not
  // block getting a QR.
  const app = buildTestApp(t, {
    logout: async () => { throw new EvolutionError('not logged in', { code: 'send_failed' }) },
  })
  const cookie = await login(app)
  const res = await app.inject({ method: 'POST', url: '/api/reconnect', headers: { cookie } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().qrBase64, FAKE_QR)
})

test('POST /api/logout clears the session', async (t) => {
  const app = buildTestApp(t)
  const cookie = await login(app)

  const before = await app.inject({ method: 'GET', url: '/api/status', headers: { cookie } })
  assert.equal(before.statusCode, 200)

  const out = await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } })
  assert.equal(out.statusCode, 200)
  const raw = out.headers['set-cookie']
  const cleared = Array.isArray(raw) ? raw[0] : raw
  assert.match(cleared, /aq_session=;|aq_session=;?\s*Expires/i)
})

test('the dashboard session cookie does not grant access to POST /send', async (t) => {
  // The two auth surfaces are deliberately separate: a dashboard login must
  // not become a way to send messages without the bearer token.
  const app = buildTestApp(t)
  const cookie = await login(app)
  const res = await app.inject({
    method: 'POST',
    url: '/send',
    headers: { cookie },
    payload: { number: '0123456789', message: 'hi' },
  })
  assert.equal(res.statusCode, 401)
})

test('the send bearer token does not grant access to dashboard APIs', async (t) => {
  const app = buildTestApp(t)
  const res = await app.inject({
    method: 'GET',
    url: '/api/status',
    headers: { authorization: 'Bearer test-token' },
  })
  assert.equal(res.statusCode, 401)
})
