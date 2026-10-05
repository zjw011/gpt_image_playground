// 自带隔离 Node 后端 / Python 工作者 / Chrome，验证真实下载副本，不调用生图渠道。
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchChrome } from './lib/cdp.mjs'

const PYTHON = process.env.AUDIT_PYTHON || 'python'
const DIR = mkdtempSync(join(tmpdir(), 'huixiang-cleanup-audit-'))
const BASE = 'http://127.0.0.1:8104'
const output = resolve('.tmp-check/image-cleanup')
const children = []
let browser
let failures = 0
const report = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failures++ }
const wait = async (predicate) => {
  for (let i = 0; i < 100; i++) {
    try { if (await predicate()) return true } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return false
}
try {
  mkdirSync(output, { recursive: true })
  const fixture = join(DIR, 'fixture.png')
  execFileSync(PYTHON, ['deploy/watermark/test_worker.py', '--fixture', fixture])
  const source = readFileSync(fixture)
  const worker = spawn(PYTHON, ['deploy/watermark/worker.py'], { env: { ...process.env, PORT: '8105' }, stdio: 'ignore' })
  children.push(worker)
  if (!await wait(async () => (await fetch('http://127.0.0.1:8105/health')).ok)) throw new Error('Python 工作者未就绪')
  const server = spawn(process.execPath, ['server/index.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT: '8104', GIP_DATA_DIR: DIR, GIP_ADMIN_USER: 'cleanup-audit', GIP_ADMIN_PASSWORD: 'cleanup-audit-secret', GIP_WATERMARK_URL: 'http://127.0.0.1:8105' }, stdio: 'ignore' })
  children.push(server)
  if (!await wait(async () => (await fetch(`${BASE}/api/health`)).ok)) throw new Error('隔离后端未就绪')
  report('匿名请求不得使用工作服务', (await fetch(`${BASE}/api/image-cleanup`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: source })).status === 401)
  const login = await fetch(`${BASE}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'cleanup-audit', password: 'cleanup-audit-secret' }) })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const rejected = await fetch(`${BASE}/api/image-cleanup`, { method: 'POST', headers: { 'Content-Type': 'image/png', Cookie: cookie, Origin: 'https://another.example' }, body: source })
  report('跨站计算请求拒绝', rejected.status === 403)
  const cleaned = await fetch(`${BASE}/api/image-cleanup`, { method: 'POST', headers: { 'Content-Type': 'image/png', Cookie: cookie }, body: source })
  const pixels = Buffer.from(await cleaned.arrayBuffer())
  report('真实上游算法处理已知水印并返回 PNG 副本', cleaned.ok && cleaned.headers.get('X-Cleanup-Status') === 'cleaned' && cleaned.headers.get('content-type') === 'image/png' && !pixels.equals(source))
  report('本地原始文件完全不变', readFileSync(fixture).equals(source))
  const errors = []
  browser = await launchChrome({ port: 9418, baseUrl: BASE, onConsoleError: (error) => errors.push(error) })
  await browser.open('/')
  await browser.evaluate(`fetch('/api/session', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:'cleanup-audit',password:'cleanup-audit-secret'}) })`)
  await browser.open('/result?task=cleanup-audit')
  const dataUrl = `data:image/png;base64,${source.toString('base64')}`
  await browser.evaluate(`(async () => {
    const names = await indexedDB.databases()
    const name = names.find((item) => item.name.startsWith('gpt-image-playground'))?.name
    if (!name) throw new Error('工作区不存在')
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const tx = db.transaction(['tasks','images'], 'readwrite')
    tx.objectStore('images').put({id:'cleanup-image', dataUrl:${JSON.stringify(dataUrl)}, source:'generated', createdAt:1})
    tx.objectStore('tasks').put({id:'cleanup-audit', prompt:'本地水印合成测试', params:{size:'auto',quality:'auto',output_format:'png',output_compression:null,moderation:'auto',n:1,transparent_output:false}, inputImageIds:[],outputImages:['cleanup-image'], status:'done',error:null,createdAt:1,finishedAt:2,elapsed:1})
    await new Promise((resolve, reject) => { tx.oncomplete=resolve;tx.onerror=reject })
    db.close()
  })()`)
  for (const width of [1440, 390, 320]) {
    await browser.setViewport(width, 900)
    await browser.open('/result?task=cleanup-audit')
    if (!await wait(async () => browser.evaluate('!!document.querySelector(\'input[type="checkbox"]:not(:disabled)\')'))) throw new Error('水印选项未就绪')
    report(`${width}px 路由、默认不勾选与无横向溢出`, await browser.url() === '/result?task=cleanup-audit' && await browser.evaluate('!document.querySelector(\'input[type="checkbox"]\').checked && document.documentElement.scrollWidth <= innerWidth + 1'))
    writeFileSync(join(output, `result-${width}.png`), Buffer.from(await browser.screenshot(), 'base64'))
  }
  await browser.evaluate(`(() => {
    window.__cleanupCalls=0
    const original = window.fetch
    window.fetch = function(input, options) { if(input === '/api/image-cleanup' && options?.method === 'POST') window.__cleanupCalls++; return original.call(this,input,options) }
    HTMLAnchorElement.prototype.click = function() { window.__cleanupDownload={href:this.href,name:this.download} }
  })()`)
  await browser.clickByText('下载', 100)
  report('不勾选时直接下载原图，零处理请求', await browser.evaluate(`window.__cleanupCalls === 0 && window.__cleanupDownload.href === ${JSON.stringify(dataUrl)}`))
  await browser.click('input[type="checkbox"]', 100)
  await browser.evaluate('Array.from(document.querySelectorAll("button")).find((button)=>button.innerText.trim()==="下载").click()')
  if (!await wait(async () => browser.evaluate('window.__cleanupDownload?.name.includes("去水印")'))) throw new Error('勾选下载未完成')
  report('勾选后真实处理并下载副本', await browser.evaluate('window.__cleanupCalls === 1 && window.__cleanupDownload.href.startsWith("blob:") && window.__cleanupDownload.name.endsWith(".png")'))
  report('页面仍展示原图', await browser.evaluate(`document.querySelector('img[data-image-id="cleanup-image"]').src === ${JSON.stringify(dataUrl)}`))
  report('浏览器无控制台错误', errors.length === 0)
} finally {
  await browser?.close()
  for (const child of children) child.kill()
  await new Promise((resolve) => setTimeout(resolve, 600))
  rmSync(DIR, { recursive: true, force: true })
}
if (failures) process.exitCode = 1
