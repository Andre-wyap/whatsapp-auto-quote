import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { EvolutionError } from '../src/evolution.js'

const config = {
  evolutionApiUrl: 'http://evolution-api:8080',
  evolutionApiKey: 'test-key',
  evolutionInstance: 'auto-quote',
  autoQuoteToken: 'test-token',
  dashboardPassword: 'test-password',
  port: 0,
}

function buildTestApp(t, { state = 'open', sendResult, sendError } = {}) {
  const evolutionClient = {
    getConnectionState: async () => state,
    sendText: async (input) => {
      if (sendError) throw sendError
      return sendResult ?? { key: { id: 'FAKE_MESSAGE_ID' } }
    },
  }
  const app = buildApp(config, { evolutionClient, logger: false })
  t.after(() => app.close())
  return app
}

const VALID_PAYLOAD = { number: '0123456789', message: 'Hi, here is your quote.' }

test('POST /send with no token → 401', async (t) => {
  const app = buildTestApp(t)
  const res = await app.inject({ method: 'POST', url: '/send', payload: VALID_PAYLOAD })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { ok: false, error: 'unauthorized' })
})

test('POST /send with wrong token → 401', async (t) => {
  const app = buildTestApp(t)
  const res = await app.inject({
    method: 'POST',
    url: '/send',
    headers: { authorization: 'Bearer wrong-token' },
    payload: VALID_PAYLOAD,
  })
  assert.equal(res.statusCode, 401)
})

test('POST /send missing "number" → 400 naming the field', async (t) => {
  const app = buildTestApp(t)
  const res = await app.inject({
    method: 'POST',
    url: '/send',
    headers: { authorization: 'Bearer test-token' },
    payload: { message: 'hi' },
  })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.json(), { ok: false, error: 'missing_field', field: 'number' })
})

test('POST /send missing "message" → 400 naming the field', async (t) => {
  const app = buildTestApp(t)
  const res = await app.inject({
    method: 'POST',
    url: '/send',
    headers: { authorization: 'Bearer test-token' },
    payload: { number: '60123456789' },
  })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.json(), { ok: false, error: 'missing_field', field: 'message' })
})

test('POST /send with an unnormalizable number → 400 invalid_number', async (t) => {
  const app = buildTestApp(t)
  const res = await app.inject({
    method: 'POST',
    url: '/send',
    headers: { authorization: 'Bearer test-token' },
    payload: { number: '0312345678', message: 'hi' },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, 'invalid_number')
})

test('POST /send while instance is not open → 200 ok:false instance_disconnected', async (t) => {
  const app = buildTestApp(t, { state: 'close' })
  const res = await app.inject({
    method: 'POST',
    url: '/send',
    headers: { authorization: 'Bearer test-token' },
    payload: VALID_PAYLOAD,
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: false, error: 'instance_disconnected' })
})

test('POST /send when Evolution is unreachable → 200 ok:false upstream_unavailable', async (t) => {
  const app = buildTestApp(t, {
    sendError: new EvolutionError('timeout', { code: 'upstream_unavailable' }),
  })
  const res = await app.inject({
    method: 'POST',
    url: '/send',
    headers: { authorization: 'Bearer test-token' },
    payload: VALID_PAYLOAD,
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: false, error: 'upstream_unavailable' })
})

test('POST /send when Evolution rejects the number → 200 ok:false with its message', async (t) => {
  const app = buildTestApp(t, {
    sendError: new EvolutionError('number is not on WhatsApp', {
      code: 'send_failed',
      status: 400,
    }),
  })
  const res = await app.inject({
    method: 'POST',
    url: '/send',
    headers: { authorization: 'Bearer test-token' },
    payload: VALID_PAYLOAD,
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: false, error: 'number is not on WhatsApp' })
})

test('POST /send happy path → 200 ok:true with messageId and sentAt', async (t) => {
  const app = buildTestApp(t)
  const res = await app.inject({
    method: 'POST',
    url: '/send',
    headers: { authorization: 'Bearer test-token' },
    payload: VALID_PAYLOAD,
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.messageId, 'FAKE_MESSAGE_ID')
  assert.match(body.sentAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
})

test('GET /health → 200 ok:true', async (t) => {
  const app = buildTestApp(t)
  const res = await app.inject({ method: 'GET', url: '/health' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true })
})

test('POST /send with malformed JSON body → 400', async (t) => {
  const app = buildTestApp(t)
  const res = await app.inject({
    method: 'POST',
    url: '/send',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    payload: '{not valid json',
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().ok, false)
})
