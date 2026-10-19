import { build } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { gzipSync, brotliCompressSync, constants } from 'node:zlib'
import config from '../vite.config.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
// Import the config natively: avoid esbuild scanning inaccessible Windows parents.
await build({ ...config, root, configFile: false, build: { ...config.build, manifest: true } })
async function compress(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name)
    if (item.isDirectory()) await compress(path)
    else if (/\.(js|css|json|geojson|svg|html)$/.test(item.name)) {
      const bytes = await readFile(path)
      if (bytes.length < 1500) continue
      await Promise.all([
        writeFile(`${path}.gz`, gzipSync(bytes, { level: 6 })),
        writeFile(`${path}.br`, brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })),
      ])
    }
  }
}
await compress(join(root, 'dist'))
console.log('Prepared gzip and Brotli assets for static hosting.')
