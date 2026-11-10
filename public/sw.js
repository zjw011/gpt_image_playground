// 注册 URL 会带 package.json 版本；升级时浏览器会安装新 worker，并清掉旧缓存。
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev'
const CACHE_PREFIX = `gpt-image-playground:${self.registration.scope}:v`
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.png',
  './apple-touch-icon.png',
  './brand/logo-mark.png',
  './brand/app-icon.png',
]
const APP_SHELL_URLS = new Set(APP_SHELL.map((path) => new URL(path, self.registration.scope).href))
const APP_SHELL_PATHS = new Set([...APP_SHELL_URLS].map((href) => new URL(href).pathname))
const ASSETS_PATH = new URL('./assets/', self.registration.scope).pathname

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key))),
    ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const { request } = event

  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // 维护页、错误响应和跳转后的登录页不能覆盖可离线使用的应用入口。
          if (response.ok && !response.redirected && (response.headers.get('content-type') || '').includes('text/html')) {
            const copy = response.clone()
            event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy)).catch(() => {}))
          }
          return response
        })
        .catch(() => caches.open(CACHE_NAME).then(async (cache) => (await cache.match('./index.html')) || Response.error())),
    )
    return
  }

  const isAppShell = APP_SHELL_URLS.has(url.href) || APP_SHELL_PATHS.has(url.pathname)
  if (!isAppShell && !url.pathname.startsWith(ASSETS_PATH)) return

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) => cache.match(request, { ignoreSearch: isAppShell })).then((cached) => {
      if (cached) return cached

      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone()
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {}))
        }
        return response
      })
    }),
  )
})
