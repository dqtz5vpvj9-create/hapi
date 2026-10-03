import { memo, useCallback, useRef, type ReactNode } from 'react'
import { useGlassSurface } from '@/themes/glass/GlassScene'
import { useFloatingOverlayHeight } from '@/hooks/useFloatingOverlayHeight'

interface FloatingOverlayProps {
    children: ReactNode
    maxHeight?: number
}

/**
 * A floating panel container with shadow and rounded corners
 * Used for autocomplete suggestions and settings panels
 */
export const FloatingOverlay = memo(function FloatingOverlay(props: FloatingOverlayProps) {
    const { children, maxHeight = 240 } = props
    const glassRef = useGlassSurface<HTMLDivElement>()
    const panelRef = useRef<HTMLDivElement>(null)
    const height = useFloatingOverlayHeight(panelRef, maxHeight)
    const register = useCallback((element: HTMLDivElement | null) => {
        panelRef.current = element
        glassRef(element)
    }, [glassRef])

    return (
        <div
            ref={register}
            className="app-glass app-floating-panel flex min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--app-divider)] bg-[var(--app-bg)] shadow-lg"
            style={{ maxHeight: height }}
        >
            <div className="app-scroll-y min-h-0 overflow-y-auto" style={{ maxHeight: height }}>
                {children}
            </div>
        </div>
    )
})
