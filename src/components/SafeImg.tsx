// 静态配图（首页主视觉、风格示例、广场示例图）用的 <img>。
//
// 为什么需要它：站点更新时容器会重建，重建窗口里的图片请求会拿到 502/404，
// 浏览器不会自己重试——用户看到的就是"图片都没了"，还得手动刷新。
// 这里在首次加载失败后延迟重试一次（带 cache-bust 参数），
// 一次性的网络/部署抖动就能自愈；两次都失败才显示占位。
import { useEffect, useState } from 'react'

interface Props {
  src: string
  alt: string
  className?: string
  /** 占位样式（跟随容器尺寸），失败两次后展示 */
  fallbackClassName?: string
  loading?: 'lazy' | 'eager'
}

export default function SafeImg({ src, alt, className, fallbackClassName, loading = 'lazy' }: Props) {
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)

  // 换图（列表重新渲染）时重置状态，否则会沿用上一张图的失败态
  useEffect(() => {
    setAttempt(0)
    setFailed(false)
  }, [src])

  if (failed) {
    return (
      <span className={fallbackClassName ?? className ?? ''} aria-label={alt} role="img">
        <span className="flex h-full w-full items-center justify-center bg-[#f5f4fb] text-[11px] text-[#b3aed0]">图片加载失败</span>
      </span>
    )
  }

  return (
    <img
      // 重试时加一个查询参数绕开浏览器可能缓存住的失败响应
      src={attempt === 0 ? src : `${src}${src.includes('?') ? '&' : '?'}retry=${attempt}`}
      alt={alt}
      loading={loading}
      className={className}
      onError={() => {
        if (attempt >= 1) {
          setFailed(true)
          return
        }
        // 隔一拍再重试：容器重启通常只需要一两秒
        setTimeout(() => setAttempt((value) => value + 1), 1200)
      }}
    />
  )
}
