import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/session':   { target: 'http://localhost:8000', changeOrigin: true },
      '/scenario':  { target: 'http://localhost:8000', changeOrigin: true },
      '/scenarios': { target: 'http://localhost:8000', changeOrigin: true },
      '/sessions':  { target: 'http://localhost:8000', changeOrigin: true },
      '/audio':      { target: 'http://localhost:8000', changeOrigin: true },
      '/transcribe': { target: 'http://localhost:8000', changeOrigin: true },
      '/ws':         { target: 'ws://localhost:8000', changeOrigin: true, ws: true },
    },
  },
})
