import { test, expect, type Page } from '@playwright/test'

// Browser/UI evidence only: the production App, SessionChat, controller and native
// renderer run against a synthetic Hub boundary. No Hub/CLI/native fork executes.
const metrics = new WeakMap<Page, any>()
const riskLabel = 'Create another fork anyway'
const closeLabel = 'Close request if it has not started'
const closeResult = (page: Page) => page.getByTestId('fork-close-result')
const closePosts = (page: Page) => page.evaluate(() => (window as any).__forkJourney.backend.closePosts)
const banner = (page: Page) => page.getByTestId('fork-operation-banner')
const forkPosts = (page: Page) => page.evaluate(() => (window as any).__forkJourney.backend.posts)
const state = (page: Page) => page.evaluate(() => (window as any).__forkJourney.backend)
const route = (page: Page) => page.evaluate(() => (window as any).__workspaceFixture.pathname())

test.beforeEach(async ({ page }) => {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    metrics.set(page, { cdp, initial: await cdp.send('Performance.getMetrics'), escapedApiRequests: [], errors: [] })
    page.on('pageerror', error => metrics.get(page).errors.push(error.message))
    // A missing mock must fail closed instead of reaching a real Hub or model.
    await page.route(url => url.pathname.startsWith('/api/'), async intercepted => {
        metrics.get(page).escapedApiRequests.push(intercepted.request().url())
        await intercepted.abort('blockedbyclient')
    })
})

async function setup(page: Page, mode = 'success', count = 320, blockBytes = 0) {
    await page.addInitScript(({ count, blockBytes, mode }) => {
        localStorage.setItem('hapi-lang', 'en')
        const W = window as any, original = window.fetch.bind(window), createdAt = 1790000000000
        const backend = JSON.parse(sessionStorage.getItem('fork-test-server') ?? 'null') ?? {
            revision: 0, operation: null, operations: {}, requestsById: {}, childHeads: {},
            simulatedDispatches: 0, posts: [], closePosts: [], runtimeAccepted: {}, child: null,
        }
        const q: any = W.__forkJourney = {
            events: [], requests: [], gates: {}, flags: {}, mode, generated: 0, bytes: 0,
            child: backend.child, sourceSession: null, backend, sourceReads: 0,
            stage: (name: string, extra: any = {}) => q.events.push({ name, at: performance.now(), ...extra }),
        }
        q.persist = () => {
            backend.child = q.child
            sessionStorage.setItem('fork-test-server', JSON.stringify(backend))
        }
        const save = (operation: any, head = true) => {
            backend.operations[operation.operationId] = operation
            if (head) backend.operation = operation
            q.persist()
            return operation
        }
        const originalHead = (operationId: string): number => {
            const request = backend.requestsById[operationId]
            if (request?.duplicateRiskOf) return originalHead(request.duplicateRiskOf)
            return request?.nativeBoundary
                ? Number(request.nativeBoundary.itemId.match(/-(\d+)$/)?.[1]) - 1 : count
        }
        q.complete = (operationId: string, binding = 'ready') => {
            const old = backend.operations[operationId]
            if (!old) throw new Error('Mock cannot complete an unadmitted operation')
            if (old.code === 'fork_closed_unadmitted') throw new Error('Mock cannot dispatch a closed request ID')
            if (!backend.runtimeAccepted[operationId]) {
                backend.runtimeAccepted[operationId] = true
                backend.simulatedDispatches++
            }
            const next = { ...old, status: 'created', nativeThreadId: 'native-' + old.childSessionId,
                binding, message: 'Synthetic exact child receipt', updatedAt: Date.now() }
            backend.childHeads[old.childSessionId] = originalHead(operationId)
            q.child = old.childSessionId
            save(next, backend.operation?.operationId === operationId)
            q.stage('mock-operation-completed', { operationId, childSessionId: old.childSessionId })
            return next
        }
        q.publishStaleStorage = (operationId: string, headRevision: number) => {
            const key = Object.keys(localStorage).find(key => key.startsWith('hapi.fork-operation.v1.'))
            if (!key) throw new Error('No saved fork intent to simulate a cross-tab storage event')
            const oldValue = localStorage.getItem(key), current = JSON.parse(oldValue!)
            const newValue = JSON.stringify({ ...current, intent: undefined, operation: backend.operations[operationId],
                sourceHeadId: operationId, headRevision })
            localStorage.setItem(key, newValue)
            window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue, storageArea: localStorage }))
            q.stage('mock-stale-storage-event', { operationId, headRevision })
        }
        q.publishNewerIntent = () => {
            const key = Object.keys(localStorage).find(key => key.startsWith('hapi.fork-operation.v1.'))!
            const oldValue = localStorage.getItem(key), current = JSON.parse(oldValue!)
            const intent = { operationId: crypto.randomUUID(), expectedForkRevision: backend.revision,
                duplicateRiskOf: backend.operation.operationId }
            const newValue = JSON.stringify({ ...current, intent, operation: undefined,
                sourceHeadId: undefined, headRevision: backend.revision })
            localStorage.setItem(key, newValue)
            window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue, storageArea: localStorage }))
            q.stage('mock-other-tab-saved-intent', { intent })
            return intent
        }
        q.admitOtherTabHead = () => {
            const body = { operationId: crypto.randomUUID(), expectedForkRevision: backend.revision,
                duplicateRiskOf: backend.operation.operationId }
            backend.posts.push(body)
            backend.requestsById[body.operationId] = body
            backend.revision++
            backend.simulatedDispatches++
            backend.runtimeAccepted[body.operationId] = true
            const operation = save({ operationId: body.operationId, sourceSessionId: 'chat-1',
                childSessionId: 'chat-1-fork-' + backend.revision, sourceRevision: backend.revision,
                duplicateRiskOf: body.duplicateRiskOf, status: 'indeterminate',
                message: 'Synthetic newer operation admitted in another tab', updatedAt: Date.now() })
            q.publishStaleStorage(operation.operationId, backend.revision)
            q.stage('mock-other-tab-admitted-head', { operationId: operation.operationId })
            return operation
        }
        const closeProof = (id: string) => {
            const own = backend.operations[id]
            const sourceState = () => ({ revision: backend.revision, ...(backend.operation ? { operation: backend.operation } : {}) })
            if (own.code === 'fork_closed_unadmitted') return { operation: own, sourceState: sourceState(), closure: 'closed' }
            if (own.status === 'created') return { operation: own, sourceState: sourceState(), closure: 'already_admitted' }
            if (own.status === 'rejected') return { operation: own, sourceState: sourceState(), closure: 'already_resolved' }
            if (q.closeMode === 'unavailable') return { operation: own, sourceState: sourceState(), closure: 'unavailable',
                message: 'Synthetic runtime could not verify whether the request was accepted' }
            if (backend.runtimeAccepted[id]) return { operation: own, sourceState: sourceState(), closure: 'already_admitted',
                message: 'Synthetic runtime receipt already exists; no cancellation was performed' }
            const proof = save({ ...own, status: 'rejected', rejectionProof: 'not_dispatched', code: 'fork_closed_unadmitted',
                message: 'Synthetic exact-ID unadmitted closure proof', updatedAt: Date.now() }, false)
            if (backend.operation?.operationId === id) {
                backend.revision++
                backend.operation = own.duplicateRiskOf ? backend.operations[own.duplicateRiskOf] : null
            }
            q.persist()
            return { operation: proof, sourceState: sourceState(), closure: 'closed',
                message: 'Synthetic durable closure; this request ID cannot dispatch' }
        }
        document.addEventListener('click', event => {
            const button = (event.target as Element)?.closest?.('button')
            if (['Fork', 'Create another fork anyway', 'Close request if it has not started'].includes(button?.textContent?.trim() ?? '')) {
                q.stage('actual-fork-click', { label: button!.textContent!.trim(), trusted: event.isTrusted,
                    inDialog: !!button!.closest('[role=dialog]') })
            }
        }, true)
        const json = (data: any, status = 200) => {
            const body = JSON.stringify(data)
            q.bytes += new TextEncoder().encode(body).length
            return new Response(body, { status, headers: { 'Content-Type': 'application/json' } })
        }
        const reply = (operation: any) => json({ operation,
            ...(operation.binding === 'ready' ? { sessionId: operation.childSessionId } : {}) },
        operation.binding === 'ready' || operation.status === 'rejected' ? 200 : 202)
        const headFor = (id: string) => backend.childHeads[id] ?? count
        const session = (s: any) => ({ ...s, seq: headFor(s.id), updatedAt: createdAt + headFor(s.id), ...q.flags,
            metadata: { ...s.metadata, codexNativeSession: true, codexSessionId: 'native-' + s.id,
                capabilities: { ...s.metadata?.capabilities, concurrentClients: true,
                    conversationHistory: { forkCurrent: true, forkAtMessage: true, rewindToMessage: false } },
                conversationHistoryPoints: {} } })
        const message = (id: string, n: number) => {
            q.generated++
            const meta = { nativeExecution: { threadId: 'native-' + id, turnId: id + '-turn-' + Math.ceil(n / 2),
                itemId: id + '-' + n, phase: 'final_answer', turn: { status: 'completed', started: true, ended: true } } }
            return { id: id + '-m-' + n, seq: n, localId: n % 2 ? id + '-m-' + n + '-local' : null,
                createdAt: createdAt + n, invokedAt: createdAt + n,
                content: n % 2 ? { role: 'user', meta, content: { type: 'text', text: id + ' · 问题 ' + n + '：Fork target' } }
                    : { role: 'agent', meta, content: { type: 'codex', data: { type: 'message', streamSnapshot: true,
                        message: id + ' · 记录 ' + n + (n === count && blockBytes
                            ? '\n\n' + ('large-block '.repeat(Math.ceil(blockBytes / 12))).slice(0, blockBytes)
                            : '\n\nCompleted answer') } } } }
        }
        let active = original
        Object.defineProperty(window, 'fetch', { configurable: true, get: () => active, set: (base: any) => {
            active = async (input: any, init: any) => {
                const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin)
                const method = init?.method ?? 'GET'
                if (!u.pathname.startsWith('/api/')) return base(input, init)
                const record = { path: u.pathname + u.search, method, at: performance.now(),
                    body: method === 'POST' && u.pathname.endsWith('/fork') ? JSON.parse(init?.body ?? '{}') : undefined }
                q.requests.push(record)
                if (u.pathname.endsWith('/read-state')) return json({ state: { sessionId: u.pathname.split('/')[3],
                    seenAt: createdAt + count, manualUnreadAt: null, version: 1 }, applied: true })
                if (u.pathname === '/api/sessions/chat-1/fork-operations' && method === 'GET') {
                    q.sourceReads++
                    return json({ revision: backend.revision, ...(backend.operation ? { operation: backend.operation } : {}) })
                }
                if (u.pathname.endsWith('/fork-operations') && method === 'GET') return json({ revision: 0 })
                const closing = u.pathname.match(/^\/api\/sessions\/chat-1\/fork-operations\/([^/]+)\/close-unadmitted$/)
                if (closing && method === 'POST') {
                    const body = JSON.parse(init?.body ?? '{}')
                    backend.closePosts.push({ operationId: closing[1], body })
                    q.persist()
                    q.stage('close-post', { operationId: closing[1], body })
                    if (q.closeMode === 'network' || q.closeMode === 'lost-before') throw new TypeError('Synthetic close request unavailable before proof')
                    if (q.closeMode === '401') return json({ error: 'Synthetic close authorization failure', code: 'unauthorized' }, 401)
                    if (body.expectedForkRevision !== backend.revision) return json({ error: 'Source changed before close',
                        code: 'fork_revision_conflict', revision: backend.revision, operation: backend.operation }, 409)
                    if (q.closeMode === 'ready-at-close') q.complete(closing[1])
                    const result = JSON.parse(JSON.stringify(closeProof(closing[1])))
                    q.stage('mock-close-proof', { operationId: closing[1], result })
                    if (q.closeMode === 'hold-after-proof') {
                        await new Promise<void>(resolve => { q.gates.releaseClose = resolve })
                        q.stage('mock-late-close-proof-delivered', { operationId: closing[1] })
                    }
                    if (q.closeMode === 'lost-after') throw new TypeError('Synthetic close response lost after durable proof')
                    return json(result)
                }
                const lookup = u.pathname.match(/^\/api\/sessions\/chat-1\/fork-operations\/([^/]+)(\/reconcile)?$/)
                if (lookup) {
                    if (q.failLookup === 'network') throw new TypeError('Synthetic offline lookup')
                    if (q.failLookup === '401') return json({ error: 'Synthetic authorization failure', code: 'unauthorized' }, 401)
                    if (q.failLookup === 'other404') return json({ error: 'Synthetic missing route', code: 'not_found' }, 404)
                    if (q.gates.holdLookupId === lookup[1]) {
                        q.gates.holdLookupId = null
                        await new Promise<void>(resolve => { q.gates.releaseLookup = resolve })
                        q.stage('mock-late-operation-get-delivered', { operationId: lookup[1] })
                    }
                    let operation = backend.operations[lookup[1]]
                    if (!operation) return json({ error: 'Operation not found', code: 'operation_not_found' }, 404)
                    if (lookup[2] && method === 'POST' && operation.status === 'created') {
                        operation = q.complete(lookup[1])
                        q.stage('binding-only-reconcile', { operationId: lookup[1] })
                    }
                    return reply(operation)
                }
                if (u.pathname.endsWith('/fork') && method === 'POST') {
                    const body = record.body
                    backend.posts.push(body)
                    q.persist()
                    q.stage('fork-post', { body, savedAtPost: q.saved() })
                    // Idempotent replays resolve the exact ID before inspecting the source head.
                    if (backend.operations[body.operationId]) return reply(backend.operations[body.operationId])
                    if (q.mode === 'not-admitted' || q.mode === 'risk-not-admitted') {
                        q.mode = 'success'
                        throw new TypeError('Synthetic connection failed before Hub admission')
                    }
                    if (q.mode === 'conflict') {
                        backend.revision++
                        save({ operationId: crypto.randomUUID(), sourceSessionId: 'chat-1', childSessionId: 'another-tab-child',
                            sourceRevision: backend.revision, status: 'created', nativeThreadId: 'another-native', binding: 'ready',
                            message: 'Created in another tab', updatedAt: Date.now() })
                        return json({ error: 'This source has a newer fork operation. Review it before deliberately creating another.',
                            code: 'fork_revision_conflict', revision: backend.revision, operation: backend.operation }, 409)
                    }
                    if (body.expectedForkRevision !== backend.revision) return json({ error: 'Stale source revision',
                        code: 'fork_revision_conflict', revision: backend.revision, operation: backend.operation }, 409)
                    if (body.duplicateRiskOf) {
                        if (body.nativeBoundary || body.messageLocalId) throw new Error('Risk REST payload must not contain a boundary')
                        if (q.mode === 'risk-target-ready') q.complete(body.duplicateRiskOf)
                        if (backend.operation?.operationId !== body.duplicateRiskOf || backend.operation.status !== 'indeterminate') {
                            return json({ error: 'Original fork is already ready', code: 'risk_target_changed',
                                revision: backend.revision, operation: backend.operation }, 409)
                        }
                    }
                    backend.revision++
                    backend.requestsById[body.operationId] = body
                    const childId = 'chat-1-fork-' + backend.revision
                    const receipt = { operationId: body.operationId, sourceSessionId: 'chat-1', childSessionId: childId,
                        sourceRevision: backend.revision, ...(body.duplicateRiskOf ? { duplicateRiskOf: body.duplicateRiskOf } : {}),
                        message: 'Synthetic fork receipt; native creation is not exercised', updatedAt: Date.now() }
                    if (q.mode === 'risk-rejected') {
                        const rejected = save({ ...receipt, status: 'rejected', rejectionProof: 'not_dispatched',
                            code: 'risk_target_running', message: 'Synthetic predispatch rejection' })
                        backend.revision++
                        backend.operation = backend.operations[body.duplicateRiskOf]
                        q.persist()
                        return reply(rejected)
                    }
                    if (q.mode === 'terminal-unresolved') return reply(save({ ...receipt, status: 'rejected',
                        rejectionProof: 'not_dispatched', code: 'fork_source_unresolved',
                        message: 'Original terminal operation 00000000-0000-4000-8000-000000000099 remains unknown; return to its native terminal.' }))
                    if (q.mode === 'hub-only') return reply(save({ ...receipt, status: 'indeterminate',
                        message: 'Synthetic Hub admitted this request; source runtime acceptance is unconfirmed' }))
                    backend.simulatedDispatches++
                    backend.runtimeAccepted[body.operationId] = true
                    if (q.mode === 'unknown') return reply(save({ ...receipt, status: 'indeterminate',
                        message: 'Synthetic original result remains unconfirmed; no automatic repeat was sent' }))
                    save({ ...receipt, status: 'running' })
                    if (q.mode === 'delayed') await new Promise<void>(resolve => { q.gates.release = resolve })
                    const completed = q.complete(body.operationId, q.mode === 'blocked' ? 'blocked' : 'ready')
                    if (q.mode === 'lost' || q.mode === 'risk-lost') throw new TypeError('Synthetic HTTP response lost after mock admission')
                    return reply(completed)
                }
                const match = u.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/)
                if (match && method === 'GET') {
                    const id = match[1], head = headFor(id), limit = Math.min(200, Number(u.searchParams.get('limit') ?? 20))
                    const before = Number(u.searchParams.get('beforeSeq') ?? 0), after = Number(u.searchParams.get('afterSeq') ?? 0)
                    const lo = after ? after + 1 : Math.max(1, (before || head + 1) - limit)
                    const hi = after ? Math.min(head, after + limit) : (before ? before - 1 : head), rows = []
                    for (let n = lo; n <= hi; n++) rows.push(message(id, n))
                    await new Promise(resolve => setTimeout(resolve, 30))
                    q.stage('message-response', { id, rows: rows.length, first: lo, last: hi })
                    return json({ messages: rows, page: { direction: before ? 'before' : after ? 'after' : 'latest', limit,
                        epoch: 1, reset: false, nextBeforeAt: rows.length ? createdAt + lo : null, nextBeforeSeq: rows.length ? lo : null,
                        nextAfterAt: rows.length ? createdAt + hi : null, nextAfterSeq: rows.length ? hi : null,
                        snapshotHeadAt: createdAt + head, snapshotHeadSeq: head, hasMore: after ? hi < head : lo > 1 } })
                }
                const child = u.pathname.match(/^\/api\/sessions\/([^/]+)$/)?.[1]
                if (child && backend.childHeads[child] !== undefined && method === 'GET') {
                    q.stage('detail-response', { id: child })
                    return json({ session: session({ ...q.sourceSession, id: child,
                        metadata: { ...q.sourceSession.metadata, name: 'Synthetic historical fork child' } }) })
                }
                const response = await base(input, init)
                if (method === 'GET' && /^\/api\/sessions(?:\/[^/]+)?$/.test(u.pathname)) {
                    const data = await response.json()
                    if (data.session) {
                        data.session = session(data.session)
                        if (data.session.id === 'chat-1') q.sourceSession = data.session
                        q.stage('detail-response', { id: data.session.id })
                    }
                    if (data.sessions) {
                        data.sessions = data.sessions.map(session)
                        if (q.sourceSession) for (const id of Object.keys(backend.childHeads)) {
                            data.sessions.push(session({ ...q.sourceSession, id,
                                metadata: { ...q.sourceSession.metadata, name: 'Synthetic historical fork child' } }))
                        }
                    }
                    return json(data, response.status)
                }
                return response
            }
        } })
        q.update = async (flags: any) => {
            q.flags = flags
            const data = await (await window.fetch('/api/sessions/chat-1')).json()
            W.__workspaceFixture.presenceEvent({ type: 'session-updated', sessionId: 'chat-1', data: data.session })
        }
        q.saved = () => Object.keys(localStorage).filter(key => key.startsWith('hapi.fork-operation.v1.'))
            .map(key => ({ key, ...JSON.parse(localStorage.getItem(key)!) }))
        q.snapshot = () => ({ scope: 'Actual App/native renderer with synthetic backend; no native/Hub/CLI mutation or model turns',
            historyCount: count, largeBlockBytes: blockBytes, backend, events: q.events, requests: q.requests,
            generated: q.generated, responseBytes: q.bytes, route: W.__workspaceFixture?.pathname(), child: q.child,
            windows: W.__workspaceFixture?.messageWindows(), nativeRenderer: !!document.querySelector('.hapi-native-thread'),
            modelSends: W.__workspaceFixture?.sends, saved: q.saved(),
            sourcePointCount: Object.keys(q.sourceSession?.metadata?.conversationHistoryPoints ?? {}).length,
            domListCount: document.querySelector('[data-hapi-list-count]')?.getAttribute('data-hapi-list-count'),
            editors: Array.from(document.querySelectorAll('[data-testid=rich-composer-input]')).map(element => ({
                tag: element.tagName, contentEditable: element.getAttribute('contenteditable'), text: element.textContent })) })
    }, { count, blockBytes, mode })
    const token = `${Buffer.from('{}').toString('base64')}.${Buffer.from(JSON.stringify({ uid: 1, ns: 'fixture', exp: 2100000000 })).toString('base64')}.fixture`
    await page.goto('/e2e-fixtures/workspace-fixture.html?single&controls&workspaceToken=' + encodeURIComponent(token))
    await expect(page.locator('.hapi-native-thread [data-chat-presented=true]')).toBeVisible()
    await expect(page.locator('[data-hapi-message-role=assistant]').last()).toContainText('记录 ' + count)
    await expect.poll(() => page.evaluate(() => (window as any).__forkJourney.sourceReads)).toBeGreaterThan(0)
}

async function fork(page: Page, historical = false, count = 320) {
    const m = metrics.get(page)
    m.beforeFork = await m.cdp.send('Performance.getMetrics')
    const before = (await forkPosts(page)).length
    const row = historical
        ? page.locator('[data-hapi-message-role=user]').filter({ hasText: '问题 ' + (count - 3) + '：' })
        : page.locator('[data-hapi-message-role=assistant]').last()
    await row.hover()
    await row.getByRole('button', { name: 'Fork', exact: true }).click()
    await page.evaluate(() => (window as any).__forkJourney.stage('confirm-click-requested'))
    await page.getByRole('dialog').getByRole('button', { name: 'Fork', exact: true }).click()
    await expect.poll(async () => (await forkPosts(page)).length).toBeGreaterThan(before)
}

async function assertReadableRecoveryBanner(page: Page) {
    const snapshot = () => page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>('[data-testid=fork-operation-banner]')
        if (!panel) return { absent: true, failures: ['Recovery banner is missing'] }
        const root = panel.closest<HTMLElement>('.app-chat')!, notices = panel.closest<HTMLElement>('.app-chat-notices')!
        const content = root.querySelector<HTMLElement>('.hapi-native-thread .chat-scroll-content')!
        const viewport = root.querySelector<HTMLElement>('.hapi-native-thread .chat-scroll-y')!
        const rect = panel.getBoundingClientRect(), style = getComputedStyle(panel), rootStyle = getComputedStyle(root)
        // Read the alpha of the resolved CSS color without depending on whether
        // Chromium serializes it as rgba(), color(srgb), or another color syntax.
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')!
        context.clearRect(0, 0, 1, 1)
        context.fillStyle = style.backgroundColor
        context.fillRect(0, 0, 1, 1)
        const backgroundAlpha = context.getImageData(0, 0, 1, 1).data[3] / 255
        let ancestorOpacity = 1
        const opacityChain: { element: string; opacity: number }[] = []
        for (let element: HTMLElement | null = panel; element; element = element.parentElement) {
            const opacity = Number(getComputedStyle(element).opacity)
            ancestorOpacity *= opacity
            if (opacity !== 1) opacityChain.push({ element: element.className, opacity })
        }
        const headerHeight = parseFloat(rootStyle.getPropertyValue('--glass-header-height'))
        const noticesHeight = parseFloat(rootStyle.getPropertyValue('--glass-notices-height'))
        const contentPaddingTop = parseFloat(getComputedStyle(content).paddingTop)
        const scrollPaddingTop = parseFloat(getComputedStyle(viewport).scrollPaddingTop)
        const buttons = Array.from(panel.querySelectorAll<HTMLButtonElement>('button')).map(button => {
            const bounds = button.getBoundingClientRect()
            const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
            return { text: button.textContent?.trim(), left: bounds.left, top: bounds.top, width: bounds.width,
                height: bounds.height, hit: !!hit && button.contains(hit) }
        })
        const failures = []
        if (backgroundAlpha < 1) failures.push(`Recovery background alpha is ${backgroundAlpha}; history can show through`)
        if (ancestorOpacity < 1) failures.push(`Recovery ancestor opacity is ${ancestorOpacity}`)
        if (!(noticesHeight + 1 >= rect.height)) failures.push('Measured notices height does not contain the recovery card')
        if (!(contentPaddingTop + 1 >= headerHeight + noticesHeight)) failures.push('Chat content does not reserve the notices inset')
        if (!(scrollPaddingTop + 1 >= headerHeight + noticesHeight)) failures.push('Chat scroll padding does not reserve the notices inset')
        if (panel.scrollWidth > panel.clientWidth + 1) failures.push('Recovery text overflows horizontally')
        if (buttons.some(button => !button.hit)) failures.push('A recovery action is covered or outside its hit target')
        return { absent: false, backgroundColor: style.backgroundColor, backgroundAlpha, ancestorOpacity, opacityChain,
            rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
            noticesRectHeight: notices.getBoundingClientRect().height, headerHeight, noticesHeight,
            contentPaddingTop, scrollPaddingTop, buttons, failures }
    })
    await expect.poll(async () => (await snapshot()).failures, {
        message: 'Recovery notice must be opaque, height-accounted and unobscured above the scrolling conversation',
    }).toEqual([])
    await test.info().attach('recovery-banner-layout', { body: JSON.stringify(await snapshot(), null, 2), contentType: 'application/json' })
}

async function riskDialog(page: Page) {
    await assertReadableRecoveryBanner(page)
    await expect(banner(page).getByRole('button', { name: riskLabel, exact: true })).toBeEnabled()
    await banner(page).getByRole('button', { name: riskLabel, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Create another fork despite the unknown result?' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('previous fork may already have succeeded')
    await expect(dialog).toContainText('may create an extra conversation')
    await expect(dialog).toContainText('does not cancel the previous native request')
    await test.info().attach('duplicate-risk-warning', { body: await page.screenshot(), contentType: 'image/png' })
    return dialog
}

async function createRisk(page: Page) {
    const before = (await forkPosts(page)).length
    await (await riskDialog(page)).getByRole('button', { name: riskLabel, exact: true }).click()
    await expect.poll(async () => (await forkPosts(page)).length).toBe(before + 1)
    await expect(page.getByRole('dialog')).toHaveCount(0)
}

async function assertDraftWithoutSend(page: Page, text = 'Unsent recovered fork draft') {
    const editor = page.getByRole('textbox', { name: 'Describe a task · @ session…', exact: true })
    await editor.fill(text)
    await expect(editor).toHaveText(text)
    expect(await page.evaluate(() => (window as any).__workspaceFixture.sends.length)).toBe(0)
}

async function assertChild(page: Page, id?: string) {
    if (id) await expect.poll(() => route(page)).toBe('/sessions/' + id)
    else await expect.poll(() => route(page)).toMatch(/^\/sessions\/chat-1-fork-/)
    await expect(page.locator('.hapi-native-thread [data-chat-presented=true]')).toBeVisible()
    await expect(page.locator('[data-hapi-message-role=assistant]').last()).toContainText(id ?? 'chat-1-fork-')
    await page.evaluate(() => (window as any).__forkJourney.stage('child-presented'))
    await assertDraftWithoutSend(page)
    await page.evaluate(() => (window as any).__forkJourney.stage('composer-draft-ready'))
}

test.afterEach(async ({ page }, info) => {
    const m = metrics.get(page)
    try {
        await info.attach('cdp-resource-metrics', { body: JSON.stringify({
            scope: 'Chromium renderer only; functional case includes setup/waits; not native process CPU or production latency',
            viewport: page.viewportSize(), project: info.project.name, before: m.initial, beforeFork: m.beforeFork,
            after: await m.cdp.send('Performance.getMetrics'),
        }, null, 2), contentType: 'application/json' })
        await info.attach('fork-journey', { body: JSON.stringify(await page.evaluate(() => (window as any).__forkJourney?.snapshot()), null, 2), contentType: 'application/json' })
        if (await banner(page).isVisible() && await page.getByRole('dialog').count() === 0) await assertReadableRecoveryBanner(page)
        await info.attach('final-ui', { body: await page.screenshot(), contentType: 'image/png' })
        if (await page.evaluate(() => !!(window as any).__workspaceFixture)) {
            expect(await page.evaluate(() => (window as any).__workspaceFixture.sends)).toEqual([])
        }
        expect(m.escapedApiRequests).toEqual([])
        expect(m.errors).toEqual([])
    } finally {
        await m.cdp.detach()
    }
})

test('lost HTTP response is recovered by exact operation GET and opens the existing child',async({page})=>{
 await setup(page,'lost');await fork(page,true)
 await expect(banner(page)).toContainText('Fork result unconfirmed')
 await expect(banner(page).getByRole('button',{name:'Check result',exact:true})).toBeEnabled()
 const before=await state(page);expect(before.simulatedDispatches).toBe(1)
 await banner(page).getByRole('button',{name:'Check result',exact:true}).click()
 await expect(banner(page)).toContainText('Fork is ready')
 expect((await state(page)).simulatedDispatches).toBe(1)
 expect(await page.evaluate(()=>(window as any).__forkJourney.requests.filter((r:any)=>r.path.endsWith('/fork')&&r.method==='POST').length)).toBe(1)
 await banner(page).getByRole('button',{name:'Open fork',exact:true}).click();await assertChild(page)
})

test('unknown survives reload and repeated checks without another POST or invented child',async({page})=>{
 await setup(page,'unknown');await fork(page,true);await expect(banner(page)).toContainText('Fork result unconfirmed')
 const original=await state(page);expect(original.simulatedDispatches).toBe(1)
 await page.reload();await expect(banner(page)).toContainText('Fork result unconfirmed')
 await banner(page).getByRole('button',{name:'Check result',exact:true}).click();await expect(banner(page)).toContainText('Fork result unconfirmed')
 const after=await state(page);expect(after.operation.operationId).toBe(original.operation.operationId);expect(after.simulatedDispatches).toBe(1)
 expect(await page.evaluate(()=>(window as any).__forkJourney.requests.filter((r:any)=>r.path.endsWith('/fork')&&r.method==='POST').length)).toBe(0)
 await expect(banner(page).getByRole('button',{name:'Open fork',exact:true})).toHaveCount(0)
 expect(await page.evaluate(()=>(window as any).__workspaceFixture.pathname())).toBe('/sessions/chat-1')
})

test('created-but-unbound recovers only its exact binding, then permits a deliberate new fork',async({page})=>{
 await setup(page,'blocked');await fork(page,true);await expect(banner(page)).toContainText('not ready to open')
 await banner(page).getByRole('button',{name:'Recover conversation binding',exact:true}).click();await expect(banner(page)).toContainText('Fork is ready')
 expect((await state(page)).simulatedDispatches).toBe(1)
 await page.evaluate(()=>(window as any).__forkJourney.mode='success')
 await fork(page,false);await assertChild(page)
 expect((await state(page)).simulatedDispatches).toBe(2)
 const posts=await page.evaluate(()=>(window as any).__forkJourney.requests.filter((r:any)=>r.path.endsWith('/fork')&&r.method==='POST').map((r:any)=>r.body))
 expect(posts[1].expectedForkRevision).toBe(1);expect(posts[1].operationId).not.toBe(posts[0].operationId)
})

test('late success cannot navigate after the user leaves the source pane',async({page})=>{
 await setup(page,'delayed');await fork(page,true)
 await page.evaluate(()=>(window as any).__workspaceFixture.navigate('/sessions/chat-2'))
 await expect.poll(()=>page.evaluate(()=>(window as any).__workspaceFixture.pathname())).toBe('/sessions/chat-2')
 await page.evaluate(()=>(window as any).__forkJourney.gates.release())
 await expect.poll(async()=>(await state(page)).operation.binding).toBe('ready')
 await page.waitForTimeout(200)
 expect(await page.evaluate(()=>(window as any).__workspaceFixture.pathname())).toBe('/sessions/chat-2')
 expect((await state(page)).simulatedDispatches).toBe(1)
})

test('stale-tab CAS conflict never refreshes and resubmits or navigates to the other intent',async({page})=>{
 await setup(page,'conflict');await fork(page,true)
 await expect(banner(page)).toContainText('newer fork operation')
 expect(await page.evaluate(()=>(window as any).__forkJourney.requests.filter((r:any)=>r.path.endsWith('/fork')&&r.method==='POST').length)).toBe(1)
 expect((await state(page)).simulatedDispatches).toBe(0)
 expect(await page.evaluate(()=>(window as any).__workspaceFixture.pathname())).toBe('/sessions/chat-1')
})


test('a never-admitted request can be explicitly resubmitted under the original ID without automatic POST',async({page})=>{
 await setup(page,'not-admitted');await fork(page,true)
 await expect(banner(page)).toContainText('Fork result unconfirmed')
 expect((await state(page)).simulatedDispatches).toBe(0)
 await banner(page).getByRole('button',{name:'Check result',exact:true}).click()
 const resend=banner(page).getByRole('button',{name:'Send original request',exact:true})
 await expect(resend).toBeEnabled()
 const first=await page.evaluate(()=>(window as any).__forkJourney.requests.filter((r:any)=>r.path.endsWith('/fork')&&r.method==='POST').map((r:any)=>r.body))
 expect(first).toHaveLength(1)
 await resend.click();await assertChild(page)
 const posts=await page.evaluate(()=>(window as any).__forkJourney.requests.filter((r:any)=>r.path.endsWith('/fork')&&r.method==='POST').map((r:any)=>r.body))
 expect(posts).toHaveLength(2);expect(posts[1]).toEqual(posts[0]);expect((await state(page)).simulatedDispatches).toBe(1)
})

test('canceling the separate duplicate-risk warning leaves the original operation and source usable', async ({ page }) => {
    await setup(page, 'unknown')
    await fork(page, true)
    const a = (await state(page)).operation
    const dialog = await riskDialog(page)
    await expect(dialog).toContainText(a.operationId)
    expect(await forkPosts(page)).toHaveLength(1)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(banner(page)).toContainText(a.operationId)
    expect(await forkPosts(page)).toHaveLength(1)
    expect((await state(page)).operation).toEqual(a)
    expect(await route(page)).toBe('/sessions/chat-1')
    await assertDraftWithoutSend(page, 'Keep working in the original conversation')
})

test('lost risk request persists B across reload and resends only the same UUID, ancestry and revision', async ({ page }) => {
    await setup(page, 'unknown')
    await fork(page, true)
    const a = (await state(page)).operation
    await page.evaluate(() => (window as any).__forkJourney.mode = 'risk-not-admitted')
    await createRisk(page)
    const [original, risk] = await forkPosts(page)
    expect(risk).toEqual({ operationId: expect.any(String), expectedForkRevision: 1, duplicateRiskOf: a.operationId })
    expect(risk.operationId).not.toBe(a.operationId)
    const persistedAtPost = await page.evaluate(() => (window as any).__forkJourney.events
        .filter((event: any) => event.name === 'fork-post').at(-1).savedAtPost)
    expect(persistedAtPost[0].intent).toEqual(risk)
    expect(original.nativeBoundary).toBeDefined()
    await expect(banner(page)).toContainText(risk.operationId)
    await expect(banner(page).getByRole('button', { name: 'Send original request', exact: true })).toHaveCount(0)
    expect((await state(page)).simulatedDispatches).toBe(1)
    await page.reload()
    await expect(banner(page)).toContainText(risk.operationId)
    expect(await forkPosts(page)).toHaveLength(2)
    await banner(page).getByRole('button', { name: 'Check result', exact: true }).click()
    const resend = banner(page).getByRole('button', { name: 'Send original request', exact: true })
    await expect(resend).toBeEnabled()
    expect(await forkPosts(page)).toHaveLength(2)
    await page.evaluate(() => (window as any).__forkJourney.mode = 'success')
    await resend.click()
    const b = (await state(page)).operation
    await assertChild(page, b.childSessionId)
    expect(await forkPosts(page)).toEqual([original, risk, risk])
    expect(b.operationId).toBe(risk.operationId)
    expect(b.duplicateRiskOf).toBe(a.operationId)
    const completed = await state(page)
    expect(completed.simulatedDispatches).toBe(2)
    // This assertion verifies the UI consumes the mock's historical child; the
    // actual server-side inheritance guarantee is covered in Hub/CLI tests.
    expect(completed.childHeads[b.childSessionId]).toBe(316)
    await expect(page.locator('[data-hapi-message-role=assistant]').last()).toContainText('记录 316')
})

test('lost risk response recovers admitted B by exact GET without another POST', async ({ page }) => {
    await setup(page, 'unknown')
    await fork(page, true)
    const a = (await state(page)).operation
    await page.evaluate(() => (window as any).__forkJourney.mode = 'risk-lost')
    await createRisk(page)
    const b = (await state(page)).operation
    expect(b.duplicateRiskOf).toBe(a.operationId)
    await expect(banner(page)).toContainText('Fork result unconfirmed')
    await banner(page).getByRole('button', { name: 'Check result', exact: true }).click()
    await expect(banner(page)).toContainText('Fork is ready')
    await expect(banner(page)).toContainText(b.operationId)
    await assertReadableRecoveryBanner(page)
    await test.info().attach('recovered-ready', { body: await page.screenshot(), contentType: 'image/png' })
    expect(await forkPosts(page)).toHaveLength(2)
    expect((await state(page)).simulatedDispatches).toBe(2)
    expect(await route(page)).toBe('/sessions/chat-1')
    await banner(page).getByRole('button', { name: 'Open fork', exact: true }).click()
    await assertChild(page, b.childSessionId)
})

test('late A ready at risk admission returns 409, clears unadmitted B, and can explicitly open A', async ({ page }) => {
    await setup(page, 'unknown')
    await fork(page, true)
    const a = (await state(page)).operation
    await page.evaluate(() => (window as any).__forkJourney.mode = 'risk-target-ready')
    await createRisk(page)
    const posts = await forkPosts(page)
    const b = posts[1]
    await expect(banner(page)).toContainText('Original fork is already ready')
    await expect(banner(page)).toContainText('Fork is ready')
    await expect(banner(page)).toContainText(a.operationId)
    await expect(banner(page)).not.toContainText(b.operationId)
    await expect(banner(page).getByRole('button', { name: 'Send original request', exact: true })).toHaveCount(0)
    const after = await state(page)
    expect(after.operations[b.operationId]).toBeUndefined()
    expect(after.simulatedDispatches).toBe(1)
    expect(after.revision).toBe(1)
    const saved = await page.evaluate(() => (window as any).__forkJourney.saved())
    expect(saved[0].intent).toBeUndefined()
    expect(saved[0].operation.operationId).toBe(a.operationId)
    expect(await route(page)).toBe('/sessions/chat-1')
    await page.reload()
    await expect(banner(page)).toContainText(a.operationId)
    await expect(banner(page)).not.toContainText(b.operationId)
    await expect(banner(page).getByRole('button', { name: 'Send original request', exact: true })).toHaveCount(0)
    await banner(page).getByRole('button', { name: 'Open fork', exact: true }).click()
    await assertChild(page, a.childSessionId)
    expect(await forkPosts(page)).toHaveLength(2)
})

test('a confirmation captured for A is not retargeted when A resolves before the final confirm', async ({ page }) => {
    await setup(page, 'unknown')
    await fork(page, true)
    const a = (await state(page)).operation
    const dialog = await riskDialog(page)
    await page.evaluate(id => (window as any).__forkJourney.complete(id), a.operationId)
    await dialog.getByRole('button', { name: riskLabel, exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(banner(page)).toContainText('state changed')
    await expect(banner(page)).toContainText('Fork is ready')
    expect(await forkPosts(page)).toHaveLength(1)
    expect((await state(page)).simulatedDispatches).toBe(1)
    expect(await route(page)).toBe('/sessions/chat-1')
})

test('rejected B restores A at head revision 3 and a new confirmed C uses revision 3', async ({ page }) => {
    await setup(page, 'unknown')
    await fork(page, true)
    const a = (await state(page)).operation
    await page.evaluate(() => (window as any).__forkJourney.mode = 'risk-rejected')
    await createRisk(page)
    const posts = await forkPosts(page), bId = posts[1].operationId
    await expect(banner(page)).toContainText(a.operationId)
    await expect(banner(page)).not.toContainText(bId)
    const restored = await state(page)
    expect(restored.operations[bId]).toMatchObject({ status: 'rejected', rejectionProof: 'not_dispatched', sourceRevision: 2 })
    expect(restored.operation).toMatchObject({ operationId: a.operationId, sourceRevision: 1 })
    expect(restored.revision).toBe(3)
    expect(restored.simulatedDispatches).toBe(1)
    await page.reload()
    await expect(banner(page)).toContainText(a.operationId)
    // A different tab may still have B's older receipt; it cannot become head.
    await page.evaluate(id => (window as any).__forkJourney.publishStaleStorage(id, 2), bId)
    await expect(banner(page)).toContainText(a.operationId)
    await expect(banner(page)).not.toContainText(bId)
    await banner(page).getByRole('button', { name: 'Check result', exact: true }).click()
    await expect(banner(page).getByRole('button', { name: riskLabel, exact: true })).toBeEnabled()
    await createRisk(page)
    const final = await state(page), c = final.posts[2]
    expect(c).toEqual({ operationId: expect.any(String), expectedForkRevision: 3, duplicateRiskOf: a.operationId })
    expect([a.operationId, bId]).not.toContain(c.operationId)
    expect(final.operation).toMatchObject({ operationId: c.operationId, sourceRevision: 4, duplicateRiskOf: a.operationId })
    expect(final.revision).toBe(4)
    expect(final.simulatedDispatches).toBe(2)
    await expect(banner(page)).toContainText(c.operationId)
    expect(await route(page)).toBe('/sessions/chat-1')
})

test('late A exact response and older storage cannot replace B or navigate after explicit risk admission', async ({ page }) => {
    await setup(page, 'unknown')
    await fork(page, true)
    const a = (await state(page)).operation
    // Advance only browser timers to expire the production controller's finite
    // wait. This case is race coverage, not a wall-clock latency measurement.
    await page.clock.install()
    await page.evaluate(id => (window as any).__forkJourney.gates.holdLookupId = id, a.operationId)
    await banner(page).getByRole('button', { name: 'Check result', exact: true }).click()
    await expect.poll(() => page.evaluate(() => typeof (window as any).__forkJourney.gates.releaseLookup)).toBe('function')
    await page.clock.fastForward(30_001)
    await expect(banner(page).getByRole('button', { name: riskLabel, exact: true })).toBeEnabled()
    await createRisk(page)
    const b = (await state(page)).operation
    expect(b.operationId).not.toBe(a.operationId)
    await page.evaluate(id => {
        const q = (window as any).__forkJourney
        q.complete(id)
        q.gates.releaseLookup()
    }, a.operationId)
    await expect.poll(() => page.evaluate(() => (window as any).__forkJourney.events
        .filter((event: any) => event.name === 'mock-late-operation-get-delivered').length)).toBe(1)
    await expect(banner(page)).toContainText(b.operationId)
    await expect(banner(page)).not.toContainText(a.operationId)
    await expect(banner(page).getByRole('button', { name: 'Open fork', exact: true })).toHaveCount(0)
    let saved = await page.evaluate(() => (window as any).__forkJourney.saved())
    expect(saved[0].operation.operationId).toBe(b.operationId)
    await page.evaluate(id => (window as any).__forkJourney.publishStaleStorage(id, 1), a.operationId)
    await expect(banner(page)).toContainText(b.operationId)
    await banner(page).getByRole('button', { name: 'Check result', exact: true }).click()
    await expect(banner(page).getByRole('button', { name: riskLabel, exact: true })).toBeEnabled()
    saved = await page.evaluate(() => (window as any).__forkJourney.saved())
    expect(saved[0].operation.operationId).toBe(b.operationId)
    expect((await state(page)).operation.operationId).toBe(b.operationId)
    expect(await route(page)).toBe('/sessions/chat-1')
    expect(await forkPosts(page)).toHaveLength(2)
    expect((await state(page)).simulatedDispatches).toBe(2)
})

for (const failure of ['network', '401', 'other404']) {
    test(`an unconfirmed risk request never gains resend permission from ${failure}`, async ({ page }) => {
        await setup(page, 'unknown')
        await fork(page, true)
        await page.evaluate(() => (window as any).__forkJourney.mode = 'risk-not-admitted')
        await createRisk(page)
        await page.evaluate(value => (window as any).__forkJourney.failLookup = value, failure)
        await banner(page).getByRole('button', { name: 'Check result', exact: true }).click()
        await expect(banner(page).getByRole('button', { name: 'Check result', exact: true })).toBeEnabled()
        await expect(banner(page).getByRole('button', { name: 'Send original request', exact: true })).toHaveCount(0)
        await expect(banner(page).getByRole('button', { name: riskLabel, exact: true })).toHaveCount(0)
        expect(await forkPosts(page)).toHaveLength(2)
        expect((await state(page)).simulatedDispatches).toBe(1)
        expect(await route(page)).toBe('/sessions/chat-1')
    })
}

test('terminal-origin unresolved rejection remains diagnostic and never exposes Web risk release or ordinary retry advice', async ({ page }) => {
    await setup(page, 'terminal-unresolved')
    await fork(page, true)
    await expect(banner(page)).toContainText('Another fork of this native source remains unconfirmed')
    await expect(banner(page)).toContainText('This request created nothing')
    await expect(banner(page)).toContainText('Web cannot release that operation')
    await expect(banner(page)).toContainText('00000000-0000-4000-8000-000000000099')
    await expect(banner(page)).not.toContainText('deliberately create a new fork')
    for (const name of [riskLabel, closeLabel, 'Send original request', 'Recover conversation binding', 'Open fork']) {
        await expect(banner(page).getByRole('button', { name, exact: true })).toHaveCount(0)
    }
    await banner(page).getByRole('button', { name: 'Check result', exact: true }).click()
    await expect(banner(page).getByRole('button', { name: 'Check result', exact: true })).toBeEnabled()
    expect(await forkPosts(page)).toHaveLength(1)
    expect((await state(page)).simulatedDispatches).toBe(0)
    expect(await route(page)).toBe('/sessions/chat-1')
    await assertDraftWithoutSend(page)
})

test('long history records bounded response resources and shows the historical child with an unsent composer draft', async ({ page }, info) => {
    const historyCount = 40_000, largeBlockBytes = 512 * 1024
    await setup(page, 'lost', historyCount, largeBlockBytes)
    await fork(page, true, historyCount)
    await expect(banner(page)).toContainText('Fork result unconfirmed')
    await banner(page).getByRole('button', { name: 'Check result', exact: true }).click()
    await expect(banner(page)).toContainText('Fork is ready')
    await banner(page).getByRole('button', { name: 'Open fork', exact: true }).click()
    await assertChild(page)
    await expect(page.locator('[data-hapi-message-role=assistant]').last()).toContainText('记录 39996')
    const snapshot = await page.evaluate(() => (window as any).__forkJourney.snapshot())
    expect(snapshot.generated).toBeLessThan(1000)
    expect(snapshot.sourcePointCount).toBe(0)
    expect(snapshot.backend.simulatedDispatches).toBe(1)
    expect(snapshot.backend.posts).toHaveLength(1)
    expect(snapshot.requests.filter((request: any) => request.path.includes('/messages') && request.method === 'POST')).toEqual([])
    expect(snapshot.events.filter((event: any) => event.name === 'message-response')
        .every((event: any) => event.rows <= 200)).toBe(true)
    const confirmed = snapshot.events.find((event: any) => event.name === 'confirm-click-requested')?.at
    const presented = snapshot.events.find((event: any) => event.name === 'child-presented')?.at
    const composer = snapshot.events.find((event: any) => event.name === 'composer-draft-ready')?.at
    await info.attach('long-history-response-resources', { body: JSON.stringify({
        scope: 'Synthetic transport on real App/native renderer; bytes cover intercepted JSON only, not assets; elapsed includes explicit result check/open and UI waits',
        historyCount, largeBlockBytes, generatedRows: snapshot.generated, responseBytes: snapshot.responseBytes,
        sourceHistoryPointCount: snapshot.sourcePointCount, messageWindows: snapshot.windows,
        confirmToChildPresentedMs: presented - confirmed, confirmToEditableDraftMs: composer - confirmed,
        route: snapshot.route, modelSends: snapshot.modelSends,
    }, null, 2), contentType: 'application/json' })
})

// Close-unadmitted browser scope: receipts below are synthetic Hub/runtime
// evidence. Only protocol tests can prove a real durable native tombstone.
async function missingRuntimeB(page: Page) {
    await setup(page, 'unknown')
    await fork(page, true)
    const a = (await state(page)).operation
    await page.evaluate(() => (window as any).__forkJourney.mode = 'hub-only')
    await createRisk(page)
    const b = (await state(page)).operation
    expect(b).toMatchObject({ sourceRevision: 2, duplicateRiskOf: a.operationId, status: 'indeterminate' })
    expect((await state(page)).simulatedDispatches).toBe(1)
    await expect(banner(page).getByRole('button', { name: closeLabel, exact: true })).toBeEnabled()
    return { a, b }
}

async function closeDialog(page: Page, operationId: string) {
    await assertReadableRecoveryBanner(page)
    await banner(page).getByRole('button', { name: closeLabel, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Close this request only if it has not started?' })
    await expect(dialog).toContainText(operationId)
    await expect(dialog).toContainText('only if it has not accepted it')
    await expect(dialog).toContainText('will not cancel a request')
    await expect(dialog).toContainText('already accepted or dispatched')
    await test.info().attach('close-unadmitted-warning', { body: await page.screenshot(), contentType: 'image/png' })
    return dialog
}

async function confirmClose(page: Page, operationId: string) {
    const before = (await closePosts(page)).length
    await (await closeDialog(page, operationId)).getByRole('button', { name: closeLabel, exact: true }).click()
    await expect.poll(async () => (await closePosts(page)).length).toBe(before + 1)
    await expect(page.getByRole('dialog')).toHaveCount(0)
}

async function expectClosedB(page: Page, a: any, b: any) {
    await expect(closeResult(page)).toContainText('This request was closed before the source runtime accepted it.')
    await expect(closeResult(page)).toContainText(b.operationId)
    await expect(banner(page).getByText('Request ID: ' + a.operationId, { exact: true })).toBeVisible()
    await expect(banner(page).getByRole('button', { name: riskLabel, exact: true })).toBeEnabled()
    const after = await state(page)
    expect(after.operations[b.operationId]).toMatchObject({ operationId: b.operationId, sourceRevision: 2,
        status: 'rejected', rejectionProof: 'not_dispatched', code: 'fork_closed_unadmitted' })
    expect(after.operation).toMatchObject({ operationId: a.operationId, sourceRevision: 1, status: 'indeterminate' })
    expect(after.revision).toBe(3)
    expect(after.simulatedDispatches).toBe(1)
    expect(await route(page)).toBe('/sessions/chat-1')
    await assertReadableRecoveryBanner(page)
}

test('closing missing-runtime B restores A at revision 3 before a separate explicit risk C at revision 4', async ({ page }) => {
    const { a, b } = await missingRuntimeB(page)
    expect(await closePosts(page)).toEqual([])
    await confirmClose(page, b.operationId)
    await expectClosedB(page, a, b)
    expect(await closePosts(page)).toEqual([{ operationId: b.operationId, body: { expectedForkRevision: 2 } }])
    expect(await forkPosts(page)).toHaveLength(2)
    await test.info().attach('closed-b-restored-a', { body: await page.screenshot(), contentType: 'image/png' })
    await assertDraftWithoutSend(page, 'Original conversation remains usable after closing only B')
    await page.evaluate(() => (window as any).__forkJourney.mode = 'unknown')
    await createRisk(page)
    const after = await state(page), c = after.operation
    expect(c).toMatchObject({ status: 'indeterminate', sourceRevision: 4, duplicateRiskOf: a.operationId })
    expect([a.operationId, b.operationId]).not.toContain(c.operationId)
    expect(after.posts[2]).toEqual({ operationId: c.operationId, expectedForkRevision: 3, duplicateRiskOf: a.operationId })
    expect(after.simulatedDispatches).toBe(2)
    expect(after.revision).toBe(4)
    await expect(closeResult(page)).toHaveCount(0)
    await expect(banner(page)).toContainText(c.operationId)
    expect(await closePosts(page)).toHaveLength(1)
    expect(await route(page)).toBe('/sessions/chat-1')
})

test('an already accepted B is not closed or cancelled and stays the exact active operation', async ({ page }) => {
    await setup(page, 'unknown')
    await fork(page, true)
    await createRisk(page)
    const before = await state(page), b = before.operation
    expect(before.simulatedDispatches).toBe(2)
    await confirmClose(page, b.operationId)
    await expect(closeResult(page)).toContainText('The source runtime already accepted this request.')
    await expect(closeResult(page)).toContainText('It was not closed or cancelled.')
    await expect(closeResult(page)).not.toContainText('was closed before')
    const after = await state(page)
    expect(after.operation).toEqual(b)
    expect(after.revision).toBe(2)
    expect(after.simulatedDispatches).toBe(2)
    expect(after.posts).toHaveLength(2)
    expect(after.closePosts).toEqual([{ operationId: b.operationId, body: { expectedForkRevision: 2 } }])
    expect(await route(page)).toBe('/sessions/chat-1')
})

test('a lost successful close response is recovered by exact B GET with no repeated close or new fork', async ({ page }) => {
    const { a, b } = await missingRuntimeB(page)
    await page.evaluate(() => (window as any).__forkJourney.closeMode = 'lost-after')
    await confirmClose(page, b.operationId)
    await expect(banner(page)).toContainText('Synthetic close response lost')
    await expect(closeResult(page)).toHaveCount(0)
    expect(await closePosts(page)).toHaveLength(1)
    expect(await forkPosts(page)).toHaveLength(2)
    await banner(page).getByRole('button', { name: 'Check result', exact: true }).click()
    await expectClosedB(page, a, b)
    expect(await closePosts(page)).toHaveLength(1)
    expect(await forkPosts(page)).toHaveLength(2)
    await test.info().attach('lost-close-recovered', { body: await page.screenshot(), contentType: 'image/png' })
    await page.reload()
    await expect(banner(page).getByText('Request ID: ' + a.operationId, { exact: true })).toBeVisible()
    expect((await state(page)).revision).toBe(3)
    expect(await closePosts(page)).toHaveLength(1)
    expect(await forkPosts(page)).toHaveLength(2)
})

test('a close lost before proof can only be tried again by fresh confirmation for the same B and revision', async ({ page }) => {
    const { a, b } = await missingRuntimeB(page)
    await page.evaluate(() => (window as any).__forkJourney.closeMode = 'lost-before')
    await confirmClose(page, b.operationId)
    await expect(closeResult(page)).toHaveCount(0)
    await banner(page).getByRole('button', { name: 'Check result', exact: true }).click()
    await expect(banner(page).getByRole('button', { name: closeLabel, exact: true })).toBeEnabled()
    expect(await closePosts(page)).toHaveLength(1)
    expect((await state(page)).operation.operationId).toBe(b.operationId)
    await page.evaluate(() => (window as any).__forkJourney.closeMode = undefined)
    await confirmClose(page, b.operationId)
    await expectClosedB(page, a, b)
    const posts = await closePosts(page)
    expect(posts).toHaveLength(2)
    expect(posts[1]).toEqual(posts[0])
    expect(await forkPosts(page)).toHaveLength(2)
})

test('cancelling a close confirmation leaves B unknown without any close POST', async ({ page }) => {
    const { b } = await missingRuntimeB(page)
    const dialog = await closeDialog(page, b.operationId)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await closePosts(page)).toEqual([])
    expect((await state(page)).operation).toEqual(b)
    expect((await state(page)).revision).toBe(2)
    expect(await forkPosts(page)).toHaveLength(2)
    await expect(closeResult(page)).toHaveCount(0)
    await assertDraftWithoutSend(page)
})

test('a close confirmation captured for B cannot close it after B becomes ready', async ({ page }) => {
    const { b } = await missingRuntimeB(page)
    const dialog = await closeDialog(page, b.operationId)
    await page.evaluate(id => (window as any).__forkJourney.complete(id), b.operationId)
    await dialog.getByRole('button', { name: closeLabel, exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(banner(page)).toContainText('state changed')
    await expect(banner(page)).toContainText('Fork is ready')
    await expect(closeResult(page)).toHaveCount(0)
    expect(await closePosts(page)).toEqual([])
    expect(await forkPosts(page)).toHaveLength(2)
    expect(await route(page)).toBe('/sessions/chat-1')
})

for (const newer of ['receipt', 'intent']) {
    test(`late B closure proof cannot overwrite a newer other-tab C ${newer} or navigate`, async ({ page }) => {
        const { b } = await missingRuntimeB(page)
        // Timer acceleration is limited to stale-response coverage; it is not
        // used by long-history performance observations.
        await page.clock.install()
        await page.evaluate(() => (window as any).__forkJourney.closeMode = 'hold-after-proof')
        const dialog = await closeDialog(page, b.operationId)
        await dialog.getByRole('button', { name: closeLabel, exact: true }).click()
        await expect.poll(() => page.evaluate(() => typeof (window as any).__forkJourney.gates.releaseClose)).toBe('function')
        await page.clock.fastForward(30_001)
        await expect(page.getByRole('dialog')).toHaveCount(0)
        const c = await page.evaluate(kind => kind === 'receipt'
            ? (window as any).__forkJourney.admitOtherTabHead()
            : (window as any).__forkJourney.publishNewerIntent(), newer)
        await expect(banner(page)).toContainText(c.operationId)
        await page.evaluate(() => (window as any).__forkJourney.gates.releaseClose())
        await expect.poll(() => page.evaluate(() => (window as any).__forkJourney.events
            .filter((event: any) => event.name === 'mock-late-close-proof-delivered').length)).toBe(1)
        await expect(banner(page)).toContainText(c.operationId)
        await expect(closeResult(page)).toHaveCount(0)
        const saved = await page.evaluate(() => (window as any).__forkJourney.saved())
        expect(newer === 'receipt' ? saved[0].operation.operationId : saved[0].intent.operationId).toBe(c.operationId)
        expect(saved[0].headRevision).toBe(newer === 'receipt' ? 4 : 3)
        expect(await closePosts(page)).toEqual([{ operationId: b.operationId, body: { expectedForkRevision: 2 } }])
        const localForks = await page.evaluate(() => (window as any).__forkJourney.requests
            .filter((request: any) => request.method === 'POST' && request.path.endsWith('/fork')))
        expect(localForks).toHaveLength(2)
        expect(await route(page)).toBe('/sessions/chat-1')
    })
}

for (const failure of ['network', '401', 'unavailable']) {
    test(`close ${failure} preserves B and checking never automatically repeats close or fork`, async ({ page }) => {
        const { b } = await missingRuntimeB(page)
        await page.evaluate(value => (window as any).__forkJourney.closeMode = value, failure)
        await confirmClose(page, b.operationId)
        if (failure === 'unavailable') {
            await expect(closeResult(page)).toContainText('Could not confirm that this request can be closed.')
            await expect(closeResult(page)).toContainText('It remains protected.')
        } else await expect(closeResult(page)).toHaveCount(0)
        expect((await state(page)).operation).toEqual(b)
        expect((await state(page)).revision).toBe(2)
        await banner(page).getByRole('button', { name: 'Check result', exact: true }).click()
        await expect(banner(page).getByRole('button', { name: closeLabel, exact: true })).toBeEnabled()
        expect(await closePosts(page)).toHaveLength(1)
        expect(await forkPosts(page)).toHaveLength(2)
        expect((await state(page)).simulatedDispatches).toBe(1)
        await expect(banner(page)).toContainText(b.operationId)
        expect(await route(page)).toBe('/sessions/chat-1')
    })
}

test('B becoming ready between close preflight and admission stays already admitted with explicit Open only', async ({ page }) => {
    const { b } = await missingRuntimeB(page)
    await page.evaluate(() => (window as any).__forkJourney.closeMode = 'ready-at-close')
    await confirmClose(page, b.operationId)
    await expect(closeResult(page)).toContainText('The source runtime already accepted this request.')
    await expect(closeResult(page)).toContainText('It was not closed or cancelled.')
    await expect(closeResult(page)).not.toContainText('was closed before')
    await expect(banner(page)).toContainText('Fork is ready')
    expect((await state(page)).operation).toMatchObject({ operationId: b.operationId, status: 'created', binding: 'ready' })
    expect((await state(page)).revision).toBe(2)
    expect(await forkPosts(page)).toHaveLength(2)
    expect(await closePosts(page)).toHaveLength(1)
    expect(await route(page)).toBe('/sessions/chat-1')
    await test.info().attach('close-already-admitted-ready', { body: await page.screenshot(), contentType: 'image/png' })
    await banner(page).getByRole('button', { name: 'Open fork', exact: true }).click()
    await assertChild(page, b.childSessionId)
})
