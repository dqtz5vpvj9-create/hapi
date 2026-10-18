import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect } from '@playwright/test'

// Reuse the installed CLI transport and the artifact runner's real Hub. This
// drives its public boundaries; it does not reimplement Store, SSE, or the UI.
const { io } = createRequire(new URL('../../cli/package.json', import.meta.url))('socket.io-client')
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function forwardingLink(origin) {
    let offline = false
    const sockets = new Set()
    const upstreamOrigin = new URL(origin)
    const server = createServer((request, response) => {
        if (offline) { request.socket.destroy(); return }
        const pathname = new URL(request.url, 'http://cohort.invalid')
        const upstream = httpRequest({ hostname: upstreamOrigin.hostname, port: upstreamOrigin.port,
            path: pathname.pathname + pathname.search, method: request.method, headers: { ...request.headers, host: upstreamOrigin.host } }, forwarded => {
            response.writeHead(forwarded.statusCode, forwarded.headers)
            forwarded.pipe(response)
        })
        upstream.on('error', () => response.destroy())
        response.on('close', () => upstream.destroy())
        request.pipe(upstream)
    })
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    return {
        origin: `http://127.0.0.1:${server.address().port}`,
        setOffline(value) {
            offline = value
            // Chromium's offline emulation alone can leave an established SSE
            // stream alive. This owned forwarding link closes actual sockets;
            // every byte before and after the outage still comes from the Hub.
            if (offline) for (const socket of sockets) socket.destroy()
        },
        async close() {
            for (const socket of sockets) socket.destroy()
            await new Promise(resolve => server.close(resolve))
        },
    }
}

async function eventually(read, accept, description) {
    const deadline = Date.now() + 15_000
    let value
    while (Date.now() < deadline) {
        value = await read()
        if (accept(value)) return value
        await delay(25)
    }
    throw new Error(`Timed out: ${description}; last value: ${JSON.stringify(value)}`)
}

export async function runRealtimeCohort({ browser, origin, token, output }) {
    const sockets = [], clients = [], links = []
    const report = {
        success: false, browser: browser.version(), sessions: [], cycles: [],
        boundary: 'Real compiled Hub, SQLite, Socket.IO, REST, SSE and browser; authored Codex-compatible stored messages, no native Runner or model.',
        timingScope: 'Single-run observations including this harness; not a before/after speedup, physical-device, or native-subagent benchmark.',
    }
    const cliHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const json = async (pathname, options = {}) => {
        const response = await fetch(new URL(pathname, origin), { ...options, signal: AbortSignal.timeout(10_000) })
        assert.equal(response.status, 200, `${options.method ?? 'GET'} ${pathname} failed (${response.status}).`)
        return response.json()
    }
    const authentication = await json('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: token }) })
    const webHeaders = { Authorization: `Bearer ${authentication.token}` }
    const messages = session => json(`/api/sessions/${session.id}/messages?limit=200`, { headers: webHeaders })
    const streamId = (session, cycle) => `codex:${session.id}:${cycle}:answer:agent_message`
    const text = (session, cycle, phase) => `Cohort ${session.label} ${cycle} ${phase}`
    const emit = (session, cycle, phase, live) => {
        const id = streamId(session, cycle)
        session.socket.emit('message', {
            sid: session.id, ...(live ? {} : { localId: id }),
            message: { role: 'agent', content: { type: 'codex', data: { type: 'message', id, message: text(session, cycle, phase), ...(live ? { streamSnapshot: true } : {}) } } },
        })
    }
    async function createSession(label, accessToken = token) {
        const headers = { ...cliHeaders, Authorization: `Bearer ${accessToken}` }
        const created = await json('/cli/sessions', { method: 'POST', headers, body: JSON.stringify({
            tag: `realtime-cohort-${label}`, metadata: { name: `Cohort ${label}`, path: `/cohort/${label}`, host: 'isolated-cohort', flavor: 'codex' }, agentState: {},
        }) })
        const session = { id: created.session.id, label }
        const socket = session.socket = io(`${origin}/cli`, { path: '/socket.io/', transports: ['websocket'], autoConnect: false,
            reconnection: false, auth: { token: accessToken, clientType: 'session-scoped', sessionId: session.id } })
        sockets.push(socket)
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('CLI socket connection timed out.')), 10_000)
            socket.once('connect', () => { clearTimeout(timeout); resolve() })
            socket.once('connect_error', error => { clearTimeout(timeout); reject(error) })
            socket.connect()
        })
        socket.emit('session-alive', { sid: session.id, time: Date.now(), thinking: true })
        emit(session, 'seed', 'final', false)
        await eventually(() => json(`/cli/sessions/${session.id}/messages?afterSeq=0`, { headers }),
            data => data.messages.some(row => row.content?.content?.data?.message === text(session, 'seed', 'final')), 'seed persisted through actual CLI transport')
        return session
    }
    async function browserClient(session) {
        const link = await forwardingLink(origin)
        links.push(link)
        const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, locale: 'en-US', serviceWorkers: 'block' })
        const client = { context, link, session, events: [], requests: [], failures: [], errors: [] }
        clients.push(client)
        await context.addInitScript(() => {
            window.__cohortLongTasks = []
            new PerformanceObserver(list => {
                for (const entry of list.getEntries()) window.__cohortLongTasks.push({ start: entry.startTime, duration: entry.duration })
            }).observe({ type: 'longtask', buffered: true })
        })
        const page = client.page = await context.newPage()
        page.setDefaultTimeout(15_000)
        const cdp = await context.newCDPSession(page)
        await cdp.send('Network.enable')
        const streams = new Map()
        cdp.on('Network.requestWillBeSent', event => {
            const url = new URL(event.request.url)
            if (url.pathname === '/api/events') {
                const ids = JSON.parse(url.searchParams.get('sessionIds') ?? '[]')
                const body = url.searchParams.get('messageMode') !== 'notify'
                    && (url.searchParams.get('sessionId') === session.id || ids.includes(session.id))
                streams.set(event.requestId, { body, mode: url.searchParams.get('messageMode') ?? 'full', all: url.searchParams.get('all') === 'true' })
            }
        })
        cdp.on('Network.eventSourceMessageReceived', event => {
            const stream = streams.get(event.requestId)
            if (!stream) return
            const data = JSON.parse(event.data)
            client.events.push({ body: stream.body, mode: stream.mode, all: stream.all, type: data.type, sessionId: data.sessionId,
                resume: data.type === 'connection-changed' ? data.data?.resume : undefined,
                hasMessage: Boolean(data.message), bytes: Buffer.byteLength(event.data), eventId: event.eventId })
        })
        cdp.on('Network.loadingFailed', event => {
            if (streams.get(event.requestId)?.body) client.failures.push(event.errorText)
        })
        page.on('pageerror', error => client.errors.push(error.message))
        page.on('request', request => {
            const url = new URL(request.url())
            if (url.pathname.startsWith('/api/')) client.requests.push({ method: request.method(), path: url.pathname })
        })
        await page.goto(link.origin, { waitUntil: 'domcontentloaded' })
        await page.getByPlaceholder('Access token', { exact: true }).fill(token)
        await page.getByRole('button', { name: 'Sign In', exact: true }).click()
        await expect(page.getByPlaceholder('Access token', { exact: true })).toHaveCount(0)
        await page.goto(`${link.origin}/sessions/${session.id}`, { waitUntil: 'domcontentloaded' })
        await expect(page.getByText(text(session, 'seed', 'final'), { exact: true })).toBeVisible()
        await eventually(() => client.events.filter(event => event.body && event.type === 'connection-changed'), events => events.length > 0, 'real browser body SSE handshake')
        return client
    }
    try {
        for (const label of ['A', 'B', 'C']) report.sessions.push(await createSession(label))
        const foreignSession = await createSession('PRIVATE', `${token}:cohort-other`)
        const online = await browserClient(report.sessions[0])
        const reconnecting = await browserClient(report.sessions[1])
        // The production global subscription is intentionally full because
        // workspace/recent-history consumers use its bodies. Exercise the
        // separate notify contract explicitly, without changing that behavior.
        await online.page.evaluate(token => {
            const query = new URLSearchParams({ all: 'true', messageMode: 'notify', token })
            window.__cohortNotify = new EventSource(`/api/events?${query}`)
        }, authentication.token)
        await eventually(() => online.events.filter(event => event.mode === 'notify' && event.type === 'connection-changed'), events => events.length > 0, 'explicit notify SSE handshake')
        const forbidden = await reconnecting.page.evaluate(async ({ id, token }) => {
            const paths = [`/api/sessions/${id}/messages`, `/api/events?sessionId=${id}&token=${encodeURIComponent(token)}`]
            return Promise.all(paths.map(async path => {
                const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` } })
                return { status: response.status, body: await response.text() }
            }))
        }, { id: foreignSession.id, token: authentication.token })
        assert.ok(forbidden.every(response => response.status === 403 && !response.body.includes('Cohort PRIVATE')), 'REST and SSE must reject another namespace without exposing its body.')
        report.foreignNamespace = { directRestStatus: forbidden[0].status, directSseStatus: forbidden[1].status }
        // Eight rounds fit the production replay ring. Ninety-six rounds over
        // three sessions exceed its 256-event capacity; the observed server
        // verdict, not the round count, proves which recovery path ran.
        for (const cycle of [{ name: 'replay', rounds: 8, resume: 'ok' }, { name: 'overflow', rounds: 96, resume: 'gap' }]) {
            for (const session of [...report.sessions, foreignSession]) emit(session, cycle.name, 'live 0', true)
            for (const client of clients) await expect(client.page.getByText(text(client.session, cycle.name, 'live 0'), { exact: true })).toBeVisible()
            const cursor = reconnecting.events.filter(event => event.body && event.eventId).at(-1)?.eventId
            assert.ok(cursor, 'The disconnected browser must have received a real replay cursor.')
            const failures = reconnecting.failures.length
            await reconnecting.context.setOffline(true)
            reconnecting.link.setOffline(true)
            await eventually(() => reconnecting.failures.length, count => count > failures, 'browser observed its body SSE disconnect')
            const eventStart = reconnecting.events.length, requestStart = reconnecting.requests.length
            const emittedAt = performance.now()
            for (let index = 1; index <= cycle.rounds; index++) {
                for (const session of [...report.sessions, foreignSession]) emit(session, cycle.name, `live ${index}`, true)
                await delay(10)
            }
            for (const session of [...report.sessions, foreignSession]) {
                emit(session, cycle.name, 'final', false)
                emit(session, cycle.name, 'late partial must not win', true)
                emit(session, cycle.name, 'final', false)
            }
            await expect(online.page.getByText(text(online.session, cycle.name, 'final'), { exact: true })).toHaveCount(1)
            const onlineVisibleAfterMs = performance.now() - emittedAt
            await expect(reconnecting.page.getByText(text(reconnecting.session, cycle.name, 'final'), { exact: true })).toHaveCount(0)
            await expect(reconnecting.page.getByText(text(reconnecting.session, cycle.name, 'live 0'), { exact: true })).toBeVisible()
            for (const session of report.sessions) {
                const page = await eventually(() => messages(session), data => data.messages.some(row => row.content?.content?.data?.message === text(session, cycle.name, 'final')), 'stream settled in real SQLite history')
                const rows = page.messages.filter(row => row.content?.content?.data?.id === streamId(session, cycle.name))
                assert.equal(rows.length, 1, 'Snapshots, completion, late replay and duplicate completion must retain one canonical row.')
                assert.equal(rows[0].content.content.data.message, text(session, cycle.name, 'final'))
                assert.ok(page.messages.every(row => !String(row.content?.content?.data?.message ?? '').startsWith('Cohort ') || row.content.content.data.message.startsWith(`Cohort ${session.label} `)), 'Stored bytes must stay in their owning session.')
            }
            const resumedAt = performance.now()
            reconnecting.link.setOffline(false)
            await reconnecting.context.setOffline(false)
            const handshakes = await eventually(() => reconnecting.events.slice(eventStart).filter(event => event.body && event.type === 'connection-changed'), events => events.length > 0, 'browser reconnect handshake')
            assert.equal(handshakes[0].resume, cycle.resume, `The ${cycle.name} cohort must exercise its intended recovery path.`)
            await expect(reconnecting.page.getByText(text(reconnecting.session, cycle.name, 'final'), { exact: true })).toHaveCount(1)
            const recoveredAfterMs = performance.now() - resumedAt
            const historyReads = reconnecting.requests.slice(requestStart).filter(request => request.method === 'GET' && request.path === `/api/sessions/${reconnecting.session.id}/messages`).length
            if (cycle.resume === 'gap') assert.ok(historyReads > 0, 'An overflow gap must recover authoritative history through REST.')
            for (const client of clients) {
                for (const session of report.sessions.filter(session => session.id !== client.session.id)) {
                    await expect(client.page.getByText(text(session, cycle.name, 'final'), { exact: true })).toHaveCount(0)
                }
            }
            report.cycles.push({ name: cycle.name, snapshotsPerSession: cycle.rounds + 1, sessionCount: report.sessions.length, foreignNamespaceSessionCount: 1,
                observedResume: handshakes[0].resume, onlineVisibleAfterMs, recoveredAfterMs, recoveryHistoryReads: historyReads, canonicalRowsPerStream: 1 })
        }
        report.clients = []
        assert.ok(online.events.some(event => event.mode === 'notify' && event.type === 'message-updated'), 'The notify assertion must observe real message notifications.')
        report.foreignNamespace.leakedEvents = clients.reduce((count, client) => count + client.events.filter(event => event.sessionId === foreignSession.id).length, 0)
        assert.equal(report.foreignNamespace.leakedEvents, 0, 'No stream, including all:true, may cross its authenticated namespace.')
        for (const client of clients) {
            assert.deepEqual(client.errors, [], 'The actual app must not throw during reconnect recovery.')
            assert.ok(client.events.filter(event => event.body && event.hasMessage).every(event => event.sessionId === client.session.id), 'Full SSE payloads must stay inside the requested session.')
            assert.ok(client.events.filter(event => event.mode === 'notify').every(event => !event.hasMessage), 'An explicitly requested notify stream must not carry message bodies.')
            await expect(client.page.getByText(/Cohort PRIVATE (?:seed|replay|overflow)/)).toHaveCount(0)
            assert.equal(client.requests.filter(request => request.method !== 'GET' && /\/messages(?:\/|$)/.test(request.path)).length, 0, 'Reading and reconnecting must not send chat messages.')
            const longTasks = await client.page.evaluate(() => window.__cohortLongTasks)
            report.clients.push({ session: client.session.label, bodyEvents: client.events.filter(event => event.body).length,
                allStreams: ['full', 'notify'].map(mode => ({ mode, events: client.events.filter(event => event.all && event.mode === mode).length,
                    decodedJsonBytes: client.events.filter(event => event.all && event.mode === mode).reduce((sum, event) => sum + event.bytes, 0),
                    messageBodies: client.events.filter(event => event.all && event.mode === mode && event.hasMessage).length })),
                longTasks: { count: longTasks.length, totalMs: longTasks.reduce((sum, task) => sum + task.duration, 0), maxMs: Math.max(0, ...longTasks.map(task => task.duration)) } })
        }
        await reconnecting.page.screenshot({ path: path.join(output, 'realtime-recovered.png') })
        report.success = true
        return report
    } catch (error) {
        report.failure = String(error)
        report.diagnostics = clients.map(client => ({ session: client.session.label, errors: client.errors,
            disconnects: client.failures, recentEvents: client.events.slice(-40), recentRequests: client.requests.slice(-40) }))
        for (const [index, client] of clients.entries()) await client.page?.screenshot({ path: path.join(output, `realtime-failure-${index}.png`) }).catch(() => {})
        throw error
    } finally {
        for (const socket of sockets) socket.disconnect()
        await Promise.all(clients.map(client => client.context.close()))
        await Promise.all(links.map(link => link.close()))
        // Socket objects contain credentials and cycles; receipts identify the
        // authored session labels only, never transports or auth material.
        report.sessions = report.sessions.map(session => ({ id: session.id, label: session.label }))
        await writeFile(path.join(output, 'realtime-cohort.json'), `${JSON.stringify(report, null, 2)}\n`)
    }
}
