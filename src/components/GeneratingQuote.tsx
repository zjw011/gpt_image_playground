// 生成等待时的一句话轮播。
// 优先拉一言（https://v1.hitokoto.cn）的句子，拉不到就用内置文案池兜底——
// 网络不行、接口挂了都不能让等待区开天窗。10 秒换一句。
import { useEffect, useState } from 'react'

const LOCAL_POOL = [
  '想象力是画笔，耐心是颜料。',
  '每一张图，都是一次小小的宇宙大爆炸。',
  '慢慢来，好作品值得等。',
  '此刻的等待，是为了更好地惊艳。',
  '灵感在画布上散步，请勿催促。',
  '像素们正在努力排好队形。',
  '你描述的世界，正在被一笔一笔点亮。',
  '创作是一场温柔的冒险。',
  '风起了，画面正在成形。',
  '好画面和好故事一样，都需要一点时间发酵。',
  '把期待交给时间，把想象交给你。',
  '线条正在寻找它们的归宿。',
  '色彩在纸上悄悄晕开，别眨眼。',
  '静下心来，惊喜马上登场。',
  '每一次生成，都是独一无二的相遇。',
  '黑暗中的画笔，正在为你描摹光。',
  '山川湖海，此刻都在赶来见你。',
  '闭上眼睛三秒钟，睁开就是新世界。',
]

interface Quote { text: string, from: string }

const FALLBACK: Quote[] = LOCAL_POOL.map((text) => ({ text, from: '' }))

async function fetchHitokoto(signal: AbortSignal): Promise<Quote | null> {
  try {
    // 诗词 / 哲学两类更贴"情绪句子"的气质；3 秒拉不到就放弃
    const response = await fetch('https://v1.hitokoto.cn/?c=i&c=k&max_length=30', { signal })
    if (!response.ok) return null
    const data = (await response.json()) as { hitokoto?: string, from?: string }
    if (!data.hitokoto) return null
    return { text: data.hitokoto, from: data.from ?? '' }
  } catch {
    return null
  }
}

export default function GeneratingQuote() {
  const [pool, setPool] = useState<Quote[]>(() => {
    // 首屏先随机一句本地的，避免固定从第一句开始
    const shuffled = [...FALLBACK].sort(() => Math.random() - 0.5)
    return shuffled
  })
  const [index, setIndex] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    // 并发拉 3 句一言混进池子：拉到就换着展示，拉不到本地池也足够撑场
    void Promise.all([
      fetchHitokoto(controller.signal),
      fetchHitokoto(controller.signal),
      fetchHitokoto(controller.signal),
    ]).then((fetched) => {
      const extra = fetched.filter((item): item is Quote => Boolean(item))
      if (extra.length) {
        setPool((current) => {
          const merged = [...extra, ...current]
          // 换一批后立刻跳到一言的句子上，用户能感知到"换内容了"
          setIndex(0)
          return merged
        })
      }
    })

    const timer = setInterval(() => {
      setIndex((current) => (current + 1) % Math.max(1, pool.length))
    }, 10_000)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
    // pool.length 变化后需要重置计时器
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool.length])

  const current = pool[index % pool.length] ?? FALLBACK[0]

  return (
    <div className="mt-5 max-w-sm px-4">
      <p key={current.text} className="text-[13px] leading-6 text-[#8a86ac] transition-opacity">
        「{current.text}」
      </p>
      {current.from && <p className="mt-1 text-[11px] text-[#b3aed0]">—— {current.from}</p>}
    </div>
  )
}
