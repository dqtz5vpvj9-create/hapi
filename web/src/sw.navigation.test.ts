import { beforeAll, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({ route: vi.fn(), precache: vi.fn(), cached: vi.fn(), navigation: vi.fn() }))
vi.mock('workbox-routing', () => ({ registerRoute: hooks.route }))
vi.mock('workbox-precaching', () => ({ precacheAndRoute: hooks.precache, matchPrecache: hooks.cached }))
vi.mock('workbox-strategies', () => ({
    NetworkFirst: class { handle = hooks.navigation },
    CacheFirst: class {},
}))
vi.mock('workbox-expiration', () => ({ ExpirationPlugin: class {} }))

beforeAll(async () => { await import('./sw') })

describe('PWA launch navigation', () => {
    it('matches the installed entry before precache without intercepting APIs or assets', () => {
        expect(hooks.route.mock.invocationCallOrder[0]).toBeLessThan(hooks.precache.mock.invocationCallOrder[0])
        const matches = hooks.route.mock.calls[0][0]
        const check = (path: string, mode = 'navigate') => matches({ request: { mode }, url: new URL(path, location.origin) })
        expect(check('/')).toBe(true)
        expect(check('/index.html')).toBe(true)
        expect(check('/api/sessions')).toBe(false)
        expect(check('/assets/index.js')).toBe(false)
        expect(check('/', 'cors')).toBe(false)
        expect(matches({ request: { mode: 'navigate' }, url: new URL('https://external.example/') })).toBe(false)
    })

    it('uses the current network entry for online launches and refreshes', async () => {
        const current = new Response('current build')
        hooks.navigation.mockResolvedValueOnce(current)
        const handler = hooks.route.mock.calls[0][1]
        const result = await handler({ request: new Request(location.origin), event: {} })
        expect(result).toBe(current)
        expect(hooks.navigation.mock.calls[0][0].request.cache).toBe('no-cache')
        expect(hooks.cached).not.toHaveBeenCalled()
    })

    it('falls back to the installed entry when offline with no newer navigation cached', async () => {
        hooks.navigation.mockRejectedValueOnce(new Error('offline'))
        hooks.cached.mockResolvedValueOnce(new Response('offline build'))
        const handler = hooks.route.mock.calls[0][1]
        const response = await handler({ request: new Request(location.origin), event: {} })
        expect(await response.text()).toBe('offline build')
        expect(hooks.cached).toHaveBeenCalledWith('/index.html')
    })
})
