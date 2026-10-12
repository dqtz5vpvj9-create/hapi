import { describe, expect, it, vi } from 'vitest'
import { createForkNavigator } from './fork-navigation'

describe('fork navigation recovery', () => {
    it('reuses a native child across equivalent selector objects after navigation fails', async () => {
        const boundary = { threadId: 'thread', turnId: 'turn', itemId: 'item' }
        const create = vi.fn(async () => ({ sessionId: 'native-child' }))
        const navigate = vi.fn().mockRejectedValueOnce(new Error('route failed')).mockResolvedValue(undefined)
        const fork = createForkNavigator(create, navigate)
        await expect(fork(boundary)).rejects.toThrow('route failed')
        await fork({ itemId: 'item', threadId: 'thread', turnId: 'turn' })
        expect(create).toHaveBeenCalledExactlyOnceWith(boundary)
        expect(navigate.mock.calls).toEqual([['native-child'], ['native-child']])
    })

    it('does not confuse current, managed and native selector keys', async () => {
        const create = vi.fn(async () => ({ sessionId: 'child' }))
        const navigate = vi.fn().mockRejectedValue(new Error('route failed'))
        const fork = createForkNavigator(create, navigate)
        const nativeBoundary = { threadId: 'thread', turnId: 'turn', itemId: 'item' }
        await expect(fork()).rejects.toThrow('route failed')
        await expect(fork('current')).rejects.toThrow('route failed')
        await expect(fork(nativeBoundary)).rejects.toThrow('route failed')
        await expect(fork(JSON.stringify(['native', 'thread', 'turn', 'item']))).rejects.toThrow('route failed')
        expect(create).toHaveBeenCalledTimes(4)
    })

    it('reuses the confirmed child when only navigation fails', async () => {
        const create = vi.fn(async () => ({ sessionId: 'child' }))
        const navigate = vi.fn().mockRejectedValueOnce(new Error('route failed')).mockResolvedValue(undefined)
        const fork = createForkNavigator(create, navigate)
        await expect(fork('boundary')).rejects.toThrow('route failed')
        await fork('boundary')
        expect(create).toHaveBeenCalledTimes(1)
        expect(navigate.mock.calls).toEqual([['child'], ['child']])
    })
    it('coalesces rapid confirmations and does not automatically retry a failed create', async () => {
        let reject!: (error: Error) => void
        const create = vi.fn(() => new Promise<{ sessionId: string }>((_, fail) => { reject = fail }))
        const navigate = vi.fn(async () => {})
        const fork = createForkNavigator(create, navigate)
        const first = fork('boundary')
        expect(fork('boundary')).toBe(first)
        reject(new Error('offline'))
        await expect(first).rejects.toThrow('offline')
        expect(create).toHaveBeenCalledTimes(1)
        expect(navigate).not.toHaveBeenCalled()
    })
})
