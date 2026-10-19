import { preview } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import config from '../vite.config.js'

const server = await preview({ ...config, configFile: false,
  root: dirname(dirname(fileURLToPath(import.meta.url))),
  preview: { host: '127.0.0.1', port: 5184, strictPort: true, proxy: config.server.proxy } })
server.printUrls()
