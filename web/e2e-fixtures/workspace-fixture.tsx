import { bytesBase64 } from '@/documents/documentSession'
import { documentPdf } from './document-pdf'
import { htmlReportPath, htmlReportFiles, htmlIsolationReport } from './html-report'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import { toSessionSummary } from '@hapi/protocol'
import type { Session, DecryptedMessage, SyncEvent, MessagesResponse } from '@/types/api'
import { createAppRouter } from '@/router'
import { I18nProvider } from '@/lib/i18n-context'
import { WorkspaceStore, workspaceStorageKey } from '@/workspace/workspaceStore'
import { applyWorkspaceCommand, type WorkspaceSnapshot, type WorkspaceUpdateRequest } from '@hapi/protocol/workspaces'
import { captureReadingAnchor, type ReadingAnchor } from '@/lib/reading-anchor'
import { getMessageWindowState } from '@/lib/message-window-store'
import '@/index.css'

// Exercise the real router, App, pane controllers, composer and history readers.
// Only the Hub boundary is simulated; no model or native process is started.
const params = new URLSearchParams(location.search)
const previewPdf = /^pane-visibility\.(pptx|pdf)$/.test(params.get('documentSample') ?? '') ? documentPdf() : undefined
const benchmarkPanes = Number(params.get('panes'))
const paneCount = [1, 2, 4].includes(benchmarkPanes) ? benchmarkPanes : params.has('split') ? 2 : 0
const token = params.get('workspaceToken') ?? `${btoa('{}')}.${btoa(JSON.stringify({ uid: 'workspace-fixture', ns: 'fixture', exp: Math.floor(Date.now() / 1000) + 86400 }))}.fixture`
localStorage.setItem(`hapi_access_token::${location.origin}`, 'fixture')
localStorage.setItem('hapi-appearance', new URLSearchParams(location.search).get('appearance') ?? 'light')
localStorage.setItem('hapi-color-theme', new URLSearchParams(location.search).get('theme') ?? 'codex')
if (!params.has('unseenFeatures')) localStorage.setItem('hapi.fue.v1.rich-composer-mentions', '1')
localStorage.setItem('hapi.fue.v1.scratchlist-toggle', '1')
const createdAt = 1_790_000_000_000
const remoteWorkspaces = params.get('remoteWorkspaces')
const NativeEventSource = window.EventSource
const titles = ['历史阅读优化', 'Windows 终端集成', '工作区交互设计', '发布检查']
if (params.has('longTitles')) titles[2] = '为项目汇总跨平台工作记录与历史加载验证结果 · Weekly report and regression review'
if (params.has('workingSet')) for (let index = 5; index <= (Number(params.get('workingSet')) || 12); index++) titles.push(`缓存会话 ${index}`)
const sessions: Session[] = titles.map((name, index) => ({
    id: `chat-${index + 1}`, namespace: 'fixture', seq: 320, createdAt, updatedAt: createdAt + 320, hasConversationContent: true,
    active: true, activeAt: Date.now(), thinking: false, thinkingAt: 0,
    metadata: { name, path: '/mnt/cache/src/hapi', host: 'CHRIS', flavor: 'codex', codexNativeSession: !(params.has('mixed') && index === 1), codexSessionId: `native-${index + 1}`, machineId: 'machine-chris', ...(params.has('controls') ? { capabilities: { concurrentClients: true } } : {}) },
    metadataVersion: 1, agentState: null, agentStateVersion: 0, model: 'gpt-6.1-sol', modelReasoningEffort: 'high', permissionMode: 'yolo',
}))
function message(sessionId: string, seq: number, text?: string): DecryptedMessage {
    const meta = { nativeExecution: { threadId: sessionId, turnId: `${sessionId}-turn-${Math.ceil(seq / 2)}`, itemId: `${sessionId}-${seq}`, phase: 'final_answer', turn: { status: 'completed', started: true, ended: true } } }
    const richAnswer = params.has('rich') && seq === 320
        ? `\n\n\`\`\`typescript\n${Array.from({ length: 1500 }, (_, i) => `export const record${i} = { session: '${sessionId}', line: ${i}, message: 'Preserve the source position after resizing and switching.' }`).join('\n')}\n\`\`\``
        : ''
    return { id: `${sessionId}-m-${seq}`, seq, localId: null, createdAt: createdAt + seq, invokedAt: createdAt + seq,
        content: seq % 2 ? { role: 'user', meta, content: { type: 'text', text: text ?? `${sessionId} · 问题 ${seq}：检查这一步的实际表现。` } }
            : { role: 'agent', meta, content: { type: 'codex', data: { type: 'message', streamSnapshot: true, message: text ?? `${sessionId} · 记录 ${seq}\n\n保留当前阅读位置，验证分屏后的历史加载。每个窗格使用独立的输入框，切换工作区后仍可继续阅读。${richAnswer}` } } },
    } as DecryptedMessage
}
const history = new Map(sessions.map(s => [s.id, Array.from({ length: 320 }, (_, i) => message(s.id, i + 1))]))
const streams = new Set<FixtureSource>()
let eventId = 0
let bodyPaused = false
let bodyResumeGap = false
class FixtureSource {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2
    readyState = 0
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    constructor(public url: string) {
        streams.add(this)
        probe.openedConnections.push(url)
        setTimeout(() => this.open(), 10)
    }
    open() {
        const global = new URL(this.url, location.origin).searchParams.has('all')
        if (this.readyState !== 0 || (!global && bodyPaused)) return
        this.readyState = 1; this.onopen?.(new Event('open'))
        const resume = !global && bodyResumeGap ? 'gap' : 'ok'
        if (!global) bodyResumeGap = false
        this.emit({ type: 'connection-changed', data: { subscriptionId: crypto.randomUUID(), resume } } as SyncEvent)
    }
    emit(event: SyncEvent) {
        if (this.readyState !== 1) return
        const query = new URL(this.url, location.origin).searchParams
        const ids: string[] = JSON.parse(query.get('sessionIds') ?? '[]')
        if ('sessionId' in event && !query.has('all') && query.get('sessionId') !== event.sessionId && !ids.includes(event.sessionId)) return
        const delivered = event.type === 'message-received' && query.get('messageMode') === 'notify'
            ? { type: 'message-updated', sessionId: event.sessionId, scheduled: event.message.scheduledAt != null } : event
        probe.delivered.push({ global: query.has('all'), type: delivered.type, sessionId: 'sessionId' in delivered ? delivered.sessionId : null })
        this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(delivered), lastEventId: String(++eventId) }))
    }
    close() { this.readyState = 2; streams.delete(this) }
}
window.EventSource = FixtureSource as unknown as typeof EventSource
if (remoteWorkspaces) {
    const events = new NativeEventSource(`${remoteWorkspaces}/api/events?token=${encodeURIComponent(token)}`)
    events.onmessage = event => { for (const stream of streams) if (new URL(stream.url, location.origin).searchParams.has('all')) stream.emit(JSON.parse(event.data)) }
}
let heldHistory: Promise<void> | null = null
let finishHistory: (() => void) | null = null
let failNextSend: Promise<void> | null = null
let releaseFailure: (() => void) | null = null
let heldUpload: Promise<void> | null = null
let releaseUpload: (() => void) | null = null
let heldResume: Promise<void> | null = null
let releaseResume: (() => void) | null = null
const documentText = () => localStorage.getItem('fixture:document-text') ?? '# 文档工作区\n\n这是可以直接编辑和保存的 Markdown 原文件。\n\n## 本次验收\n\n- 保留来源聊天\n- 切换窗格保留草稿\n- 选区进入原会话草稿\n\n```typescript\nconst status = "ready"\n```\n'
const documentHash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('')
const probe = {
    fileWrites: [] as { path: string; expectedHash: string; content: string }[],
    updateDocument(text: string) { localStorage.setItem('fixture:document-text', text) },
    sends: [] as { sessionId: string; text: string; localId: string }[],
    uploads: [] as { sessionId: string; filename: string; path: string; complete: boolean }[],
    deletedUploads: [] as { sessionId: string; path: string }[],
    goals: [] as { sessionId: string; action: string; objective?: string }[],
    resumes: [] as { source: string; target: string }[],
    requests: [] as string[], unhandled: [] as string[],
    openedConnections: [] as string[],
    delivered: [] as { global: boolean; type: string; sessionId: string | null }[],
    pauseBodies() {
        bodyPaused = true
        for (const stream of [...streams]) {
            if (!new URL(stream.url, location.origin).searchParams.has('all')) stream.onerror?.(new Event('error'))
        }
    },
    resumeBodies() {
        bodyPaused = false; bodyResumeGap = true
        for (const stream of streams) stream.open()
    },
    responseBytes: 0,
    holdHistory() { heldHistory = new Promise(resolve => { finishHistory = resolve }) },
    releaseHistory() { finishHistory?.(); heldHistory = null },
    messageWindows() {
        return sessions.map(session => {
            const state = getMessageWindowState(session.id)
            return { id: session.id, rows: state.messages.length, bytes: JSON.stringify(state.messages).length * 2 }
        })
    },
    captureReading(sessionId: string) {
        const viewport = document.querySelector<HTMLElement>(`[data-session-id="${sessionId}"] .chat-scroll-y`)
        return viewport ? captureReadingAnchor(viewport) : null
    },
    async codePoint(sessionId: string, anchor: ReadingAnchor) {
        const viewport = document.querySelector<HTMLElement>(`[data-session-id="${sessionId}"] .chat-scroll-y`)
        const row = document.getElementById(anchor.id)
        if (!viewport || !row || !anchor.code) return null
        const element = row.querySelectorAll<HTMLElement>('[data-hapi-large-code]')[anchor.code.source]
        const editor = element?.querySelector<HTMLElement>('.cm-editor')
        const view = editor && (await import('@codemirror/view')).EditorView.findFromDOM(editor)
        if (!view || view.state.doc.sliceString(anchor.code.quoteStart, anchor.code.quoteStart + anchor.code.quote.length) !== anchor.code.quote) return null
        const point = view.coordsAtPos(anchor.code.position)
        return point ? point.top - viewport.getBoundingClientRect().top : null
    },
    holdUpload() { heldUpload = new Promise(resolve => { releaseUpload = resolve }) },
    finishUpload() { releaseUpload?.() },
    archive(sessionId: string) {
        const session = sessions.find(s => s.id === sessionId)!
        session.active = false
        for (const stream of streams) stream.emit({ type: 'session-updated', sessionId, data: session })
    },
    holdResume() { heldResume = new Promise(resolve => { releaseResume = resolve }) },
    finishResume() { releaseResume?.(); heldResume = null },
    publishSupersession() {
        const { source, target } = probe.resumes.at(-1)!
        const session = sessions.find(s => s.id === source)!
        session.metadata = { ...session.metadata!, supersededBySessionId: target }
        session.metadataVersion++
        for (const stream of streams) stream.emit({ type: 'session-updated', sessionId: source, data: session })
    },
    holdFailedSend() { failNextSend = new Promise(resolve => { releaseFailure = resolve }) },
    releaseFailedSend() { releaseFailure?.() },
    append(sessionId: string) {
        const rows = history.get(sessionId)!
        const next = message(sessionId, rows.length + 1, `LIVE ${sessionId} ${rows.length + 1}`)
        rows.push(next)
        for (const stream of streams) {
            stream.emit({ type: 'message-received', sessionId, message: next })
        }
    },
    navigate: (to: string) => router.navigate({ to }),
    back: () => router.history.back(),
    forward: () => router.history.forward(),
    pathname: () => router.state.location.pathname,
    connections: () => [...streams].map(s => s.url),
}
declare global { interface Window { __workspaceFixture: typeof probe } }
window.__workspaceFixture = probe
const realFetch = window.fetch.bind(window)
function fixtureJson(data: unknown, init?: ResponseInit): Response {
    const body = JSON.stringify(data)
    probe.responseBytes += new TextEncoder().encode(body).byteLength
    return new Response(body, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
}
window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin)
    if (url.pathname === '/health') return fixtureJson({ status: 'ok' })
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init)
    const path = url.pathname, method = init?.method ?? 'GET'
    probe.requests.push(`${method} ${path}${url.search}`)
    if (heldHistory && method === 'GET' && /\/messages(?:[/?]|$)/.test(path)) await heldHistory
    let data: unknown
    if (path.startsWith('/api/workspaces')) {
        if (remoteWorkspaces) return realFetch(`${remoteWorkspaces}${path}`, init)
        const saved = JSON.parse(localStorage.getItem('fixture:workspace-hub') ?? 'null') as { snapshot: WorkspaceSnapshot; ids: string[] } | null
        let snapshot = saved?.snapshot ?? { schemaVersion: 2 as const, revision: 0, workspaces: [] }
        const ids = saved?.ids ?? []
        if (method === 'GET') return fixtureJson(snapshot)
        const request = JSON.parse(String(init?.body)) as WorkspaceUpdateRequest
        if (ids.includes(request.operation.id)) return fixtureJson({ status: 'duplicate', snapshot })
        if (request.expectedRevision !== snapshot.revision) return fixtureJson({ status: 'conflict', snapshot }, { status: 409 })
        const result = request.operation.command.type === 'import' && snapshot.revision > 0
            ? { workspaces: snapshot.workspaces, skipped: 'already-initialized' }
            : applyWorkspaceCommand(snapshot.workspaces, request.operation.command)
        snapshot = { ...snapshot, revision: snapshot.revision + 1, workspaces: result.workspaces }
        localStorage.setItem('fixture:workspace-hub', JSON.stringify({ snapshot, ids: [...ids, request.operation.id] }))
        return fixtureJson({ status: 'applied', snapshot, skipped: result.skipped })
    }
    if (path === '/api/auth') data = { token, user: { id: 1, username: 'fixture' } }
    else if (path === '/api/health') data = { status: 'ok', capabilities: {} }
    else if (path === '/api/sessions') data = { sessions: sessions.map(toSessionSummary) }
    else if (path === '/api/visibility') data = { success: true }
    else if (path === '/api/voice/backend') data = { backend: null, backends: [] }
    else if (path === '/api/voice/transcription/providers') data = { providers: [] }
    else if (path.endsWith('/codex-models')) data = { success: true, models: [{ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: '6.1 Sol', supportedReasoningEfforts: ['low', 'medium', 'high'] }] }
    else if (path === '/api/machines') data = { machines: [] }
    else if (path === '/api/hub-settings') data = { sessionSummaryContract: false, sessionSummaryInChat: false }
    else {
        const match = path.match(/^\/api\/sessions\/([^/]+)(.*)$/)
        const id = match?.[1] ?? '', suffix = match?.[2] ?? ''
        const session = sessions.find(s => s.id === id)
        if (session && !suffix) data = { session }
        else if (session && suffix === '/files') data = { success: true, files: [] }
        else if (session && suffix === '/document-preview' && previewPdf) data = { previewId: 'fixture-pdf', length: previewPdf.length, version: 'fixture-v1' }
        else if (session && suffix === '/document-preview/fixture-pdf' && previewPdf) {
            const range = new Headers(init?.headers).get('Range')!.match(/bytes=(\d+)-(\d+)/)!
            const start = Number(range[1]), end = Math.min(Number(range[2]), previewPdf.length - 1)
            return new Response(previewPdf.slice(start, end + 1), { status: 206, headers: { 'Content-Type': 'application/pdf', 'Content-Range': `bytes ${start}-${end}/${previewPdf.length}`, 'Accept-Ranges': 'bytes' } })
        }
        else if (session && suffix === '/document-preview' && params.get('documentSample')) return realFetch('http://127.0.0.1:5194/slides.pdf')
        else if (session && suffix === '/file-info') data = { success: true, entries: [{ path: url.searchParams.get('path'), size: new TextEncoder().encode(documentText()).length, modified: documentText().length }] }
        else if (session && suffix === '/file') {
            if (params.has('htmlDocument')) {
                const path = url.searchParams.get('path') ?? ''
                const text = path === htmlReportPath && params.has('htmlIsolation') ? htmlIsolationReport : path === htmlReportPath && params.has('htmlMixed') ? htmlReportFiles[path].replace('<head>', '<head>\r\n') : path === htmlReportPath ? localStorage.getItem('fixture:document-text') ?? htmlReportFiles[path] : htmlReportFiles[path]
                if (method === 'PUT') {
                    const body = JSON.parse(String(init?.body)); probe.fileWrites.push(body)
                    localStorage.setItem('fixture:document-text', new TextDecoder().decode(Uint8Array.from(atob(body.content), c => c.charCodeAt(0))))
                    data = { success: true, hash: await documentHash(documentText()) }
                } else data = text === undefined ? { success: false, error: 'File access denied' } : { success: true, content: bytesBase64(new TextEncoder().encode(text)), size: new TextEncoder().encode(text).length, hash: await documentHash(text), writable: true, path }
            } else if (method === 'PUT') {
                const body = JSON.parse(String(init?.body))
                probe.fileWrites.push(body)
                if (body.expectedHash !== await documentHash(documentText())) data = { success: false, code: 'conflict', error: 'The file changed on disk.' }
                else {
                    const text = new TextDecoder().decode(Uint8Array.from(atob(body.content), c => c.charCodeAt(0)))
                    localStorage.setItem('fixture:document-text', text)
                    data = { success: true, hash: await documentHash(text) }
                }
            } else if (previewPdf) {
                data = { success: true, content: bytesBase64(previewPdf), size: previewPdf.length, hash: 'fixture-v1', writable: false, path: `/fixture/${params.get('documentSample')}` }
            } else if (params.get('documentSample')) {
                const name = params.get('documentSample')!
                const bytes = new Uint8Array(await (await realFetch(`http://127.0.0.1:5194/${encodeURIComponent(name)}`)).arrayBuffer())
                data = { success: true, content: bytesBase64(bytes), size: bytes.length, hash: 'a'.repeat(64), writable: false, path: `/fixture/${name}` }
            } else data = { success: true, content: bytesBase64(new TextEncoder().encode(documentText())), size: new TextEncoder().encode(documentText()).length, hash: await documentHash(documentText()), writable: true, path: '/mnt/cache/src/hapi/PLAN.md' }
        }
        else if (session && suffix === '/resume') {
            const target = `${id}-resumed`
            probe.resumes.push({ source: id, target })
            sessions.push({ ...session, id: target, active: true, metadata: { ...session.metadata!, name: `Resumed ${session.metadata!.name}` } })
            history.set(target, [...history.get(id)!])
            if (heldResume) await heldResume
            data = { sessionId: target }
        }
        else if (session && suffix === '/upload') {
            const body = JSON.parse(String(init?.body))
            const upload = { sessionId: id, filename: body.filename, path: `/fixture/${id}/${crypto.randomUUID()}/${body.filename}`, complete: false }
            probe.uploads.push(upload)
            if (heldUpload) { const gate = heldUpload; heldUpload = null; await gate }
            upload.complete = true
            data = { success: true, path: upload.path }
        } else if (session && suffix === '/upload/delete') {
            probe.deletedUploads.push({ sessionId: id, path: JSON.parse(String(init?.body)).path })
            data = { success: true }
        }
        else if (session && suffix === '/codex/goal') {
            const request = JSON.parse(String(init?.body))
            probe.goals.push({ sessionId: id, ...request })
            const goal = { threadId: id, objective: request.objective, status: 'active' as const, tokensUsed: 0, timeUsedSeconds: 0, createdAt: Date.now(), updatedAt: Date.now() }
            session.agentState = { ...session.agentState, threadGoal: goal }
            session.agentStateVersion += 1
            for (const stream of streams) stream.emit({ type: 'session-updated', sessionId: id, data: session })
            data = { goal }
        }
        else if (session && suffix === '/messages' && method === 'POST') {
            const body = JSON.parse(String(init?.body))
            probe.sends.push({ sessionId: id, ...body })
            if (failNextSend) {
                const gate = failNextSend; failNextSend = null
                await gate
                return fixtureJson({ error: 'Fixture rejected this send' }, { status: 400 })
            }
            const rows = history.get(id)!, next = { ...message(id, rows.length + 1, body.text), localId: body.localId }
            rows.push(next)
            for (const stream of streams) stream.emit({ type: 'message-received', sessionId: id, message: next })
            data = { success: true, message: next }
        } else if (session && suffix === '/messages') {
            await new Promise(resolve => setTimeout(resolve, 30))
            const rows = history.get(id)!, limit = Number(url.searchParams.get('limit') ?? 60)
            const before = Number(url.searchParams.get('beforeSeq') ?? 0), after = Number(url.searchParams.get('afterSeq') ?? 0)
            const eligible = rows.filter(row => before ? row.seq! < before : after ? row.seq! > after : true)
            const messages = after ? eligible.slice(0, limit) : eligible.slice(-limit)
            const first = messages[0], last = messages.at(-1), head = rows.at(-1)
            const page: MessagesResponse['page'] = { direction: before ? 'before' : after ? 'after' : 'latest', limit, epoch: 1, reset: false,
                nextBeforeAt: first?.invokedAt ?? null, nextBeforeSeq: first?.seq ?? null, nextAfterAt: last?.invokedAt ?? null, nextAfterSeq: last?.seq ?? null,
                snapshotHeadAt: head?.invokedAt ?? null, snapshotHeadSeq: head?.seq ?? null, hasMore: eligible.length > messages.length }
            data = { messages, page }
        } else if (session && /^\/messages\/[^/]+\/context$/.test(suffix)) {
            await new Promise(resolve => setTimeout(resolve, 30))
            const rows = history.get(id)!, messageId = decodeURIComponent(suffix.split('/')[2])
            const index = rows.findIndex(row => row.id === messageId)
            if (index < 0) return fixtureJson({ error: 'Message not found' }, { status: 404 })
            const radius = Number(url.searchParams.get('radius') ?? 99)
            const messages = rows.slice(Math.max(0, index - radius), index + radius + 1)
            const position = (row: DecryptedMessage) => ({ at: row.invokedAt ?? row.createdAt, seq: row.seq! })
            data = { anchor: { messageId, position: position(rows[index]) }, messages,
                page: { epoch: 1, reset: false, beforeCursor: position(messages[0]), afterCursor: position(messages.at(-1)!),
                    snapshotHead: position(rows.at(-1)!), hasMoreBefore: index > radius, hasMoreAfter: index + radius < rows.length - 1 } }
        } else if (suffix === '/messages/queued-state') data = { queuedLocalIds: [], invokedLocalMessages: [] }
        else if (suffix.includes('models')) data = { success: true, models: [] }
        else if (suffix.includes('commands')) data = { success: true, commands: [] }
        else if (suffix.includes('skills')) data = { success: true, skills: [] }
        else if (suffix.includes('scratchlist')) data = { items: [], entries: [], scratchlist: [] }
        else if (suffix.includes('visibility')) data = { success: true }
        else { probe.unhandled.push(`${method} ${path}`); return fixtureJson({ error: `Unhandled fixture route: ${path}` }, { status: 404 }) }
    }
    return fixtureJson(data)
}
if (paneCount && !params.has('join') && !localStorage.getItem(workspaceStorageKey(location.origin, token))) {
    const store = new WorkspaceStore(workspaceStorageKey(location.origin, token))
    store.enter('chat-1')
    if (paneCount >= 2) store.openSession('chat-2', 'horizontal')
    if (paneCount === 4) {
        store.openSession('chat-1'); store.openSession('chat-3', 'vertical')
        store.openSession('chat-2'); store.openSession('chat-4', 'vertical')
    }
    if (params.has('workingSet')) {
        const first = store.active()!.id
        const groupSize = params.has('grouped') ? paneCount : 1
        for (let index = groupSize + 1; index <= sessions.length; index += groupSize) {
            store.create(); store.openSession(`chat-${index}`)
            if (groupSize >= 2) store.openSession(`chat-${index + 1}`, 'horizontal')
            if (groupSize === 4) {
                store.openSession(`chat-${index}`); store.openSession(`chat-${index + 2}`, 'vertical')
                store.openSession(`chat-${index + 1}`); store.openSession(`chat-${index + 3}`, 'vertical')
            }
        }
        store.activate(first)
    }
    if (params.has('documents')) {
        store.openSession('chat-1')
        const source = store.focusedPane()!
        store.openDocument(source.id, source.resource, { kind: 'document', sessionId: 'chat-1', document: { kind: 'file', path: params.has('htmlDocument') ? htmlReportPath : params.get('documentSample') ? `/fixture/${params.get('documentSample')}` : '/mnt/cache/src/hapi/PLAN.md', machineId: params.has('htmlDocument') ? 'machine-lis-imac' : 'machine-chris' } })
        if (previewPdf) {
            const current = store.active()!.id
            store.create('Other workspace')
            store.activate(current)
        }
    }
    if (params.has('savedSingle')) store.leave()
}
const router = createAppRouter(createMemoryHistory({ initialEntries: [params.has('singleDocument') ? `/sessions/chat-1/file?path=${encodeURIComponent(btoa('/mnt/cache/src/hapi/PLAN.md'))}` : params.has('list') ? '/sessions?view=list' : params.has('single') ? '/sessions/chat-1' : paneCount ? '/sessions/workspace' : '/sessions'] }))
createRoot(document.getElementById('root')!).render(<React.StrictMode><I18nProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider></I18nProvider></React.StrictMode>)
