import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { developmentCsp } from './scripts/dev-csp'

export default defineConfig({
  root: 'src/renderer',
  plugins: [developmentCsp(), react()],
  server: { host: '127.0.0.1', port: 5173 },
})
