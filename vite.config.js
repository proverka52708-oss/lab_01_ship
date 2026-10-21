import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const publicDirectory = resolve(process.cwd(), 'public')

function labApi() {
  function middleware(request, response, next) {
    const path = new URL(request.url, 'http://localhost').pathname

    if (path === '/api/rooms' || path === '/api/arena') {
      const filename = path.endsWith('/rooms') ? 'rooms.json' : 'arena.json'
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.end(readFileSync(resolve(publicDirectory, 'api', filename)))
      return
    }

    if (path === '/api/test/offline') {
      request.socket.destroy()
      return
    }

    if (path === '/api/test/corrupt-json') {
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.end('{"rooms": [')
      return
    }

    if (path === '/api/test/missing-sprite.svg') {
      response.statusCode = 404
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.end(JSON.stringify({ error: 'Test sprite not found' }))
      return
    }

    if (path === '/api/test/timeout' || path === '/api/test/slow-sprite.svg') {
      const timer = setTimeout(() => {
        if (response.destroyed) return
        if (path.endsWith('.svg')) {
          response.setHeader('Content-Type', 'image/svg+xml')
          response.end('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>')
        } else {
          response.setHeader('Content-Type', 'application/json; charset=utf-8')
          response.end('{"ok":true}')
        }
      }, 1800)
      response.on('close', () => clearTimeout(timer))
      return
    }

    next()
  }

  return {
    name: 'lab-03-api',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}

export default defineConfig({
  plugins: [labApi()],
})
