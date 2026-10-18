import { describe, expect, it } from 'bun:test'
import { normalizeCorsOrigin, normalizeCorsOrigins } from './corsOrigins'

describe('configured CORS origins', () => {
    it('preserves an explicitly configured iOS WebView origin across repeated normalization', () => {
        const origins = normalizeCorsOrigins([
            ' capacitor://localhost ',
            'https://localhost',
            'https://APP.EXAMPLE:443/web/',
            'https://app.example',
        ])
        expect(origins).toEqual(['capacitor://localhost', 'https://localhost', 'https://app.example'])
        expect(normalizeCorsOrigins(origins)).toEqual(origins)
    })

    it('does not add mobile origins to an ordinary web allowlist', () => {
        expect(normalizeCorsOrigins(['https://app.example'])).toEqual(['https://app.example'])
        expect(normalizeCorsOrigins([])).toEqual([])
    })

    it.each([
        'null',
        ' null ',
        'file:///tmp/document.html',
        'data:text/html,hello',
        'capacitor://untrusted.example',
        'capacitor://localhost.untrusted.example',
        'capacitor://localhost:1234',
        'capacitor://user:password@localhost',
    ])('never converts %s into an allowed opaque origin', (value) => {
        expect(normalizeCorsOrigin(value)).toBe('')
    })

    it('preserves an explicitly configured wildcard', () => {
        expect(normalizeCorsOrigins(['https://app.example', ' * '])).toEqual(['*'])
    })
})
