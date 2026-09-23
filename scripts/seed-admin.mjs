// 一次性脚本：把站长账号写进本地数据目录。
//
// 为什么需要它：`server-data/` 在 .gitignore 里，线上/本地的账号不会随代码走，
// 而 `GIP_ADMIN_USER/GIP_ADMIN_PASSWORD` 只在"账号还不存在"时生效——已经跑过一轮、
// 想把某个账号提权或改密码时，用它最直接。
//
// 用法：node scripts/seed-admin.mjs <用户名> <密码> [显示名]
import { readFileSync, writeFileSync } from 'node:fs'
import { generateUserId, hashPassword } from '../server/lib/store.mjs'

const [username, password, displayName] = process.argv.slice(2)
if (!username || !password) {
  console.error('用法：node scripts/seed-admin.mjs <用户名> <密码> [显示名]')
  process.exit(1)
}
if (password.length < 6) {
  console.error('密码至少 6 位')
  process.exit(1)
}

const file = new URL('../server-data/config.json', import.meta.url)
const config = JSON.parse(readFileSync(file, 'utf8'))
config.users = config.users ?? []

const now = Date.now()
const existing = config.users.find((user) => user.username === username)
if (existing) {
  existing.passwordHash = hashPassword(password)
  existing.role = 'admin'
  existing.enabled = true
  existing.updatedAt = now
  console.log(`已更新 ${username} 的密码与角色`)
} else {
  config.users.push({
    id: generateUserId(),
    username,
    displayName: displayName ?? username,
    passwordHash: hashPassword(password),
    role: 'admin',
    email: '',
    enabled: true,
    note: '站长',
    createdVia: 'admin',
    emailVerifiedAt: 0,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: 0,
    wechatOpenId: '',
    wechatUnionId: '',
    wechatNickname: '',
    wechatAvatar: '',
    wechatSubscribed: false,
  })
  console.log(`已创建站长账号 ${username}`)
}

writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
console.log('当前用户：', config.users.map((user) => `${user.username}/${user.role}/${user.enabled ? 'on' : 'off'}`).join(', '))
