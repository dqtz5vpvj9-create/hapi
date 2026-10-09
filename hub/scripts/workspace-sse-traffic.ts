// Loopback-only traffic benchmark: production auth, SSE route, filtering and gzip.
// Synthetic messages; no production database, credentials, agents or terminals.
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { Server } from 'socket.io'
import { get as httpGet } from 'node:http'
import { createGunzip } from 'node:zlib'
import { parseArgs } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Store } from '../src/store'
import { RpcRegistry } from '../src/socket/rpcRegistry'
import { SyncEngine, type SyncEvent } from '../src/sync/syncEngine'
import { SSEManager } from '../src/sse/sseManager'
import { VisibilityTracker } from '../src/visibility/visibilityTracker'
import { createEventsRoutes } from '../src/web/routes/events'
import { createAuthMiddleware, type WebAppEnv } from '../src/web/middleware/auth'

const { values } = parseArgs({ options: { output: { type: 'string' } } })
if (!values.output) throw new Error('Provide --output on the cache disk')
const store = new Store(':memory:')
const sessions = Array.from({ length: 20 }, (_, i) => store.sessions.getOrCreateSession(`traffic-${i}`, { path: '/fixture', host: 'fixture' }, null, 'fixture').id)
const visibility = new VisibilityTracker(), manager = new SSEManager(0, visibility), io = new Server()
const engine = new SyncEngine(store, io, new RpcRegistry(), manager)
const secret = crypto.getRandomValues(new Uint8Array(32))
const token = await new SignJWT({ uid: 1, ns: 'fixture' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(secret)
const app = new Hono<WebAppEnv>()
app.use('/api/*', createAuthMiddleware(secret))
app.route('/api', createEventsRoutes(() => manager, () => engine, () => visibility))
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: app.fetch })

function connect(query: URLSearchParams) {
    let ready!: () => void, complete!: () => void, fail!: (error: unknown) => void
    const opened = new Promise<void>(resolve => { ready = resolve })
    const done = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject })
    const stats = { encodedBytes: 0, decodedBytes: 0, bodies: 0, notifications: 0, controls: 0, bodySessions: new Set<string>() }
    const request = httpGet(`http://127.0.0.1:${server.port}/api/events?${query}`, { headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'gzip' } }, response => {
        if (response.statusCode !== 200 || response.headers['content-encoding'] !== 'gzip') {
            fail(new Error(`Unexpected HTTP ${response.statusCode} / ${response.headers['content-encoding']}`)); request.destroy(); return
        }
        response.on('data', chunk => { stats.encodedBytes += chunk.length })
        const plain = response.pipe(createGunzip())
        let buffer = '', finished = false
        plain.on('error', error => { if (!finished) fail(error) })
        plain.on('data', chunk => {
            stats.decodedBytes += chunk.length
            buffer += chunk.toString('utf8')
            for (let boundary = buffer.indexOf('\n\n'); boundary >= 0; boundary = buffer.indexOf('\n\n')) {
                const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
                const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
                if (!data) continue
                const event = JSON.parse(data) as SyncEvent
                if (event.type === 'connection-changed') {
                    if (event.data && typeof event.data === 'object' && 'benchmarkEnd' in event.data) {
                        finished = true; complete(); request.destroy(); plain.destroy(); response.destroy()
                    } else ready()
                }
                if (event.type === 'message-received') { stats.bodies++; stats.bodySessions.add(event.sessionId) }
                if (event.type === 'message-updated') stats.notifications++
                if (event.type === 'messages-consumed') stats.controls++
            }
        })
    })
    request.on('error', fail)
    const timeout = setTimeout(() => { fail(new Error('SSE benchmark timed out')); request.destroy() }, 30000)
    // Observe failures while waiting for the first handshake as well.
    return { ready: Promise.race([opened, done]), done: done.finally(() => clearTimeout(timeout)), stats }
}

try {
    const output = []
    for (const visibleCount of [0, 1, 2, 4]) {
        const global = connect(new URLSearchParams({ all: 'true', ...(visibleCount ? { messageMode: 'notify' } : {}) }))
        const connections = [global]
        if (visibleCount) connections.push(connect(new URLSearchParams({ sessionIds: JSON.stringify(sessions.slice(0, visibleCount)) })))
        await Promise.all(connections.map(c => c.ready))
        const started = performance.now()
        for (let round = 0; round < 20; round++) {
            for (const [index, sessionId] of sessions.entries()) {
                const body = Array.from({ length: 512 }, (_, line) => `const result_${line} = processItem(${index}, ${round}, ${line}); // inspect generated source and retain the session's own result`).join('\n')
                manager.broadcast({ type: 'message-received', sessionId, namespace: 'fixture', message: {
                    id: `answer-${round}`, seq: round + 1, localId: null, createdAt: round + 1, invokedAt: round + 1,
                    content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: body } } }
                } })
            }
        }
        for (const sessionId of sessions) manager.broadcast({ type: 'messages-consumed', sessionId, namespace: 'fixture', localIds: [`queue-${sessionId}`], invokedAt: 21 })
        manager.broadcast({ type: 'connection-changed', data: { benchmarkEnd: true } })
        await Promise.all(connections.map(c => c.done))
        const bodyStream = connections.at(-1)!.stats
        if (bodyStream.bodies !== (visibleCount || 20) * 20) throw new Error('Lost or extra body frames')
        if (global.stats.controls !== 20 || visibleCount && (global.stats.bodies !== 0 || global.stats.notifications !== 400)) throw new Error('Global notification/control mismatch')
        if (visibleCount && [...bodyStream.bodySessions].some(id => !sessions.slice(0, visibleCount).includes(id))) throw new Error('Hidden body received')
        output.push({ mode: visibleCount ? 'scoped' : 'baseline-all', visibleCount: visibleCount || 20,
            elapsedMs: performance.now() - started,
            encodedBytes: connections.reduce((sum, c) => sum + c.stats.encodedBytes, 0),
            decodedBytes: connections.reduce((sum, c) => sum + c.stats.decodedBytes, 0),
            globalBodies: global.stats.bodies, globalNotifications: global.stats.notifications, globalQueueControls: global.stats.controls,
            visibleBodies: visibleCount ? bodyStream.bodies : null })
    }
    await mkdir(dirname(values.output), { recursive: true })
    const report = { at: new Date().toISOString(), sessions: 20, updatesPerSession: 20, samples: output,
        limitations: 'One sequential loopback run per mode, synthetic source snapshots. Raw compressed HTTP body bytes include both connections and handshakes but exclude TCP/TLS headers. Elapsed time includes synthetic generation and is not a production throughput claim.' }
    await writeFile(values.output, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
} finally {
    server.stop(true)
    manager.stop()
    engine.stop()
    // This Socket.IO server has no attached Engine.IO transport to close.
    for (const namespace of io._nsps.values()) await namespace.adapter.close()
    store.close()
}
