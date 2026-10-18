import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { SignJWT } from 'jose'
import { createConfiguration } from '../configuration'
import { normalizeCorsOrigins } from '../config/corsOrigins'
import { Store } from '../store'
import { createSocketServer } from '../socket/server'
import { createWebApp } from './server'

// Exercise the actual REST/SSE middleware and the Engine.IO transport shared
// by /terminal and /cli. Polling requests need no listening TCP server.
describe('native WebView CORS across hub transports', () => {
    const secret = new Uint8Array(32).fill(7)
    let store: Store
    let sockets: ReturnType<typeof createSocketServer>
    let app: ReturnType<typeof createWebApp>

    beforeAll(async () => {
        await createConfiguration()
    })

    beforeEach(() => {
        store = new Store(':memory:')
        const corsOrigins = normalizeCorsOrigins([
            'https://app.example',
            'capacitor://localhost',
            'https://localhost',
        ])
        sockets = createSocketServer({ store, jwtSecret: secret, corsOrigins })
        app = createWebApp({
            getSyncEngine: () => null,
            getSseManager: () => null,
            getVisibilityTracker: () => null,
            jwtSecret: secret,
            store,
            vapidPublicKey: '',
            corsOrigins,
            embeddedAssetMap: null,
        })
    })

    afterEach(async () => {
        await sockets.io.close()
        store.close()
    })

    function transportRequest(origin: string | undefined, options: { sid?: string; body?: string } = {}) {
        const query = new URLSearchParams({ EIO: '4', transport: 'polling' })
        if (options.sid) query.set('sid', options.sid)
        const headers = new Headers()
        if (origin) headers.set('Origin', origin)
        if (options.body) headers.set('Content-Type', 'text/plain;charset=UTF-8')
        return sockets.engine.handleRequest(new Request(`http://hub.test/socket.io/?${query}`, {
            method: options.body ? 'POST' : 'GET',
            headers,
            body: options.body,
        }), {} as never)
    }

    it.each(['capacitor://localhost', 'https://localhost'])('allows %s preflight and preserves API authentication', async (origin) => {
        const preflight = await app.request('/api/auth', {
            method: 'OPTIONS',
            headers: {
                Origin: origin,
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'authorization,content-type',
            },
        })
        expect(preflight.status).toBe(204)
        expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(origin)
        expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('authorization')

        for (const path of ['/api/sessions', '/api/events']) {
            const response = await app.request(path, { headers: { Origin: origin } })
            expect(response.status).toBe(401)
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin)
        }
    })

    it.each(['null', 'capacitor://untrusted.example', 'https://localhost.untrusted.example'])('denies %s for HTTP reads and socket handshakes', async (origin) => {
        const response = await app.request('/health', { headers: { Origin: origin } })
        expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()

        const polling = await transportRequest(origin)
        expect(polling.status).toBe(403)
        // Bun Engine serializes an unmatched allowlist as "false"; it grants
        // no browser origin, and allowRequest still rejects the handshake.
        expect(polling.headers.get('Access-Control-Allow-Origin')).toBe('false')

        const websocket = await sockets.engine.handleRequest(new Request('http://hub.test/socket.io/?EIO=4&transport=websocket', {
            headers: { Origin: origin, Upgrade: 'websocket' },
        }), {} as never)
        expect(websocket.status).toBe(403)
    })

    it.each(['capacitor://localhost', 'https://localhost'])('authenticates /terminal for %s without altering its JWT requirement', async (origin) => {
        const handshake = await transportRequest(origin)
        expect(handshake.status).toBe(200)
        expect(handshake.headers.get('Access-Control-Allow-Origin')).toBe(origin)
        const open = await handshake.text()
        expect(open.startsWith('0')).toBe(true)
        const { sid } = JSON.parse(open.slice(1)) as { sid: string }
        const token = await new SignJWT({ uid: 1, ns: 'default' })
            .setProtectedHeader({ alg: 'HS256' })
            .setExpirationTime('1m')
            .sign(secret)
        await transportRequest(origin, { sid, body: `40/terminal,${JSON.stringify({ token })}` })
        const connected = await transportRequest(origin, { sid })
        expect(await connected.text()).toStartWith('40/terminal,')

        const unauthorized = await transportRequest(origin)
        const rejectedSid = (JSON.parse((await unauthorized.text()).slice(1)) as { sid: string }).sid
        await transportRequest(origin, { sid: rejectedSid, body: '40/terminal,{"token":"invalid-token"}' })
        const rejected = await transportRequest(origin, { sid: rejectedSid })
        expect(await rejected.text()).toBe('44/terminal,{"message":"Invalid token"}')
    })

    it('keeps native clients without an Origin header able to reach the authenticated transport', async () => {
        const response = await transportRequest(undefined)
        expect(response.status).toBe(200)
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('false')
    })
})
