// The n8n-facing send path: POST /send + GET /health. No session/cookie
// auth here — this is the Bearer-token API surface, kept separate from the
// dashboard's cookie-gated routes in routes/dashboard.js.

import { normalizeMalaysianNumber, PhoneNumberError } from '../phone.js'
import { EvolutionError } from '../evolution.js'

/**
 * HTTP status convention: 401 (bad/missing token) and 400 (malformed
 * payload / invalid number) are the two codes CLAUDE.md specifies
 * explicitly. Every other outcome — instance_disconnected, Evolution
 * rejecting the send, Evolution being unreachable — returns 200 with
 * `ok: false`, so n8n only ever needs to branch on the response body's
 * `ok` field rather than juggle HTTP status codes too.
 */
export function registerSendRoutes(app, config, evolutionClient) {
  app.get('/health', async () => ({ ok: true }))

  app.post('/send', async (request, reply) => {
    const authHeader = request.headers.authorization ?? ''
    const [scheme, token] = authHeader.split(' ')
    if (scheme !== 'Bearer' || !token || token !== config.autoQuoteToken) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' })
    }

    const body = request.body ?? {}
    const { number, message } = body

    if (typeof number !== 'string' || number.trim() === '') {
      return reply.code(400).send({ ok: false, error: 'missing_field', field: 'number' })
    }
    if (typeof message !== 'string' || message.trim() === '') {
      return reply.code(400).send({ ok: false, error: 'missing_field', field: 'message' })
    }

    let normalizedNumber
    try {
      normalizedNumber = normalizeMalaysianNumber(number)
    } catch (err) {
      if (err instanceof PhoneNumberError) {
        return reply
          .code(400)
          .send({ ok: false, error: 'invalid_number', detail: err.message })
      }
      throw err
    }

    try {
      const state = await evolutionClient.getConnectionState()
      if (state !== 'open') {
        request.log.warn({ state }, 'send attempted while instance not open')
        return reply.send({ ok: false, error: 'instance_disconnected' })
      }
    } catch (err) {
      request.log.error({ err }, 'connection state check failed')
      return reply.send({ ok: false, error: 'upstream_unavailable' })
    }

    try {
      const result = await evolutionClient.sendText({
        number: normalizedNumber,
        message,
      })
      // Deliberately not logging `message` — the spec rules out storing
      // message content, and that extends to not putting it in logs either.
      request.log.info({ number: normalizedNumber, messageId: result?.key?.id }, 'sent')
      return reply.send({
        ok: true,
        messageId: result?.key?.id ?? null,
        sentAt: new Date().toISOString(),
      })
    } catch (err) {
      if (err instanceof EvolutionError) {
        request.log.error(
          { err, code: err.code, number: normalizedNumber },
          'send failed'
        )
        if (err.code === 'upstream_unavailable') {
          return reply.send({ ok: false, error: 'upstream_unavailable' })
        }
        return reply.send({ ok: false, error: err.message })
      }
      throw err
    }
  })
}
