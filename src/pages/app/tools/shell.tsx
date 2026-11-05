// 参考图库页共用壳：宽内容区 + AppShell 标题。
import AppShell from '../AppShell'

export default function GalleryShell({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <AppShell title={title} wide>
      {children}
    </AppShell>
  )
}
