import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const docker = readFileSync('deploy/watermark/Dockerfile', 'utf8')
const compose = readFileSync('compose.yaml', 'utf8')
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/sh.exe' : '/bin/sh'

it('依赖构建使用 HTTPS 单源、wheel 和超时，不绕过证书验证', () => {
  expect(docker).toContain('ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/')
  expect(docker).toContain('--index-url "$PIP_INDEX_URL" --timeout 120 --retries 5')
  expect(docker).toContain('--only-binary=:all:')
  expect(docker).not.toContain('--trusted-host')
  expect(docker).not.toContain('--extra-index-url')
  expect(compose).toContain("PIP_INDEX_URL: '${GIP_PIP_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple/}'")
})

// 替换 Python 命令和等待，不访问网络；按 Docker 规则拼接 RUN 后验证实际 shell 退出码。
describe.skipIf(!existsSync(shell))('安装重试不吞掉失败', () => {
  for (const failures of [0, 2, 3]) {
    it(`前 ${failures} 次安装失败`, () => {
      const run = docker.match(/RUN ([\s\S]*?)\nCOPY/)[1].replace(/\\\r?\n/g, ' ')
      const script = `count=0\npython() { count=$((count + 1)); echo attempt-$count; [ "$count" -gt ${failures} ]; }\nsleep() { :; }\nPIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/\n${run}`
      const result = spawnSync(shell, ['-s'], { input: script, encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(failures === 3 ? 1 : 0)
      expect(result.stdout.match(/attempt-/g)).toHaveLength(failures === 0 ? 1 : 3)
    })
  }
})
