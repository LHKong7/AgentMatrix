import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { developmentCsp } from './scripts/dev-csp'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [developmentCsp(), tailwindcss(), react()],
    server: { host: '127.0.0.1' },
  },
})
