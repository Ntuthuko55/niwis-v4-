import { preview } from 'vite'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import config from '../vite.config.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
await preview({ ...config, root, configFile: false })
