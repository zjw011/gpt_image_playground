import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { normalizeDevProxyConfig } from './src/lib/devProxy'
// @ts-expect-error 服务端原生 ESM 与开发服务共用同一素材安全边界。
import { handleToolsAssets, handleToolsFetch } from './server/lib/toolsAssets.mjs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

function loadDevProxyConfig() {
  try {
    return normalizeDevProxyConfig(
      JSON.parse(readFileSync('./dev-proxy.config.json', 'utf-8')) as unknown,
    )
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return null
    throw error
  }
}

async function embedDefaultConfig(value: string) {
  const source = value.trim()
  if (!source) return source

  if (/^https?:\/\//i.test(source)) {
    const url = new URL(source)
    if (!url.pathname.toLowerCase().endsWith('.json')) return source

    const response = await fetch(source)
    if (!response.ok) throw new Error(`预置配置请求失败：HTTP ${response.status}`)
    return `embedded-config:${Buffer.from(await response.text()).toString('base64')}`
  }

  const fileUrl = source.startsWith('file://')
  const path = fileUrl ? fileURLToPath(source) : resolve(source)
  if (!existsSync(path)) {
    if (fileUrl || source.toLowerCase().endsWith('.json')) throw new Error(`预置配置文件不存在：${path}`)
    return source
  }
  return `embedded-config:${Buffer.from(readFileSync(path)).toString('base64')}`
}

export default defineConfig(async ({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const defaultApiUrl = await embedDefaultConfig(process.env.VITE_DEFAULT_API_URL ?? env.VITE_DEFAULT_API_URL ?? '')
  if (defaultApiUrl.startsWith('embedded-config:')) process.env.VITE_DEFAULT_API_URL = defaultApiUrl
  const devProxyConfig = command === 'serve' ? loadDevProxyConfig() : null
  const toolsAssetBase = (process.env.VITE_TOOLS_GALLERY_ASSET_BASE || env.VITE_TOOLS_GALLERY_ASSET_BASE || 'https://ai-pose-gallery.anhao.app').replace(/\/$/, '')

  process.env.TOOLS_GALLERY_ASSET_BASE = toolsAssetBase
  const proxy: Record<string, object> = {}
  if (devProxyConfig?.enabled) {
    proxy[devProxyConfig.prefix] = {
      target: devProxyConfig.target,
      changeOrigin: devProxyConfig.changeOrigin,
      secure: devProxyConfig.secure,
      rewrite: (path: string) =>
        path.replace(
          new RegExp(`^${devProxyConfig.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
          '',
        ),
    }
  }

  return {
    plugins: [
      react(),
      {
        name: 'tools-fetch-proxy',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const url = new URL(req.url || '/', 'http://localhost')
            if (url.pathname === '/api/tools-fetch') return handleToolsFetch(req, res, url.search)
            if (url.pathname.startsWith('/tools-assets/')) return handleToolsAssets(req, res, url.pathname)
            next()
          })
        },
      },
    ],
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      // 素材版本：给 /art/* 这类"文件名固定"的图片加查询参数用。
      // 每次构建都会变，于是 CDN 与浏览器都必须回源取新图——
      // 部署窗口里被边缘节点缓存住的失败响应不会再粘住用户。
      __ASSET_VERSION__: JSON.stringify(`${pkg.version}-${Date.now().toString(36)}`),
      __DEV_PROXY_CONFIG__: JSON.stringify(devProxyConfig),
    },
    server: {
      host: true,
      proxy,
    },
  }
})
