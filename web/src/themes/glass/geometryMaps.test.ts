import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GlassGeometryMaps } from './geometryMaps'
import type { GlassShape } from './optics'

class TestWorker {
    static instances: TestWorker[] = []
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: ErrorEvent) => void) | null = null
    messages: { key: string; shape: GlassShape }[] = []
    terminated = false

    constructor() { TestWorker.instances.push(this) }
    postMessage(message: { key: string; shape: GlassShape }) { this.messages.push(message) }
    terminate() { this.terminated = true }
    fail() { this.onerror?.({ message: 'Worker module failed to load' } as ErrorEvent) }
    respond() {
        const { key } = this.messages.at(-1)!
        this.onmessage?.({ data: { key, bytes: new ArrayBuffer(4) } } as MessageEvent)
    }
}

class TestReader {
    static instances: TestReader[] = []
    result: string | null = null
    onload: (() => void) | null = null
    onerror: (() => void) | null = null

    constructor() { TestReader.instances.push(this) }
    readAsDataURL(_blob: Blob) {}
    succeed() { this.result = 'data:image/png;base64,test-map'; this.onload?.() }
    fail() { this.onerror?.() }
}

const shape: GlassShape = { width: 120, height: 44, radius: 22 }

beforeEach(() => {
    TestWorker.instances = []
    TestReader.instances = []
    vi.stubGlobal('Worker', TestWorker)
    vi.stubGlobal('FileReader', TestReader)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('glass map worker lifecycle', () => {
    it('rejects a request made after an early worker startup error without posting to it', async () => {
        const maps = new GlassGeometryMaps()
        const worker = TestWorker.instances[0]
        worker.fail() // Failure arrives before any surface requested its map.
        let outcome = 'pending'
        const request = maps.get(shape).then(() => { outcome = 'resolved' }, () => { outcome = 'rejected' })
        await Promise.resolve()
        expect(outcome).toBe('rejected')
        await request
        expect(worker.messages).toHaveLength(0)
        maps.destroy()
    })

    it('rejects current and future requests after worker failure', async () => {
        const maps = new GlassGeometryMaps()
        const worker = TestWorker.instances[0]
        const first = maps.get(shape)
        const rejection = expect(first).rejects.toThrow('Worker module failed to load')
        worker.fail()
        await rejection
        await expect(maps.get(shape)).rejects.toThrow('Worker module failed to load')
        expect(worker.messages).toHaveLength(1)
        maps.destroy()
    })

    it('allows an image-read failure to request a new map for the same shape', async () => {
        const maps = new GlassGeometryMaps()
        const worker = TestWorker.instances[0]
        const first = maps.get(shape)
        const rejection = expect(first).rejects.toThrow('Unable to read glass geometry image')
        worker.respond()
        TestReader.instances[0].fail()
        await rejection
        const retry = maps.get(shape)
        void retry.catch(() => {})
        expect(retry).not.toBe(first)
        expect(worker.messages).toHaveLength(2)
        worker.respond()
        TestReader.instances[1].succeed()
        await expect(retry).resolves.toBe('data:image/png;base64,test-map')
        maps.destroy()
    })

    it('shares successful pending and cached maps without additional worker requests', async () => {
        const maps = new GlassGeometryMaps()
        const worker = TestWorker.instances[0]
        const first = maps.get(shape)
        expect(maps.get({ ...shape })).toBe(first)
        expect(worker.messages).toHaveLength(1)
        worker.respond()
        TestReader.instances[0].succeed()
        await expect(first).resolves.toBe('data:image/png;base64,test-map')
        expect(maps.get({ ...shape })).toBe(first)
        expect(worker.messages).toHaveLength(1)
        maps.destroy()
        expect(worker.terminated).toBe(true)
    })

    it('does not evict a newer request when an older evicted image read fails', async () => {
        const maps = new GlassGeometryMaps()
        const worker = TestWorker.instances[0]
        const first = maps.get(shape)
        const rejection = expect(first).rejects.toThrow('Unable to read glass geometry image')
        worker.respond()
        // The first response is still being read when shape-cache pressure
        // evicts it. A later surface can then request that same shape again.
        for (let width = 121; width <= 132; width++) {
            void maps.get({ ...shape, width }).catch(() => {})
        }
        const retry = maps.get(shape)
        TestReader.instances[0].fail()
        await rejection
        expect(maps.get(shape)).toBe(retry)
        worker.respond()
        TestReader.instances[1].succeed()
        await expect(retry).resolves.toBe('data:image/png;base64,test-map')
        maps.destroy()
    })
})
