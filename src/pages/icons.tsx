// 绘想页面的线性图标集。24×24 描边图标，集中放一处避免各页面重复定义。
interface IconProps {
  className?: string
  strokeWidth?: number
}

function Base({ children, className, strokeWidth = 1.7 }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export const IconSparkle = ({ className }: IconProps) => (
  <Base className={className}>
    <path d="M12 3.5l1.7 4.6 4.6 1.7-4.6 1.7L12 16.1l-1.7-4.6L5.7 9.8l4.6-1.7L12 3.5z" />
    <path d="M19 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" />
  </Base>
)

export const IconBrush = ({ className }: IconProps) => (
  <Base className={className}>
    <path d="M9.5 14.5L3 21l1 .5c2 .8 4.5.3 5.5-1.7l1-2.1" />
    <path d="M14.5 9.5l4.95-4.95a2.12 2.12 0 0 0-3-3L11.5 6.5" />
    <path d="M11 7l6 6" />
    <path d="M8.5 12.5l3 3" />
  </Base>
)

export const IconGrid = ({ className }: IconProps) => (
  <Base className={className}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
  </Base>
)

export const IconImage = ({ className }: IconProps) => (
  <Base className={className}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M4.5 17.5l4.5-4.5 3.5 3.5 3.5-3.5 4.5 4.5" />
  </Base>
)

export const IconCoin = ({ className }: IconProps) => (
  <Base className={className}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5v9M9.2 9.6c0-1.1 1.2-1.9 2.8-1.9s2.8.8 2.8 1.9c0 2.7-5.6 1.7-5.6 4.4 0 1.1 1.2 1.9 2.8 1.9s2.8-.8 2.8-1.9" />
  </Base>
)

export const IconUser = ({ className }: IconProps) => (
  <Base className={className}>
    <circle cx="12" cy="8.2" r="3.7" />
    <path d="M4.5 20.2c.8-3.7 3.9-5.7 7.5-5.7s6.7 2 7.5 5.7" />
  </Base>
)

export const IconDownload = ({ className }: IconProps) => (
  <Base className={className}>
    <path d="M12 4v11M7.5 11l4.5 4.5L16.5 11" />
    <path d="M4.5 19.5h15" />
  </Base>
)

export const IconHeart = ({ className, filled }: IconProps & { filled?: boolean }) => (
  <svg viewBox="0 0 24 24" className={className} fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20.3C6.4 16.9 3.5 13.6 3.5 10.2 3.5 7.6 5.5 5.5 8 5.5c1.6 0 3.1.8 4 2.1.9-1.3 2.4-2.1 4-2.1 2.5 0 4.5 2.1 4.5 4.7 0 3.4-2.9 6.7-8.5 10.1z" />
  </svg>
)

export const IconStar = ({ className, filled }: IconProps & { filled?: boolean }) => (
  <svg viewBox="0 0 24 24" className={className} fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" />
  </svg>
)

export const IconEdit = ({ className }: IconProps) => (
  <Base className={className}>
    <path d="M4 20l1-4L16.5 4.5a2.12 2.12 0 0 1 3 3L8 19l-4 1z" />
    <path d="M14.5 6.5l3 3" />
  </Base>
)

export const IconShare = ({ className }: IconProps) => (
  <Base className={className}>
    <circle cx="6" cy="12" r="2.5" />
    <circle cx="18" cy="6" r="2.5" />
    <circle cx="18" cy="18" r="2.5" />
    <path d="M8.2 10.8l7.6-3.6M8.2 13.2l7.6 3.6" />
  </Base>
)

export const IconTrash = ({ className }: IconProps) => (
  <Base className={className}>
    <path d="M4.5 6.5h15M9.5 6V4.5A1.5 1.5 0 0 1 11 3h2a1.5 1.5 0 0 1 1.5 1.5V6" />
    <path d="M6.5 6.5l1 13A1.5 1.5 0 0 0 9 21h6a1.5 1.5 0 0 0 1.5-1.5l1-13" />
    <path d="M10 10.5v6M14 10.5v6" />
  </Base>
)

export const IconCopy = ({ className }: IconProps) => (
  <Base className={className}>
    <rect x="9" y="9" width="11.5" height="11.5" rx="2" />
    <path d="M5.5 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v.5" />
  </Base>
)

export const IconLogout = ({ className }: IconProps) => (
  <Base className={className}>
    <path d="M14 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7" />
    <path d="M10 12h10.5M17 8.5l3.5 3.5-3.5 3.5" />
  </Base>
)

export const IconSearch = ({ className }: IconProps) => (
  <Base className={className}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </Base>
)

export const IconHelp = ({ className }: IconProps) => (
  <Base className={className}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9.6 9.2A2.6 2.6 0 0 1 12 7.5c1.4 0 2.5 1 2.5 2.2 0 1.7-2.2 2-2.5 3.6" />
    <circle cx="12" cy="16.8" r="0.4" fill="currentColor" />
  </Base>
)

export const IconHome = ({ className }: IconProps) => (
  <Base className={className}>
    <path d="M4 11.5L12 4l8 7.5" />
    <path d="M6 10v9.5h4.5V14h3v5.5H18V10" />
  </Base>
)

export const IconCheck = ({ className }: IconProps) => (
  <Base className={className}><path d="M20 6.5L9.5 17 4 11.6" /></Base>
)

export const IconArrowRight = ({ className }: IconProps) => (
  <Base className={className}><path d="M4.5 12h15M14 6.5l5.5 5.5-5.5 5.5" /></Base>
)

export const IconArrowLeft = ({ className }: IconProps) => (
  <Base className={className}><path d="M19.5 12h-15M10 6.5L4.5 12l5.5 5.5" /></Base>
)

export const IconEye = ({ className }: IconProps) => (
  <Base className={className}>
    <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </Base>
)

export const IconMail = ({ className }: IconProps) => (
  <Base className={className}>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="M4 7.5l8 6 8-6" />
  </Base>
)

export const IconLock = ({ className }: IconProps) => (
  <Base className={className}>
    <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
  </Base>
)

export const IconShield = ({ className }: IconProps) => (
  <Base className={className}>
    <path d="M12 3l7.5 3v6c0 4.6-3.2 7.7-7.5 9-4.3-1.3-7.5-4.4-7.5-9V6L12 3z" />
    <path d="M9 11.8l2.2 2.2 4-4.2" />
  </Base>
)

export const IconBolt = ({ className }: IconProps) => (
  <Base className={className}><path d="M13 3L5 13.5h5L10.5 21 19 10h-5.5L13 3z" /></Base>
)

export const IconWallet = ({ className }: IconProps) => (
  <Base className={className}>
    <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5v-9z" />
    <path d="M15 12.5h5v3h-5a1.5 1.5 0 0 1 0-3z" />
  </Base>
)

export const IconSettings = ({ className }: IconProps) => (
  <Base className={className}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.89a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.11A1.7 1.7 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09c0 .68.4 1.3 1 1.55.61.26 1.32.11 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.11c.26.6.88 1 1.55 1H21a2 2 0 1 1 0 4h-.09c-.68 0-1.3.4-1.51 1z" />
  </Base>
)

export const IconRobot = ({ className }: IconProps) => (
  <Base className={className}>
    <rect x="5" y="8" width="14" height="11" rx="2.5" />
    <path d="M12 8V4.5M9 4.5h6" />
    <circle cx="9.5" cy="13" r="0.6" fill="currentColor" />
    <circle cx="14.5" cy="13" r="0.6" fill="currentColor" />
    <path d="M9.5 16h5" />
  </Base>
)

export const IconLayers = ({ className }: IconProps) => (
  <Base className={className}>
    <path d="M12 3.5l8.5 4.7-8.5 4.7-8.5-4.7L12 3.5z" />
    <path d="M4.5 12.7L12 17l7.5-4.3" />
    <path d="M4.5 16.7L12 21l7.5-4.3" />
  </Base>
)

export const IconUpload = ({ className }: IconProps) => (
  <Base className={className}>
    <path d="M12 15.5v-11M7.5 8.5L12 4l4.5 4.5" />
    <path d="M4.5 19.5h15" />
  </Base>
)

export const IconPlus = ({ className }: IconProps) => (
  <Base className={className}><path d="M12 5v14M5 12h14" /></Base>
)

export const IconMinus = ({ className }: IconProps) => (
  <Base className={className}><path d="M5 12h14" /></Base>
)

export const IconRefresh = ({ className }: IconProps) => (
  <Base className={className}>
    <path d="M20 12a8 8 0 1 1-2.34-5.66" />
    <path d="M20 4v4.5h-4.5" />
  </Base>
)

export const IconWechat = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
    <path d="M9.3 4C5.4 4 2.2 6.6 2.2 9.9c0 1.9.98 3.5 2.6 4.6l-.65 1.95 2.27-1.13c.58.16 1.2.26 1.84.28-.1-.42-.16-.86-.16-1.31 0-3.08 2.94-5.58 6.56-5.58.24 0 .47.01.7.03C14.7 6.14 12.2 4 9.3 4zM7.4 7.5c.46 0 .83.37.83.83s-.37.83-.83.83-.83-.37-.83-.83.37-.83.83-.83zm3.9 0c.46 0 .83.37.83.83s-.37.83-.83.83-.83-.37-.83-.83.37-.83.83-.83z" />
    <path d="M14.9 9.8c-3.22 0-5.83 2.14-5.83 4.78 0 2.64 2.61 4.78 5.83 4.78.63 0 1.24-.09 1.81-.24l1.94.97-.55-1.66c1.42-.94 2.35-2.3 2.35-3.85 0-2.64-2.61-4.78-5.55-4.78zm-1.95 2.4c.38 0 .69.31.69.69s-.31.69-.69.69-.69-.31-.69-.69.31-.69.69-.69zm3.9 0c.38 0 .69.31.69.69s-.31.69-.69.69-.69-.31-.69-.69.31-.69.69-.69z" />
  </svg>
)
