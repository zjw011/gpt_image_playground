// 登录限流：按 IP 统计失败次数，超过阈值后短时间锁定。
// 只针对登录接口，避免共享口令被在线爆破。

const WINDOW_MS = 10 * 60 * 1000
const MAX_FAILURES = 10
const LOCK_MS = 10 * 60 * 1000

const buckets = new Map()

function getBucket(key) {
  const now = Date.now()
  const bucket = buckets.get(key)
  if (!bucket || now - bucket.firstAt > WINDOW_MS) {
    const fresh = { firstAt: now, failures: 0, lockedUntil: 0 }
    buckets.set(key, fresh)
    return fresh
  }
  return bucket
}

export function isLocked(key) {
  const bucket = getBucket(key)
  return bucket.lockedUntil > Date.now()
}

export function getLockRemainingSeconds(key) {
  const bucket = getBucket(key)
  return Math.max(0, Math.ceil((bucket.lockedUntil - Date.now()) / 1000))
}

export function recordFailure(key) {
  const bucket = getBucket(key)
  bucket.failures += 1
  if (bucket.failures >= MAX_FAILURES) bucket.lockedUntil = Date.now() + LOCK_MS
  if (buckets.size > 10_000) {
    const oldest = buckets.keys().next().value
    if (oldest != null && oldest !== key) buckets.delete(oldest)
  }
}

export function recordSuccess(key) {
  buckets.delete(key)
}
