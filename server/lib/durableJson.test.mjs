import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { readDurableJson, writeDurableJson } from './durableJson.mjs'

describe('关键 JSON 耐久读写', () => {
  it('每次原子写入后保留可解析备份', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gip-json-')), 'data.json')
    writeDurableJson(file, { balance: 20 }, true)

    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ balance: 20 })
    expect(JSON.parse(readFileSync(`${file}.bak`, 'utf-8'))).toEqual({ balance: 20 })
  })

  it('主文件损坏时自动恢复备份并保留损坏副本', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gip-json-')), 'data.json')
    writeDurableJson(file, { balance: 20 })
    writeFileSync(file, '{broken', 'utf-8')

    expect(readDurableJson(file, '积分账本')).toEqual({ value: { balance: 20 }, recovered: true })
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ balance: 20 })
    expect(existsSync(`${file}.corrupt`)).toBe(true)
  })

  it('主文件和备份都损坏时拒绝空库启动', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gip-json-')), 'data.json')
    writeFileSync(file, '{broken', 'utf-8')
    writeFileSync(`${file}.bak`, '{also broken', 'utf-8')

    expect(() => readDurableJson(file, '积分账本')).toThrow(/均损坏/)
  })
})
