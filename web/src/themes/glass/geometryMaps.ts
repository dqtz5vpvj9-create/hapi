import { glassShapeKey, type GlassShape } from './optics'

/** One worker and a bounded geometry cache per mounted chat scene. */
export class GlassGeometryMaps {
    private worker = new Worker(new URL('./optics.worker.ts', import.meta.url), { type: 'module' })
    private cache = new Map<string, Promise<string>>()
    private pending = new Map<string, { resolve: (uri: string) => void; reject: (error: Error) => void }>()
    private workerError: Error | null = null

    constructor() {
        this.worker.onmessage = (event: MessageEvent<{ key: string; bytes?: ArrayBuffer; error?: string }>) => {
            const result = this.pending.get(event.data.key)
            if (!result) return
            const cached = this.cache.get(event.data.key)
            this.pending.delete(event.data.key)
            this.trim()
            if (event.data.error) {
                this.cache.delete(event.data.key)
                result.reject(new Error(event.data.error))
                return
            }
            const reader = new FileReader()
            reader.onload = () => result.resolve(reader.result as string)
            reader.onerror = () => {
                if (this.cache.get(event.data.key) === cached) this.cache.delete(event.data.key)
                result.reject(new Error('Unable to read glass geometry image'))
            }
            reader.readAsDataURL(new Blob([event.data.bytes!], { type: 'image/png' }))
        }
        this.worker.onerror = (event) => {
            this.workerError = new Error(event.message)
            for (const request of this.pending.values()) request.reject(this.workerError)
            this.pending.clear()
            this.cache.clear()
        }
    }

    get(shape: GlassShape): Promise<string> {
        // A startup error can arrive before the first surface requests a map.
        // Reject later requests too, rather than waiting on a failed worker.
        if (this.workerError) return Promise.reject(this.workerError)
        const key = glassShapeKey(shape)
        const previous = this.cache.get(key)
        if (previous) return previous
        const next = new Promise<string>((resolve, reject) => {
            this.pending.set(key, { resolve, reject })
            this.worker.postMessage({ key, shape: { width: shape.width, height: shape.height, radius: shape.radius } })
        })
        // Evicted data URIs remain valid for mounted surfaces. Pending work is
        // retained until its response arrives, then becomes eligible for eviction.
        this.trim()
        this.cache.set(key, next)
        return next
    }

    private trim(): void {
        while (this.cache.size >= 12) {
            const oldest = [...this.cache.keys()].find(candidate => !this.pending.has(candidate))
            if (!oldest) break
            this.cache.delete(oldest)
        }
    }

    destroy(): void {
        this.worker.terminate()
        for (const request of this.pending.values()) request.reject(new Error('Glass scene unmounted'))
        this.pending.clear()
        this.cache.clear()
    }
}
