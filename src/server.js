import { loadConfig } from './config.js'
import { buildApp } from './app.js'

const config = loadConfig()
const app = buildApp(config)

try {
  await app.listen({ host: '0.0.0.0', port: config.port })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
