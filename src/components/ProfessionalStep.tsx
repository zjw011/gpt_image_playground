import type { ReactNode } from 'react'

export default function ProfessionalStep({ step, children }: { step: number; children: ReactNode }) {
  return <h3 className="flex items-center gap-2.5 text-sm font-bold text-[#35315d] sm:text-[15px]"><span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#a18bff] to-[#7758ee] text-xs font-bold text-white shadow-sm shadow-violet-200">{step}</span>{children}</h3>
}
