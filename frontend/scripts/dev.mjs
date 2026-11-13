import { createServer } from 'vite'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import config from '../vite.config.js'

// Load the config natively, matching build.mjs. Bundling this config with
// esbuild can scan inaccessible Windows parent directories in restricted runs.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const server = await createServer({ ...config, root, configFile: false })
await server.listen()
server.printUrls()
