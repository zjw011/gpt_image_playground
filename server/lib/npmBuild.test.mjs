import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const compose = readFileSync('compose.yaml', 'utf8')
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/sh.exe' : '/bin/sh'

describe.each(['deploy/Dockerfile.server', 'deploy/Dockerfile'])('%s 下载策略', (path) => {
  const docker = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
  const run = docker.match(/RUN --mount=type=cache,target=\/root\/\.npm (npm ci[\s\S]*?)\n\n/)[1].replace(/\\\r?\n/g, ' ')

  it('保留 npm ci、HTTPS 镜像、锁文件校验与有界重试', () => {
    expect(docker).toContain('ARG NPM_REGISTRY=https://registry.npmmirror.com/')
    expect(run).toContain('--replace-registry-host=npmjs')
    expect(run).toContain('--fetch-retries=4')
    expect(run).toContain('--fetch-timeout=120000')
    expect(run).toContain('--maxsockets=8')
    expect(run).toContain('--prefer-offline --no-audit --no-fund')
    expect(docker.indexOf('COPY package.json package-lock.json ./')).toBeLessThan(docker.indexOf('RUN --mount='))
    expect(docker).not.toMatch(/strict-ssl=false|NODE_TLS_REJECT_UNAUTHORIZED|npm install|\|\|\s*true/)
    expect(run).not.toContain('--ignore-scripts')
  })

  it.skipIf(!existsSync(shell))('安装失败保留非零退出，覆盖下载源作为单一参数传入', () => {
    for (const status of [0, 1]) {
      const script = `npm() { printf '%s\\n' "$@"; return ${status}; }\nNPM_REGISTRY=https://mirror.example/registry/\n${run}`
      const result = spawnSync(shell, ['-s'], { input: script, encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(status)
      expect(result.stdout.split(/\r?\n/)).toContain('--registry=https://mirror.example/registry/')
      expect(result.stdout.split(/\r?\n/)[0]).toBe('ci')
    }
  })
})

it('Compose 默认启用镜像且允许现有 .env 覆盖，不更改业务数据卷', () => {
  expect(compose).toContain("NPM_REGISTRY: '${GIP_NPM_REGISTRY:-https://registry.npmmirror.com/}'")
  expect(compose).toContain('- gip-server-data:/data')
})
