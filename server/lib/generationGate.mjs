// 生图入口的资源闸门：限制全站并发、单用户/IP 并发和分钟频率。
// 公网站点不能只依赖上游限流，否则机器人能先把我们的连接池和渠道额度耗光。

function positiveInt(value, fallback, max = 10_000) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(max, Math.trunc(parsed))
}

export function createGenerationGate(options = {}) {
  const globalLimit = positiveInt(options.globalLimit, 30)
  const identityLimit = positiveInt(options.identityLimit, 2)
  const perMinute = positiveInt(options.perMinute, 12)
  const active = new Map()
  const recent = new Map()
  let globalActive = 0

  return {
    acquire(identity, now = Date.now()) {
      const key = String(identity || 'unknown')
      const cutoff = now - 60_000
      const stamps = (recent.get(key) ?? []).filter((at) => at > cutoff)
      recent.set(key, stamps)
      if (recent.size > 10_000) {
        const oldest = recent.keys().next().value
        if (oldest != null && oldest !== key && !active.has(oldest)) recent.delete(oldest)
      }

      if (stamps.length >= perMinute) {
        return {
          ok: false,
          reason: 'rate',
          retryAfterSeconds: Math.max(1, Math.ceil((stamps[0] + 60_000 - now) / 1000)),
        }
      }
      if (globalActive >= globalLimit) return { ok: false, reason: 'global', retryAfterSeconds: 5 }
      if ((active.get(key) ?? 0) >= identityLimit) return { ok: false, reason: 'identity', retryAfterSeconds: 3 }

      stamps.push(now)
      active.set(key, (active.get(key) ?? 0) + 1)
      globalActive += 1
      let released = false
      return {
        ok: true,
        release() {
          if (released) return
          released = true
          const next = (active.get(key) ?? 1) - 1
          if (next > 0) active.set(key, next)
          else active.delete(key)
          globalActive = Math.max(0, globalActive - 1)
        },
      }
    },
    reset() {
      active.clear()
      recent.clear()
      globalActive = 0
    },
  }
}

export const generationGate = createGenerationGate({
  globalLimit: process.env.GIP_GENERATION_GLOBAL_CONCURRENCY,
  identityLimit: process.env.GIP_GENERATION_USER_CONCURRENCY,
  perMinute: process.env.GIP_GENERATION_PER_MINUTE,
})
