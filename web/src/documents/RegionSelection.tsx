import { useRef, useState, type PointerEvent } from 'react'
export type Region = { x: number; y: number; width: number; height: number }
export function RegionSelection({ onSelect }: { onSelect: (region: Region) => void }) {
    const start = useRef<{ x: number; y: number } | null>(null)
    const [region, setRegion] = useState<Region>()
    const point = (event: PointerEvent<HTMLDivElement>) => {
        const rect = event.currentTarget.getBoundingClientRect()
        return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }
    }
    const update = (event: PointerEvent<HTMLDivElement>) => {
        const from = start.current
        if (!from) return
        const to = point(event)
        const value = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) }
        setRegion(value)
        return value
    }
    return <div className="document-region-layer" onPointerDown={event => {
        if (event.button !== 0) return
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); start.current = point(event); setRegion(undefined)
    }} onPointerMove={update} onPointerUp={event => {
        const value = update(event); start.current = null
        if (value && value.width > .003 && value.height > .003) onSelect(value)
    }} onPointerCancel={() => { start.current = null; setRegion(undefined) }}>
        {region ? <div className="document-region" style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }} /> : null}
    </div>
}
