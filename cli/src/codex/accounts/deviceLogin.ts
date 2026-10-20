import { randomUUID } from 'node:crypto'
import type { CodexDeviceLogin } from '@hapi/protocol/apiTypes'
import { saveCodexAccountAuth } from './accountManager'

const issuer = 'https://auth.openai.com'
const clientId = 'app_EMoamEEZ73f0CkXaXp7hrann'
type Attempt = { view: CodexDeviceLogin; abort: AbortController }
const attempts = new Map<string, Attempt>()

async function post(path: string, body: object | URLSearchParams, signal: AbortSignal) {
    return fetch(`${issuer}${path}`, {
        method: 'POST',
        headers: { 'content-type': body instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : 'application/json' },
        body: body instanceof URLSearchParams ? body : JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    })
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(new Error('Cancelled')) }
        const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, ms)
        signal.addEventListener('abort', cancel, { once: true })
        if (signal.aborted) cancel()
    })
}
async function complete(attempt: Attempt, deviceId: string, interval: number, label?: string) {
    const { view, abort } = attempt
    try {
        while (!abort.signal.aborted) {
            if (Date.now() >= view.expiresAt) { view.status = 'expired'; return }
            const response = await post('/api/accounts/deviceauth/token', { device_auth_id: deviceId, user_code: view.userCode }, abort.signal)
            if (response.status === 403 || response.status === 404) {
                await delay(Math.min(interval, Math.max(0, view.expiresAt - Date.now())), abort.signal)
                continue
            }
            if (!response.ok) throw new Error(`Device authorization failed (${response.status})`)
            const code = await response.json() as { authorization_code: string; code_verifier: string }
            if (!code.authorization_code || !code.code_verifier) throw new Error('Invalid device authorization response')
            const tokensResponse = await post('/oauth/token', new URLSearchParams({
                grant_type: 'authorization_code', client_id: clientId,
                code: code.authorization_code, code_verifier: code.code_verifier,
                redirect_uri: `${issuer}/deviceauth/callback`,
            }), abort.signal)
            if (!tokensResponse.ok) throw new Error(`Device token exchange failed (${tokensResponse.status})`)
            const tokens = await tokensResponse.json() as Record<string, unknown>
            if (abort.signal.aborted) return
            view.account = await saveCodexAccountAuth({ auth_mode: 'chatgpt', tokens, last_refresh: new Date().toISOString() }, label)
            view.status = 'completed'
            return
        }
    } catch (error) {
        if (!abort.signal.aborted) {
            view.status = 'error'
            view.error = error instanceof Error ? error.message : 'Device login failed'
        }
    }
}
export async function startCodexDeviceLogin(label?: string): Promise<CodexDeviceLogin> {
    const abort = new AbortController()
    const response = await post('/api/accounts/deviceauth/usercode', { client_id: clientId }, abort.signal)
    if (!response.ok) throw new Error(`Device code request failed (${response.status})`)
    const payload = await response.json() as { device_auth_id: string; user_code?: string; usercode?: string; interval?: string | number }
    const userCode = payload.user_code ?? payload.usercode
    if (!payload.device_auth_id || !userCode) throw new Error('Invalid device code response')
    const view: CodexDeviceLogin = { id: randomUUID(), userCode, verificationUrl: `${issuer}/codex/device`, expiresAt: Date.now() + 900_000, status: 'pending' }
    const attempt = { view, abort }
    attempts.set(view.id, attempt)
    const cleanup = setTimeout(() => { abort.abort(); attempts.delete(view.id) }, 960_000)
    cleanup.unref()
    void complete(attempt, payload.device_auth_id, Math.max(1, Number(payload.interval) || 5) * 1000, label)
    return { ...view }
}
export function getCodexDeviceLogin(id: string): CodexDeviceLogin {
    const attempt = attempts.get(id)
    if (!attempt) throw new Error('Device login expired or runner restarted. Start again.')
    return { ...attempt.view }
}
export function cancelCodexDeviceLogin(id: string): CodexDeviceLogin {
    const attempt = attempts.get(id)
    if (!attempt) throw new Error('Device login not found')
    if (attempt.view.status === 'pending') { attempt.view.status = 'cancelled'; attempt.abort.abort() }
    return { ...attempt.view }
}
