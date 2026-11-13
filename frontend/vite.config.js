import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const backendTarget = process.env.NIWIS_BACKEND_PROXY_TARGET || 'http://127.0.0.1:8000'
const apiProxy = {
  '/niwis-api': {
    target: backendTarget,
    changeOrigin: true,
  },
  '/spatial-api': {
    target: backendTarget,
    changeOrigin: true,
  },
  '/api': {
    target: backendTarget,
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/api/, ''),
  },
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: apiProxy,
  },
  preview: {
    host: '127.0.0.1',
    port: 4174,
    proxy: apiProxy,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        spatial: resolve(root, 'spatial-workspace.html'),
      },
    },
  },
})
