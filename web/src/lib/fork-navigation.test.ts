import { describe, expect, it, vi } from 'vitest'
import { createForkNavigator } from './fork-navigation'

describe('fork navigation recovery', () => {
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
