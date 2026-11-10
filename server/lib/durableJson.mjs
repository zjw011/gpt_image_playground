// 关键 JSON 数据的耐久读写：主文件与同内容备份同时保留，写入始终先落临时文件再替换。
// 这些文件承载账号、渠道、积分、卡密和作品索引，宁可停止服务也不能悄悄回落为空库。

import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function readDurableJson(file, label, validate) {
  const parse = (target) => {
    const value = JSON.parse(readFileSync(target, 'utf-8'))
    if (validate && validate(value) === false) throw new Error(`${label}数据结构损坏`)
    return value
  }

  try {
    const value = parse(file)
    if (!existsSync(`${file}.bak`)) copyFileSync(file, `${file}.bak`)
    return { value, recovered: false }
  } catch (primaryError) {
    const backup = `${file}.bak`
    if (!existsSync(backup)) {
      throw new Error(`${label}损坏且没有可用备份，请先恢复 ${file} 后再启动`, { cause: primaryError })
    }

    try {
      const value = parse(backup)
      const corrupt = `${file}.corrupt`
      if (existsSync(file)) copyFileSync(file, corrupt)
      copyFileSync(backup, file)
      console.warn(`${label}损坏，已从 ${backup} 自动恢复；损坏副本保存在 ${corrupt}`)
      return { value, recovered: true }
    } catch (backupError) {
      throw new Error(`${label}及其备份均损坏，请先恢复 ${file} 后再启动`, { cause: backupError })
    }
  }
}

export function writeDurableJson(file, value, pretty = false) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  const content = JSON.stringify(value, null, pretty ? 2 : 0)
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeFileSync(fd, content, 'utf-8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
  // 备份跟随每次已完成的原子提交，启动时可以恢复到最后一次完整写入。
  try {
    copyFileSync(file, `${tmp}.bak`)
    renameSync(`${tmp}.bak`, `${file}.bak`)
  } catch (err) {
    // 主文件替换已经是提交点；备份失败不能让调用方误以为未入账而重复重试。
    console.warn(`数据已提交，但备份更新失败：${file}`, err)
  }
}
