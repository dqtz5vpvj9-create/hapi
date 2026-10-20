import { describe, expect, it } from 'vitest'
import { codexKeyProfileMetadata, readCodexKeyProfiles, resolveCodexKeyProfile } from './codexKeyProfiles'

describe('codex key profiles', () => {
    it('parses env profiles and never exposes secrets in metadata', () => {
        const env = {
            HAPI_CODEX_KEY_PROFILES: JSON.stringify([
                { id: 'a', label: 'Key A', homeId: 'ipads', env: { IPADS_API_KEY: 'secret-a' } },
                { id: 'a', label: 'duplicate', env: { IPADS_API_KEY: 'duplicate' } },
                { id: 'b', label: 'Key B', env: { IPADS_API_KEY: 'secret-b' } }
            ])
        }
        expect(readCodexKeyProfiles(env).map(profile => profile.id)).toEqual(['a', 'b'])
        expect(codexKeyProfileMetadata(env)).toEqual([
            { id: 'a', label: 'Key A', homeId: 'ipads' },
            { id: 'b', label: 'Key B' }
        ])
        expect(JSON.stringify(codexKeyProfileMetadata(env))).not.toContain('secret')
    })

    it('resolves a profile and rejects an unknown id', () => {
        const env = { HAPI_CODEX_KEY_PROFILES: JSON.stringify([{ id: 'a', label: 'A', env: { IPADS_API_KEY: 'x' } }]) }
        expect(resolveCodexKeyProfile('a', env).env.IPADS_API_KEY).toBe('x')
        expect(() => resolveCodexKeyProfile('missing', env)).toThrow('Unknown Codex key profile')
    })
})
