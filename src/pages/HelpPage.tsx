// 帮助中心。对应设计稿 11：搜索 + 常见问题手风琴。
// 公开访问用公开导航；已进入应用时套应用外壳，从侧栏点进来不会被踢回营销页。
import { useMemo, useState } from 'react'
import AppShell from './app/AppShell'
import { useInApp } from './useInApp'
import { PublicNav, SiteFooter, PageLoading } from './theme'
import { IconSearch, IconHelp } from './icons'

const FAQ = [
  {
    category: '常见问题',
    items: [
      { q: '如何生成图片？', a: '进入「AI 绘画」页，在输入框里用一句话描述你想要的画面（越具体越好），选择风格和比例后点击「立即生成」即可。生成完成后会跳转到结果页，可以下载或再次生成。' },
      { q: '积分如何消耗？', a: '每生成一张图片会扣除相应积分，具体消耗以生成按钮上的提示为准。如果生成失败，积分会自动全额退回，可以在「个人中心 → 积分记录」查看每笔变动。' },
      { q: '生成的图片可以商用吗？', a: '你通过绘想生成的图片，其使用权归你所有，可用于个人及商业用途。但请注意不要生成侵犯他人肖像权、著作权的内容。' },
      { q: '如何下载图片？', a: '在生成结果页点击右侧的「下载」按钮即可保存高清原图。也可以在「个人中心 → 我的作品」里点开任意作品，进入结果页后下载。' },
      { q: '积分不够了怎么办？', a: '进入「积分中心 → 充值」，可以用卡密兑换积分。如果本站已经开通在线支付，也可以直接选购套餐。' },
    ],
  },
  {
    category: '功能介绍',
    items: [
      { q: '支持哪些图片风格？', a: '支持动漫、写实、二次元、艺术插画等多种风格。在生成页的「选择风格」区域点击预设卡片，风格描述会自动加入提示词；也可以直接在提示词里自由描述风格。' },
      { q: '图生图、局部重绘和 AI 扩图有什么区别？', a: '图生图以上传的图片为参考整体再创作；局部重绘只重绘你涂抹遮罩的区域，其余部分保持不变；AI 扩图则在保持原图内容的基础上向外扩展画面。' },
      { q: '作品广场里的作品是谁的？', a: '作品广场目前展示的是平台示例作品，用于浏览风格和获取灵感。点开任意作品可以看到它的提示词，点「画同款」就能把提示词填进创作页。你的个人作品不会未经同意被公开。' },
    ],
  },
  {
    category: '账号与安全',
    items: [
      { q: '忘记密码怎么办？', a: '在登录页点击「忘记密码」，输入注册邮箱获取验证码，验证后即可设置新密码。' },
      { q: '我的作品保存在哪里？', a: '你的作品保存在你的账号工作区下，只有你自己能看到，换设备登录同一账号即可查看。未启用账号系统时，作品只保存在当前浏览器本地。' },
      { q: '如何联系客服？', a: '可以发邮件到本站注册时使用的邮箱域名对应的管理员邮箱，或通过后台公示的联系方式联系我们。反馈积分异常时请附上「积分记录」页的截图，方便快速定位。' },
    ],
  },
]

function HelpCenter() {
  const [keyword, setKeyword] = useState('')
  const [open, setOpen] = useState<string | null>(FAQ[0].items[0].q)

  const groups = useMemo(() => {
    const key = keyword.trim()
    if (!key) return FAQ
    return FAQ
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => item.q.includes(key) || item.a.includes(key)),
      }))
      .filter((group) => group.items.length > 0)
  }, [keyword])

  return (
    <section className="mx-auto max-w-3xl px-5 pb-20 pt-14">
      <div className="text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-[#7c6cf6] to-[#a78bfa] text-white shadow-lg shadow-[#7c6cf6]/30">
          <IconHelp className="h-7 w-7" />
        </span>
        <h1 className="mt-5 text-3xl font-bold tracking-tight">帮助中心</h1>
        <p className="mt-3 text-sm text-[#8a86ac]">常见问题与使用指南</p>

        <div className="relative mx-auto mt-7 max-w-md">
          <IconSearch className="absolute left-4 top-1/2 h-4.5 w-4.5 -translate-y-1/2 text-[#b3aed0]" />
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索问题，例如：积分"
            className="w-full rounded-full border border-[#e4e1f2] bg-white py-3 pl-11 pr-5 text-sm shadow-sm outline-none transition placeholder:text-[#b3aed0] focus:border-[#7c6cf6] focus:ring-4 focus:ring-[#7c6cf6]/10"
          />
        </div>
      </div>

      <div className="mt-10 space-y-8">
        {groups.length === 0 && (
          <p className="rounded-2xl border border-[#eceaf6] bg-white py-14 text-center text-sm text-[#a5a1c4]">
            没有找到相关问题，换个关键词试试
          </p>
        )}
        {groups.map((group) => (
          <div key={group.category}>
            <h2 className="flex items-center gap-2 text-[15px] font-bold">
              <span className="h-4 w-1 rounded-full bg-gradient-to-b from-[#7c6cf6] to-[#a78bfa]" />
              {group.category}
            </h2>
            <div className="mt-4 space-y-2.5">
              {group.items.map((item) => {
                const expanded = open === item.q
                return (
                  <div key={item.q} className={`overflow-hidden rounded-2xl border bg-white transition ${expanded ? 'border-[#cdc7ee] shadow-md shadow-[#7c6cf6]/8' : 'border-[#eceaf6]'}`}>
                    <button
                      type="button"
                      onClick={() => setOpen(expanded ? null : item.q)}
                      className="flex w-full items-center justify-between px-5 py-4 text-left text-sm font-medium"
                    >
                      {item.q}
                      <span className={`ml-4 shrink-0 text-[#b3aed0] transition-transform ${expanded ? 'rotate-180' : ''}`}>▾</span>
                    </button>
                    {expanded && (
                      <p className="border-t border-[#f4f2fe] px-5 py-4 text-[13px] leading-6 text-[#6f6a94]">
                        {item.a}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

export default function HelpPage() {
  const inApp = useInApp()
  if (inApp === undefined) return <PageLoading />
  if (inApp) {
    return (
      <AppShell title="帮助中心">
        <HelpCenter />
      </AppShell>
    )
  }

  return (
    <div className="min-h-screen bg-[#f5f4fb] text-[#37335c]">
      <PublicNav active="help" />
      <HelpCenter />
      <SiteFooter />
    </div>
  )
}
