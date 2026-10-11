/** Ordered relative input received while the initial reader has no range.
 * Consecutive directions coalesce; reversals remain ordered because each edge
 * clamps independently. A stalled request retains at most 128 segments.
 * Overflow abandons replay for this opening rather than silently truncating it.
 */
export class OpeningScrollIntent {
    private segments: number[] = []
    private abandoned = false
    get pending(): boolean { return this.segments.length > 0 }
    get size(): number { return this.segments.length }
    append(delta: number): void {
        if (this.abandoned || !Number.isFinite(delta) || delta === 0) return
        const last = this.segments.at(-1)
        if (last !== undefined && Math.sign(last) === Math.sign(delta)) {
            const sum = last + delta
            if (!Number.isFinite(sum)) { this.abandon(); return }
            this.segments[this.segments.length - 1] = sum
        } else if (this.segments.length < 128) this.segments.push(delta)
        else this.abandon()
    }
    consume(floor: number): number {
        let top = floor
        for (const delta of this.segments) top = Math.max(0, Math.min(floor, top + delta))
        this.clear()
        return top
    }
    clear(): void { this.segments = []; this.abandoned = false }
    private abandon(): void { this.segments = []; this.abandoned = true }
}
