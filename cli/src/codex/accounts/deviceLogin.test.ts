import { afterEach, describe, expect, it, vi } from 'vitest'
import { startCodexDeviceLogin, getCodexDeviceLogin, cancelCodexDeviceLogin } from './deviceLogin'
import { saveCodexAccountAuth } from './accountManager'
vi.mock('./accountManager', () => ({ saveCodexAccountAuth: vi.fn(async () => ({ id: 'saved', label: 'Test' })) }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers() })
describe('device login', () => {
    it('exchanges authorization privately and returns only account metadata', async () => {
        const fetcher = vi.fn()
            .mockResolvedValueOnce(Response.json({ device_auth_id: 'private-device', user_code: 'ABCD', interval: '5' }))
            .mockResolvedValueOnce(Response.json({ authorization_code: 'private-code', code_verifier: 'private-verifier' }))
            .mockResolvedValueOnce(Response.json({ access_token: 'secret-access', refresh_token: 'secret-refresh', id_token: 'secret-id' }))
        vi.stubGlobal('fetch', fetcher)
        const started = await startCodexDeviceLogin('Test')
        await vi.waitFor(() => expect(getCodexDeviceLogin(started.id).status).toBe('completed'))
        expect(saveCodexAccountAuth).toHaveBeenCalledWith(expect.objectContaining({ tokens: expect.objectContaining({ refresh_token: 'secret-refresh' }) }), 'Test')
        expect(JSON.stringify(getCodexDeviceLogin(started.id))).not.toContain('secret')
        expect(JSON.stringify(started)).not.toContain('private-device')
        expect((fetcher.mock.calls[2][1].body as URLSearchParams).get('code_verifier')).toBe('private-verifier')
    })
    it('cancels without saving credentials', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ device_auth_id: 'd', user_code: 'ABCD', interval: 5 })).mockResolvedValue(new Response('', { status: 403 })))
        const login = await startCodexDeviceLogin()
        expect(cancelCodexDeviceLogin(login.id).status).toBe('cancelled')
        await new Promise(resolve => setTimeout(resolve, 10))
        expect(saveCodexAccountAuth).not.toHaveBeenCalled()
    })
    it('expires pending authorization and stops polling', async () => {
        vi.useFakeTimers()
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ device_auth_id: 'd', user_code: 'ABCD', interval: 5 })).mockResolvedValue(new Response('', { status: 403 })))
        const login = await startCodexDeviceLogin()
        await vi.advanceTimersByTimeAsync(900_000)
        expect(getCodexDeviceLogin(login.id).status).toBe('expired')
        expect(saveCodexAccountAuth).not.toHaveBeenCalled()
    })
    it('reports exchange failure without exposing response secrets', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ device_auth_id: 'd', user_code: 'ABCD' })).mockResolvedValueOnce(Response.json({ authorization_code: 'c', code_verifier: 'v' })).mockResolvedValueOnce(new Response('secret', { status: 401 })))
        const login = await startCodexDeviceLogin()
        await vi.waitFor(() => expect(getCodexDeviceLogin(login.id).status).toBe('error'))
        expect(getCodexDeviceLogin(login.id).error).toContain('401')
        expect(getCodexDeviceLogin(login.id).error).not.toContain('secret')
    })
})
