import { defineConfig } from 'vite'

const serverPort = process.env.SERVER_PORT || process.env.PORT || '3000'

export default defineConfig({
  server: {
    proxy: {
      '/api': `http://127.0.0.1:${serverPort}`,
      '/health': `http://127.0.0.1:${serverPort}`,
      '/ws': {
        target: `ws://127.0.0.1:${serverPort}`,
        ws: true,
      },
    },
  },
})
