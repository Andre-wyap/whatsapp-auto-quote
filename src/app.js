// Fastify app factory — separate from src/server.js so tests can build and
// exercise the app (via .inject()) without binding a real port or making
// real Evolution API calls.

import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { createEvolutionClient } from './evolution.js'
import { registerSendRoutes } from './routes/send.js'
import { registerDashboardRoutes } from './routes/dashboard.js'

/**
 * @param {import('./config.js').loadConfig extends (...a: any) => infer R ? R : never} config
 * @param {{ evolutionClient?: ReturnType<typeof createEvolutionClient>, logger?: boolean }} [deps] - for tests.
 */
export function buildApp(config, deps = {}) {
  const evolutionClient = deps.evolutionClient ?? createEvolutionClient(config)
  // trustProxy: this always sits behind Traefik in production, so
  // request.protocol needs X-Forwarded-Proto to know the browser is on
  // https (for the dashboard's Secure cookie) rather than assuming the
  // plain-http connection Traefik forwards internally.
  const app = Fastify({ logger: deps.logger ?? true, trustProxy: true })

  // Signs the dashboard's session cookie. Deliberately reuses
  // DASHBOARD_PASSWORD rather than requiring a separate secret — this is a
  // "simple login" gate per CLAUDE.md, not a hardened multi-user auth system.
  app.register(cookie, { secret: config.dashboardPassword })

  app.setErrorHandler((error, request, reply) => {
    // Covers Fastify's own failures too, e.g. malformed JSON bodies.
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(400).send({ ok: false, error: 'malformed_payload' })
    }
    request.log.error({ err: error }, 'unhandled error')
    return reply.code(500).send({ ok: false, error: 'internal_error' })
  })

  registerSendRoutes(app, config, evolutionClient)
  registerDashboardRoutes(app, config, evolutionClient)

  return app
}
