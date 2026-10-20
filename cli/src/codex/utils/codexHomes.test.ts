import { describe, expect, it } from 'vitest'
import { codexHomesForMachine, readCodexHomes } from './codexHomes'

describe('codex home presets', () => {
    it('parses an explicit allowlist and drops duplicates or incomplete entries', () => {
        const homes = readCodexHomes({
            HAPI_CODEX_HOMES: JSON.stringify([
                { id: 'ipads', label: 'IPADS', path: '/home/me/.codex-ipads' },
                { id: 'ipads', label: 'duplicate', path: '/tmp/other' },
                { id: '', label: 'missing', path: '/tmp/x' }
            ])
        })
        expect(homes).toEqual([{ id: 'ipads', label: 'IPADS', path: '/home/me/.codex-ipads' }])
    })

    it('falls back to one official default home', () => {
        const homes = codexHomesForMachine({ CODEX_HOME: '/home/me/.codex' })
        expect(homes[0]).toMatchObject({ id: 'default', path: '/home/me/.codex', official: true })
    })

    it('keeps an explicitly registered official home without adding another', () => {
        const homes = codexHomesForMachine({
            HAPI_CODEX_HOMES: JSON.stringify([{ id: 'main', label: 'Main', path: '/home/me/.codex', official: true }])
        })
        expect(homes.map(home => home.id)).toEqual(['main'])
    })
})
