import { describe, expect, it, vi } from 'vitest'
import { handleAppNavigation, isAppNavigationRequest } from './swNavigation'

const origin = 'https://hapi.example'
const appRoot = '/'
const matcher = (path: string, mode = 'navigate') => isAppNavigationRequest(
    { request: { mode }, url: new URL(path, origin) }, origin, appRoot,
)

describe('PWA launch navigation', () => {
    it('matches only the installed entry navigation, never APIs or assets', () => {
        expect(matcher('/')).toBe(true)
        expect(matcher('/index.html')).toBe(true)
        expect(matcher('/api/sessions')).toBe(false)
        expect(matcher('/assets/index.js')).toBe(false)
        expect(matcher('/', 'cors')).toBe(false)
        expect(isAppNavigationRequest({ request: { mode: 'navigate' }, url: new URL('https://external.example/') }, origin, appRoot)).toBe(false)
    })

    it('uses the current network entry for online launches and refreshes', async () => {
        const current = new Response('current build')
        const navigation = { handle: vi.fn(async () => current) }
        const cached = vi.fn()
        const result = await handleAppNavigation({ request: new Request(origin) }, navigation, cached, appRoot)
        expect(result).toBe(current)
        expect(navigation.handle.mock.calls[0][0].request.cache).toBe('no-cache')
        expect(cached).not.toHaveBeenCalled()
    })

    it('falls back to the installed entry when offline with no newer navigation cached', async () => {
        const navigation = { handle: vi.fn(async () => { throw new Error('offline') }) }
        const cached = vi.fn(async () => new Response('offline build'))
        const response = await handleAppNavigation({ request: new Request(origin) }, navigation, cached, appRoot)
        expect(await response.text()).toBe('offline build')
        expect(cached).toHaveBeenCalledWith('/index.html')
    })
})
