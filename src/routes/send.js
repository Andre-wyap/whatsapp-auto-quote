// The n8n-facing send paths: POST /send, POST /send-document, GET /health.
// No session/cookie auth here — this is the Bearer-token API surface, kept
// separate from the dashboard's cookie-gated routes in routes/dashboard.js.

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
export function registerSendRoutes(app, config, evolutionClient, documentStore) {
  app.get('/health', async () => ({ ok: true }))

  const requireToken = async (request, reply) => {
    const authHeader = request.headers.authorization ?? ''
    const [scheme, token] = authHeader.split(' ')
    if (scheme !== 'Bearer' || !token || token !== config.autoQuoteToken) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' })
    }
  }

  /** Normalizes, or sends the 400 itself and returns null. */
  const normalizeOr400 = (raw, reply) => {
    try {
      return normalizeMalaysianNumber(raw)
    } catch (err) {
      if (err instanceof PhoneNumberError) {
        reply.code(400).send({ ok: false, error: 'invalid_number', detail: err.message })
        return null
      }
      throw err
    }
  }

  /** True if the instance is connected; sends the `ok:false` body itself if not. */
  const instanceReady = async (request, reply) => {
    try {
      const state = await evolutionClient.getConnectionState()
      if (state !== 'open') {
        request.log.warn({ state }, 'send attempted while instance not open')
        reply.send({ ok: false, error: 'instance_disconnected' })
        return false
      }
      return true
    } catch (err) {
      request.log.error({ err }, 'connection state check failed')
      reply.send({ ok: false, error: 'upstream_unavailable' })
      return false
    }
  }

  app.post('/send', { preHandler: requireToken }, async (request, reply) => {
    const body = request.body ?? {}
    const { number, message } = body

    if (typeof number !== 'string' || number.trim() === '') {
      return reply.code(400).send({ ok: false, error: 'missing_field', field: 'number' })
    }
    if (typeof message !== 'string' || message.trim() === '') {
      return reply.code(400).send({ ok: false, error: 'missing_field', field: 'message' })
    }

    const normalizedNumber = normalizeOr400(number, reply)
    if (normalizedNumber === null) return reply

    if (!(await instanceReady(request, reply))) return reply

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

  // Sends one of the static product brochures as a WhatsApp document.
  // Deliberately a separate endpoint rather than optional fields on /send:
  // the quote text and the PDF go out as two separate WhatsApp messages
  // anyway (WhatsApp caps document captions ~1024 chars, and the quote text
  // is already close), so there's nothing to gain from one combined call.
  app.post('/send-document', { preHandler: requireToken }, async (request, reply) => {
    const body = request.body ?? {}
    const { number, document } = body

    if (typeof number !== 'string' || number.trim() === '') {
      return reply.code(400).send({ ok: false, error: 'missing_field', field: 'number' })
    }
    if (typeof document !== 'string' || document.trim() === '') {
      return reply.code(400).send({ ok: false, error: 'missing_field', field: 'document' })
    }

    const brochure = documentStore.get(document.trim())
    if (!brochure) {
      return reply.code(400).send({
        ok: false,
        error: 'unknown_document',
        allowed: documentStore.names(),
      })
    }

    const normalizedNumber = normalizeOr400(number, reply)
    if (normalizedNumber === null) return reply

    if (!(await instanceReady(request, reply))) return reply

    try {
      const result = await evolutionClient.sendMedia({
        number: normalizedNumber,
        base64: brochure.base64,
        fileName: brochure.fileName,
      })
      request.log.info(
        { number: normalizedNumber, document, messageId: result?.key?.id },
        'document sent'
      )
      return reply.send({
        ok: true,
        messageId: result?.key?.id ?? null,
        sentAt: new Date().toISOString(),
      })
    } catch (err) {
      if (err instanceof EvolutionError) {
        request.log.error(
          { err, code: err.code, number: normalizedNumber, document },
          'document send failed'
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
