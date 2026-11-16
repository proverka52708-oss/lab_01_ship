const CACHE_NAME = 'star-runner-v1'
const APP_SHELL = [
  '/',
  '/manifest.webmanifest',
  '/pwa-icon-192.png',
  '/pwa-icon-512.png',
  '/favicon.svg',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME)
      const page = await fetch('/')
      const html = await page.clone().text()
      await cache.put('/', page)
      await cache.addAll(APP_SHELL.slice(1))
      const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)]
        .map((match) => match[1])
        .filter(Boolean)
      const assetManifestResponse = await fetch('/assets/manifest.json')
      if (assetManifestResponse.ok) {
        const assetManifest = await assetManifestResponse.json()
        for (const entry of [
          ...(assetManifest.sprites ?? []),
          ...(assetManifest.sounds ?? []),
        ]) {
          if (typeof entry.url === 'string' && entry.url.startsWith('/assets/')) {
            assets.push(entry.url)
          }
        }
      }
      await Promise.all(
        [...new Set(assets)].map(async (asset) => {
          const response = await fetch(asset)
          if (response.ok) await cache.put(asset, response)
        }),
      )
    })(),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
        ),
      ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname === '/ws'
  ) {
    return
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone()
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
        }
        return response
      })
      .catch(async () => {
        const cached = await caches.match(request)
        if (cached) return cached
        if (request.mode === 'navigate') {
          const shell = await caches.match('/')
          if (shell) return shell
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' })
      }),
  )
})
