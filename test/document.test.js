import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { EvolutionError } from '../src/evolution.js'
import { createDocumentStore, DOCUMENTS } from '../src/documents.js'

const config = {
  evolutionApiUrl: 'http://evolution-api:8080',
  evolutionApiKey: 'test-key',
  evolutionInstance: 'auto-quote',
  autoQuoteToken: 'test-token',
  dashboardPassword: 'test-password',
  port: 0,
}

function buildTestApp(t, { state = 'open', sendError } = {}) {
  const calls = []
  const evolutionClient = {
    getConnectionState: async () => state,
    sendMedia: async (input) => {
      calls.push(input)
      if (sendError) throw sendError
      return { key: { id: 'FAKE_DOC_ID' } }
    },
  }
  const documentStore = {
    names: () => ['copayment', 'deductible'],
    get: (name) =>
      name === 'copayment' || name === 'deductible'
        ? { fileName: `${name}.pdf`, base64: 'ZmFrZS1wZGY=' }
        : null,
  }
  const app = buildApp(config, { evolutionClient, documentStore, logger: false })
  t.after(() => app.close())
  return { app, calls }
}

const auth = { authorization: 'Bearer test-token' }

test('POST /send-document with no token → 401', async (t) => {
  const { app } = buildTestApp(t)
  const res = await app.inject({
    method: 'POST',
    url: '/send-document',
    payload: { number: '0123456789', document: 'copayment' },
  })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { ok: false, error: 'unauthorized' })
})

test('POST /send-document missing "document" → 400 naming the field', async (t) => {
  const { app } = buildTestApp(t)
  const res = await app.inject({
    method: 'POST',
    url: '/send-document',
    headers: auth,
    payload: { number: '0123456789' },
  })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.json(), { ok: false, error: 'missing_field', field: 'document' })
})

test('POST /send-document missing "number" → 400 naming the field', async (t) => {
  const { app } = buildTestApp(t)
  const res = await app.inject({
    method: 'POST',
    url: '/send-document',
    headers: auth,
    payload: { document: 'copayment' },
  })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.json(), { ok: false, error: 'missing_field', field: 'number' })
})

test('POST /send-document with an unknown document → 400 listing what is allowed', async (t) => {
  const { app } = buildTestApp(t)
  const res = await app.inject({
    method: 'POST',
    url: '/send-document',
    headers: auth,
    payload: { number: '0123456789', document: 'life-insurance' },
  })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.json(), {
    ok: false,
    error: 'unknown_document',
    allowed: ['copayment', 'deductible'],
  })
})

// A logical name means a path can never reach the filesystem — this is the
// regression guard for that.
test('POST /send-document cannot be used to read arbitrary files', async (t) => {
  const { app, calls } = buildTestApp(t)
  for (const document of ['../.env', '/etc/passwd', '../../package.json']) {
    const res = await app.inject({
      method: 'POST',
      url: '/send-document',
      headers: auth,
      payload: { number: '0123456789', document },
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error, 'unknown_document')
  }
  assert.equal(calls.length, 0)
})

test('POST /send-document rejects a landline like /send does', async (t) => {
  const { app } = buildTestApp(t)
  const res = await app.inject({
    method: 'POST',
    url: '/send-document',
    headers: auth,
    payload: { number: '0322334455', document: 'copayment' },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, 'invalid_number')
})

test('POST /send-document sends the brochure as a document and returns the messageId', async (t) => {
  const { app, calls } = buildTestApp(t)
  const res = await app.inject({
    method: 'POST',
    url: '/send-document',
    headers: auth,
    payload: { number: '0123456789', document: 'deductible' },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.messageId, 'FAKE_DOC_ID')
  assert.ok(body.sentAt)
  assert.deepEqual(calls, [
    { number: '60123456789', base64: 'ZmFrZS1wZGY=', fileName: 'deductible.pdf' },
  ])
})

test('POST /send-document while disconnected → instance_disconnected, no send attempted', async (t) => {
  const { app, calls } = buildTestApp(t, { state: 'close' })
  const res = await app.inject({
    method: 'POST',
    url: '/send-document',
    headers: auth,
    payload: { number: '0123456789', document: 'copayment' },
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: false, error: 'instance_disconnected' })
  assert.equal(calls.length, 0)
})

test('POST /send-document when Evolution is unreachable → upstream_unavailable', async (t) => {
  const { app } = buildTestApp(t, {
    sendError: new EvolutionError('boom', { code: 'upstream_unavailable' }),
  })
  const res = await app.inject({
    method: 'POST',
    url: '/send-document',
    headers: auth,
    payload: { number: '0123456789', document: 'copayment' },
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: false, error: 'upstream_unavailable' })
})

// Guards the age-band → brochure mapping the n8n workflow relies on, and
// that both real PDFs are actually present and readable.
test('the real document store loads both brochures', (t) => {
  const store = createDocumentStore()
  assert.deepEqual(store.names(), ['copayment', 'deductible'])
  for (const name of store.names()) {
    const doc = store.get(name)
    assert.ok(doc.base64.length > 1000, `${name} looks empty`)
    // Every PDF starts with %PDF — base64 "JVBER" — so a truncated or
    // wrong-format file fails here rather than at the client's phone.
    assert.ok(doc.base64.startsWith('JVBER'), `${name} is not a PDF`)
    assert.equal(doc.fileName, DOCUMENTS[name].fileName)
  }
  assert.equal(store.get('nope'), null)
})
