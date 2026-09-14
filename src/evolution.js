// Thin client for the Evolution API send/status endpoints this service needs.
// Request/response shapes here are taken from a proven-working integration
// against this exact Evolution API version (v2.3.7), not guessed from docs.

const TIMEOUT_MS = 15_000
// Media goes out as base64 and Evolution then uploads it on to WhatsApp, so
// the round trip is far slower than a text send — the brochures are 1-4MB.
const MEDIA_TIMEOUT_MS = 90_000

export class EvolutionError extends Error {
  /**
   * @param {string} message
   * @param {{ code: 'upstream_unavailable' | 'send_failed', status?: number }} opts
   */
  constructor(message, { code, status } = {}) {
    super(message)
    this.name = 'EvolutionError'
    this.code = code
    this.status = status
  }
}

async function request(config, path, { method = 'GET', body, timeoutMs = TIMEOUT_MS } = {}) {
  let res
  try {
    res = await fetch(`${config.evolutionApiUrl}${path}`, {
      method,
      headers: {
        apikey: config.evolutionApiKey,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    // Network failure, DNS failure, or the AbortSignal timeout firing —
    // all mean Evolution API couldn't be reached in time.
    throw new EvolutionError(`Evolution API unreachable: ${err.message}`, {
      code: 'upstream_unavailable',
    })
  }

  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }

  if (!res.ok) {
    if (res.status >= 500) {
      throw new EvolutionError(`Evolution API returned ${res.status}`, {
        code: 'upstream_unavailable',
        status: res.status,
      })
    }
    const message = data?.response?.message ?? data?.message ?? text
    throw new EvolutionError(
      Array.isArray(message) ? message.join('; ') : String(message || res.status),
      { code: 'send_failed', status: res.status }
    )
  }

  return data
}

/** @returns {Promise<'open' | 'connecting' | 'close' | 'unknown'>} */
export async function getConnectionState(config) {
  const data = await request(
    config,
    `/instance/connectionState/${encodeURIComponent(config.evolutionInstance)}`
  )
  const state = data?.instance?.state ?? data?.state
  if (state === 'open' || state === 'connecting' || state === 'close') return state
  return 'unknown'
}

/**
 * @param {{ number: string, message: string }} input - number must already be normalized.
 * @returns {Promise<{ key?: { id?: string } }>}
 */
export async function sendText(config, { number, message }) {
  return request(
    config,
    `/message/sendText/${encodeURIComponent(config.evolutionInstance)}`,
    { method: 'POST', body: { number, text: message } }
  )
}

/**
 * @param {{ number: string, base64: string, fileName: string }} input - number must already be normalized.
 * @returns {Promise<{ key?: { id?: string } }>}
 */
export async function sendMedia(config, { number, base64, fileName }) {
  return request(
    config,
    `/message/sendMedia/${encodeURIComponent(config.evolutionInstance)}`,
    {
      method: 'POST',
      timeoutMs: MEDIA_TIMEOUT_MS,
      body: {
        number,
        mediatype: 'document',
        mimetype: 'application/pdf',
        media: base64,
        fileName,
      },
    }
  )
}

/**
 * Requests a pairing QR for the instance. Evolution returns no usable QR
 * fields once the instance is already `open` — callers should check
 * connection state first rather than rely on this to signal that.
 * @returns {Promise<{ qrBase64: string|null, pairingCode: string|null }>}
 */
export async function connectInstance(config) {
  const data = await request(
    config,
    `/instance/connect/${encodeURIComponent(config.evolutionInstance)}`
  )
  // Shape can differ across Evolution versions: fields at the top level or under `qrcode`.
  const qrBase64 = data?.base64 ?? data?.qrcode?.base64 ?? null
  const pairingCode = data?.pairingCode ?? data?.qrcode?.pairingCode ?? null
  return { qrBase64, pairingCode }
}

/** Logs the WhatsApp session out (instance stays registered in Evolution). */
export async function logoutInstance(config) {
  await request(
    config,
    `/instance/logout/${encodeURIComponent(config.evolutionInstance)}`,
    { method: 'DELETE' }
  )
}

/** Default client bound to a config object — what production code uses. */
export function createEvolutionClient(config) {
  return {
    getConnectionState: () => getConnectionState(config),
    sendText: (input) => sendText(config, input),
    sendMedia: (input) => sendMedia(config, input),
    connect: () => connectInstance(config),
    logout: () => logoutInstance(config),
  }
}
