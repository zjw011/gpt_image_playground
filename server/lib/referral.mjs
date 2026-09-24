// 邀请返积分 + 同 IP 注册限制。
//
// 两道防线的设计前提：**奖励必须滞后到"被邀请人真的用了产品"之后**
// （这里是第一次成功出图）。只按注册发奖，等于给刷号集团发工资；
// 挂上"必须出图"这个动作之后，刷号成本远高于收益，自然就没人刷了。
import { addCredits } from './credits.mjs'
import { getConfig, updateConfig } from './store.mjs'

/**
 * 把 IP 归一到"可比较的粒度"。
 * IPv6 每台设备甚至每次连接的后缀都可能不同，直接用完整地址会让限制形同虚设，
 * 所以按 /64 前缀归并（一个家庭/一个局域网的常见分配粒度）。
 * IPv4 和 IPv4-mapped IPv6（::ffff:1.2.3.4）按原样比较。
 */
export function normalizeIp(raw) {
  const ip = String(raw ?? '').trim().toLowerCase()
  if (!ip) return ''
  const mapped = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  if (mapped.includes('.')) return mapped
  if (!mapped.includes(':')) return mapped
  // 展开 :: 省略再取前 4 段
  const [head, tail] = mapped.split('::')
  const headParts = head ? head.split(':').filter(Boolean) : []
  const tailParts = tail ? tail.split(':').filter(Boolean) : []
  const fill = new Array(Math.max(0, 8 - headParts.length - tailParts.length)).fill('0')
  const full = [...headParts, ...fill, ...tailParts]
  return full.slice(0, 4).join(':')
}

/** 同一 IP 已经注册了几个账号（管理员手动建的账号不参与统计，那是救急通道）。 */
export function countAccountsForIp(ip) {
  const target = normalizeIp(ip)
  if (!target) return 0
  return getConfig().users.filter((user) => user.createdVia !== 'admin' && normalizeIp(user.registerIp) === target).length
}

/** 解析邀请链接里的 ref。只有真实存在、启用中的账号才算数，找不到就当作没填。 */
export function resolveInviter(ref) {
  const id = String(ref ?? '').trim()
  if (!id) return null
  const user = getConfig().users.find((item) => item.id === id)
  if (!user || !user.enabled) return null
  return user
}

/**
 * 被邀请人第一次成功出图后调用。
 * 幂等：靠 inviteRewarded 标记保证只发一次；邀请人自己人不在、超上限、配置关掉都直接跳过。
 * 返回 { rewarded, reward?, reason? }，调用方只用来打日志。
 */
export function maybeRewardInviter(userId) {
  const config = getConfig()
  const site = config.site
  if (!site.referralEnabled) return { rewarded: false, reason: 'disabled' }

  const invitee = config.users.find((user) => user.id === userId)
  if (!invitee || !invitee.invitedBy || invitee.inviteRewarded) return { rewarded: false, reason: 'no-invite' }

  const inviter = config.users.find((user) => user.id === invitee.invitedBy)
  if (!inviter || !inviter.enabled) return { rewarded: false, reason: 'inviter-missing' }

  const reward = Math.max(0, Math.trunc(site.referralReward))
  if (reward <= 0) return { rewarded: false, reason: 'zero-reward' }

  // 邀请人的奖励次数上限（0 = 不限）
  const maxInvites = Math.max(0, Math.trunc(site.referralMaxInvites))
  if (maxInvites > 0) {
    const rewardedCount = config.users.filter((user) => user.invitedBy === inviter.id && user.inviteRewarded).length
    if (rewardedCount >= maxInvites) return { rewarded: false, reason: 'cap-reached' }
  }

  // 先标记再发钱：万一发奖过程中进程挂掉，宁可不发也不能重复发。
  updateConfig((next) => {
    const target = next.users.find((user) => user.id === invitee.id)
    if (target) target.inviteRewarded = true
    return next
  })
  addCredits(inviter.id, reward, {
    type: 'referral',
    ref: invitee.id,
    note: `邀请「${invitee.displayName || invitee.username}」首图奖励`,
  })
  return { rewarded: true, reward, inviterId: inviter.id }
}

/** 邀请人的战果统计，给个人中心展示用。 */
export function inviteStats(userId) {
  const users = getConfig().users.filter((user) => user.invitedBy === userId)
  return {
    invited: users.length,
    rewarded: users.filter((user) => user.inviteRewarded).length,
  }
}
