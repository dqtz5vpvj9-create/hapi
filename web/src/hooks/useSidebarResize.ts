import { useCallback, useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'hapi-sidebar-width'
const MIN_WIDTH = 280
const MAX_WIDTH = 600
const DEFAULT_WIDTH = 320

function clamp(value: number, workspace = false): number {
    return Math.min(MAX_WIDTH, Math.max(workspace ? 190 : MIN_WIDTH, value))
}

function loadWidth(workspace = false): number {
    const stored = localStorage.getItem(workspace ? `${STORAGE_KEY}:workspace` : STORAGE_KEY)
    if (stored) {
        const parsed = Number(stored)
        if (Number.isFinite(parsed)) return clamp(parsed, workspace)
    }
    return workspace ? 226 : DEFAULT_WIDTH
}

export function useSidebarResize(workspace = false) {
    const [widths, setWidths] = useState(() => ({ single: loadWidth(), workspace: loadWidth(true) }))
    const key = workspace ? 'workspace' : 'single'
    const width = widths[key]
    const [isDragging, setIsDragging] = useState(false)
    const startXRef = useRef(0)
    const startWidthRef = useRef(0)
    const activePointerIdRef = useRef<number | null>(null)

    const onPointerDown = useCallback((e: React.PointerEvent) => {
        e.preventDefault()
        // The sidebar (the handle's previous sibling) can render narrower than the
        // stored width when the viewport cap in index.css kicks in on a compact
        // split. Seed the drag from the actual rendered width so there's no dead
        // zone before the sidebar responds. Falls back to the stored width when the
        // element or its measured width is unavailable (e.g. non-DOM test env).
        const sidebarEl = e.currentTarget.previousElementSibling as HTMLElement | null
        const renderedWidth = sidebarEl?.getBoundingClientRect().width
        activePointerIdRef.current = e.pointerId
        startXRef.current = e.clientX
        startWidthRef.current = renderedWidth || width
        setIsDragging(true)
    }, [width])

    // Global listeners ensure pointerup is always captured even if cursor leaves the handle
    useEffect(() => {
        if (!isDragging) return

        const onMove = (e: PointerEvent) => {
            if (e.pointerId !== activePointerIdRef.current) return
            const delta = e.clientX - startXRef.current
            setWidths(current => ({ ...current, [key]: clamp(startWidthRef.current + delta, workspace) }))
        }

        const onUp = (e: PointerEvent) => {
            if (e.pointerId !== activePointerIdRef.current) return
            activePointerIdRef.current = null
            setIsDragging(false)
        }

        document.addEventListener('pointermove', onMove)
        document.addEventListener('pointerup', onUp)
        document.addEventListener('pointercancel', onUp)

        return () => {
            document.removeEventListener('pointermove', onMove)
            document.removeEventListener('pointerup', onUp)
            document.removeEventListener('pointercancel', onUp)
        }
    }, [isDragging, key, workspace])

    // Persist width to localStorage when drag ends
    useEffect(() => {
        if (!isDragging) {
            localStorage.setItem(workspace ? `${STORAGE_KEY}:workspace` : STORAGE_KEY, String(width))
        }
    }, [isDragging, width, workspace])

    // Prevent text selection while dragging
    useEffect(() => {
        if (isDragging) {
            document.body.style.userSelect = 'none'
            document.body.style.cursor = 'col-resize'
        } else {
            document.body.style.userSelect = ''
            document.body.style.cursor = ''
        }
        return () => {
            document.body.style.userSelect = ''
            document.body.style.cursor = ''
        }
    }, [isDragging])

    return { width, isDragging, onPointerDown }
}
