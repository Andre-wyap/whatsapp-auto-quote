// The dashboard: a password gate, a single static page, and the three
// small APIs it polls (status / qr / reconnect). Session is a signed,
// httpOnly cookie carrying nothing but a fixed marker — the signature
// (keyed on DASHBOARD_PASSWORD) is what makes it unforgeable, so there's
// no server-side session store to keep in sync.

import { readFileSync } from 'node:fs'
import { timingSafeEqual, createHash } from 'node:crypto'
import { EvolutionError } from '../evolution.js'

const SESSION_COOKIE = 'aq_session'
const SESSION_MARKER = 'authenticated'
const SESSION_TTL_SECONDS = 60 * 60 * 24 // 24h — a simple gate, not a hardened one; see CLAUDE.md.

const DASHBOARD_HTML = readFileSync(
  new URL('../public/dashboard.html', import.meta.url)
)

function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest()
  const hb = createHash('sha256').update(String(b)).digest()
  return timingSafeEqual(ha, hb)
}

/** Evolution's connection state → the three dashboard statuses (per CLAUDE.md's table). */
function toDashboardStatus(evolutionState) {
  if (evolutionState === 'open') return 'Active'
  if (evolutionState === 'connecting' || evolutionState === 'close') return 'Inactive'
  return 'Error' // unknown state, or the check itself failed
}

export function registerDashboardRoutes(app, config, evolutionClient) {
  function requireSession(request, reply, done) {
    const raw = request.cookies?.[SESSION_COOKIE]
    const unsigned = raw ? request.unsignCookie(raw) : null
    if (!unsigned?.valid || unsigned.value !== SESSION_MARKER) {
      reply.code(401).send({ ok: false, error: 'unauthorized' })
      return
    }
    done()
  }

  app.get('/', async (request, reply) => {
    reply.type('text/html').send(DASHBOARD_HTML)
  })

  app.post('/api/login', async (request, reply) => {
    const { password } = request.body ?? {}
    if (typeof password !== 'string' || !safeEqual(password, config.dashboardPassword)) {
      return reply.code(401).send({ ok: false, error: 'invalid_password' })
    }
    reply.setCookie(SESSION_COOKIE, SESSION_MARKER, {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      secure: request.protocol === 'https',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    })
    return reply.send({ ok: true })
  })

  app.post('/api/logout', async (request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return reply.send({ ok: true })
  })

  app.get('/api/status', { preHandler: requireSession }, async (request, reply) => {
    let evolutionState = null
    let status
    try {
      evolutionState = await evolutionClient.getConnectionState()
      status = toDashboardStatus(evolutionState)
    } catch (err) {
      request.log.error({ err }, 'status check failed')
      status = 'Error'
    }
    return reply.send({ status, evolutionState, checkedAt: new Date().toISOString() })
  })

  app.get('/api/qr', { preHandler: requireSession }, async (request, reply) => {
    try {
      const { qrBase64, pairingCode } = await evolutionClient.connect()
      return reply.send({ ok: true, qrBase64, pairingCode })
    } catch (err) {
      request.log.error({ err }, 'qr fetch failed')
      const code = err instanceof EvolutionError ? err.code : 'upstream_unavailable'
      return reply.send({ ok: false, error: code })
    }
  })

  app.post('/api/reconnect', { preHandler: requireSession }, async (request, reply) => {
    // Best-effort logout first (mirrors the CRM's own teardown pattern) —
    // an instance that was never connected, or already logged out, must not
    // block getting a fresh QR.
    await evolutionClient.logout().catch((err) => {
      request.log.warn({ err }, 'logout before reconnect failed (continuing)')
    })
    try {
      const { qrBase64, pairingCode } = await evolutionClient.connect()
      return reply.send({ ok: true, qrBase64, pairingCode })
    } catch (err) {
      request.log.error({ err }, 'reconnect failed')
      const code = err instanceof EvolutionError ? err.code : 'upstream_unavailable'
      return reply.send({ ok: false, error: code })
    }
  })
}
