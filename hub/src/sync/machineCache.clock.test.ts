import { describe, expect, it, spyOn } from 'bun:test'
import type { SSEManager } from '../sse/sseManager'
import { Store } from '../store'
import { EventPublisher } from './eventPublisher'
import { MachineCache } from './machineCache'

describe('machine heartbeat clock skew', () => {
    it('keeps a slow-clock Runner online for 45 seconds after each received heartbeat', () => {
        const now = 1_791_456_000_000
        const clock = spyOn(Date, 'now').mockReturnValue(now - 60_000)
        const store = new Store(':memory:')
        try {
            store.machines.getOrCreateMachine('windows', null, null, 'ns')
            const publisher = new EventPublisher({ broadcast: () => {} } as unknown as SSEManager, () => 'ns')
            const cache = new MachineCache(store, publisher)
            cache.reloadAll()

            clock.mockReturnValue(now)
            cache.handleMachineAlive({ machineId: 'windows', time: now - 17_000 })
            cache.expireInactive(now + 28_001)
            expect(cache.getMachine('windows')?.active).toBe(true)
            expect(cache.getMachine('windows')?.activeAt).toBe(now)

            // The real Runner sends heartbeats every 20 seconds. The next
            // receipt renews the entire lease, even with the same clock skew.
            clock.mockReturnValue(now + 20_000)
            cache.handleMachineAlive({ machineId: 'windows', time: now + 3_000 })
            cache.expireInactive(now + 64_999)
            expect(cache.getMachine('windows')?.active).toBe(true)
            cache.expireInactive(now + 65_001)
            expect(cache.getMachine('windows')?.active).toBe(false)
        } finally {
            store.close()
            clock.mockRestore()
        }
    })

    it('keeps the existing timestamp validation and does not revive an expired machine with invalid input', () => {
        const now = 1_791_456_000_000
        const clock = spyOn(Date, 'now').mockReturnValue(now - 60_000)
        const store = new Store(':memory:')
        try {
            store.machines.getOrCreateMachine('windows', null, null, 'ns')
            const publisher = new EventPublisher({ broadcast: () => {} } as unknown as SSEManager, () => 'ns')
            const cache = new MachineCache(store, publisher)
            cache.reloadAll()
            clock.mockReturnValue(now)
            cache.expireInactive(now)

            for (const time of [NaN, Infinity, now - 601_000]) {
                cache.handleMachineAlive({ machineId: 'windows', time })
                expect(cache.getMachine('windows')?.active).toBe(false)
            }

            cache.handleMachineAlive({ machineId: 'windows', time: now + 17_000 })
            cache.expireInactive(now + 45_001)
            expect(cache.getMachine('windows')?.active).toBe(false)
        } finally {
            store.close()
            clock.mockRestore()
        }
    })
})
