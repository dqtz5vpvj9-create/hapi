import type { ReactNode } from 'react'
function Icon({ size = 20, children }: { size?: number; children: ReactNode }) {
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
}
export const ArrowUp = ({ size }: { size?: number }) => <Icon size={size}><path d="M12 19V5m-7 7 7-7 7 7" /></Icon>
export const Plus = ({ size }: { size?: number }) => <Icon size={size}><path d="M12 5v14M5 12h14" /></Icon>
export const MoreHorizontal = ({ size }: { size?: number }) => <Icon size={size}><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></Icon>
export const Folder = ({ size }: { size?: number }) => <Icon size={size}><path d="M3 7V5h7l2 2h9v13H3V7zm0 3h18" /></Icon>
export const Monitor = ({ size }: { size?: number }) => <Icon size={size}><rect x="3" y="3" width="18" height="13" rx="2" /><path d="M8 21h8m-4-5v5" /></Icon>
export const Shield = ({ size }: { size?: number }) => <Icon size={size}><path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7l8-4z" /><path d="m8 12 3 3 5-6" /></Icon>
export const Sparkles = ({ size }: { size?: number }) => <Icon size={size}><path d="m9 3 2.5 6.5L18 12l-6.5 2.5L9 21l-2.5-6.5L0 12l6.5-2.5L9 3zm10-2 1.1 2.9L23 5l-2.9 1.1L19 9l-1.1-2.9L15 5l2.9-1.1L19 1z" /></Icon>
export const ChevronUp = ({ size }: { size?: number }) => <Icon size={size}><path d="m6 14 6-6 6 6" /></Icon>
export const Refresh = ({ size }: { size?: number }) => <Icon size={size}><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" /><path d="M3 21v-5h5" /></Icon>
