// Loads and validates the service's configuration from environment variables.
// Fails fast at startup rather than surfacing confusing errors mid-request.

const REQUIRED_VARS = [
  'EVOLUTION_API_URL',
  'EVOLUTION_API_KEY',
  'EVOLUTION_INSTANCE',
  'AUTO_QUOTE_TOKEN',
  'DASHBOARD_PASSWORD',
]

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{
 *   evolutionApiUrl: string,
 *   evolutionApiKey: string,
 *   evolutionInstance: string,
 *   autoQuoteToken: string,
 *   dashboardPassword: string,
 *   port: number,
 * }}
 */
export function loadConfig(env = process.env) {
  const missing = REQUIRED_VARS.filter((key) => !env[key] || env[key].trim() === '')
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variable(s): ${missing.join(', ')}`
    )
  }

  const port = env.PORT ? Number(env.PORT) : 3000
  if (!Number.isInteger(port) || port <= 0) {
    throw new ConfigError(`PORT must be a positive integer, got: ${env.PORT}`)
  }

  return {
    evolutionApiUrl: env.EVOLUTION_API_URL.replace(/\/+$/, ''),
    evolutionApiKey: env.EVOLUTION_API_KEY,
    evolutionInstance: env.EVOLUTION_INSTANCE,
    autoQuoteToken: env.AUTO_QUOTE_TOKEN,
    dashboardPassword: env.DASHBOARD_PASSWORD,
    port,
  }
}
