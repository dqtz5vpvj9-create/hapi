import './workspace-fixture'
import { documentPdf } from './document-pdf'
import { initializeFontScale } from '@/hooks/useFontScale'

// Use the production App/router and the existing session boundary. Only file
// APIs differ: sessions have independent mutable bytes by default. sharedFiles
// explicitly models two sessions on the same machine, backed by one filesystem.
// Assertions can therefore detect both misrouted bytes and stale shared editors.
// The fixture bypasses main.tsx, so apply its real saved display preference too.
initializeFontScale()
const root = '/mnt/cache/src/hapi'
const sharedFiles = new URLSearchParams(location.search).has('sharedFiles')
const layout = new URLSearchParams(location.search).has('layout')
const storageKey = `fixture:file-workbench:v1${sharedFiles ? ':shared' : ''}${layout ? ':layout' : ''}`
const encoder = new TextEncoder()
const decoder = new TextDecoder()
type Entry = { type: 'file' | 'directory'; content: string; revision: number }
type FileState = { revision: number; sessions: Record<string, Record<string, Entry>> }
type FailureCode = 'conflict' | 'denied' | 'not-found' | 'invalid'
type Mutation = { sessionId: string; action: string; path: string; destination?: string; success: boolean; code?: FailureCode }
type FileRequest = { sessionId: string; method: string; route: string; path: string }

function encode(bytes: Uint8Array): string {
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
}
const decode = (content: string) => Uint8Array.from(atob(content), character => character.charCodeAt(0))
const seed = (): FileState => ({
    revision: 1,
    sessions: Object.fromEntries(['chat-1', 'chat-2', 'chat-3', 'chat-4'].map(sessionId => [sessionId, Object.fromEntries([
        ...['', '/src', '/docs', '/lazy', '/lazy/nested', '/empty'].map(path => [root + path, { type: 'directory', content: '', revision: 1 }]),
        ...[
            ['/README.md', `# ${sessionId} root document\n\nRoot bytes for ${sessionId}.\n`],
            ['/src/README.md', `# ${sessionId} source document\n\nSource bytes for ${sessionId}.\n`],
            ['/docs/README.md', `# ${sessionId} documentation\n\nDocumentation bytes for ${sessionId}.\n`],
            ['/lazy/nested/leaf.txt', `Lazy bytes for ${sessionId}.\n`],
            ['/.hidden.txt', `Hidden bytes for ${sessionId}.\n`],
        ].map(([path, text]) => [root + path, { type: 'file', content: encode(encoder.encode(text)), revision: 1 }]),
        ...(layout ? [
            ...['/object-aware-ram', '/outputs', '/scripts', '/submitted', '/variants', '/docs/research', '/docs/research/AgentCompletionInterrupt']
                .map(path => [root + path, { type: 'directory', content: '', revision: 1 }]),
            // Render actual PDF.js canvas/text layers within the production
            // file workbench; a placeholder cannot reveal stacked reader chrome.
            [root + '/docs/research/AgentCompletionInterrupt/6787-R2-review.pdf', { type: 'file', content: encode(documentPdf({ portrait: true })), revision: 1 }],
        ] : []),
    ])])) as FileState['sessions'],
})
const state: FileState = JSON.parse(localStorage.getItem(storageKey) ?? 'null') ?? seed()
const persist = () => localStorage.setItem(storageKey, JSON.stringify(state))
persist()
localStorage.setItem('hapi-files-tab', 'directories')

class FileFailure extends Error {
    constructor(public code: FailureCode, message: string) { super(message) }
}
function canonical(path: string): string {
    if (path.includes('\0')) throw new FileFailure('invalid', 'Invalid path.')
    const absolute = path.startsWith('/') ? path : `${root}/${path}`
    const parts: string[] = []
    for (const part of absolute.split('/')) {
        if (part === '..') parts.pop()
        else if (part && part !== '.') parts.push(part)
    }
    const result = `/${parts.join('/')}`
    if (result !== root && !result.startsWith(`${root}/`)) throw new FileFailure('denied', 'Path is outside the session directory.')
    return result
}
const parent = (path: string) => path.slice(0, path.lastIndexOf('/'))
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)
function files(sessionId: string): Record<string, Entry> {
    if (!state.sessions[sessionId]) throw new FileFailure('not-found', 'Session not found.')
    return state.sessions[sharedFiles ? 'chat-1' : sessionId]
}
function requireEntry(sessionId: string, path: string): Entry {
    const entry = files(sessionId)[path]
    if (!entry) throw new FileFailure('not-found', 'File not found.')
    return entry
}
function inspect(sessionId: string, path: string) {
    const entry = requireEntry(sessionId, path)
    return {
        path, name: basename(path), type: entry.type,
        size: entry.type === 'file' ? decode(entry.content).byteLength : 0,
        modified: 1_790_000_000_000 + entry.revision,
        revision: `fixture-revision-${entry.revision}`,
        entryCount: entry.type === 'directory' ? Object.keys(files(sessionId)).filter(key => key.startsWith(`${path}/`)).length : 1,
    }
}
function changed(sessionId: string, paths: string[]) {
    const revision = ++state.revision
    for (const [path, entry] of Object.entries(files(sessionId))) {
        if (paths.some(changedPath => changedPath === path || changedPath.startsWith(`${path}/`))) entry.revision = revision
    }
    persist()
}
function requireDestination(sessionId: string, path: string) {
    if (path === root) throw new FileFailure('denied', 'The session directory cannot be replaced.')
    if (files(sessionId)[path]) throw new FileFailure('conflict', 'Destination already exists. No files were overwritten.')
    if (requireEntry(sessionId, parent(path)).type !== 'directory') throw new FileFailure('invalid', 'Destination parent must be a directory.')
}
const hash = async (content: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', decode(content))), byte => byte.toString(16).padStart(2, '0')).join('')
const heldDirectories = new Map<string, { promise: Promise<void>; release: () => void }>()
const heldMutations = new Map<string, { promise: Promise<void>; release: () => void }>()
const probe = {
    requests: [] as FileRequest[],
    mutations: [] as Mutation[],
    unhandled: [] as string[],
    text(sessionId: string, path: string) {
        const entry = files(sessionId)[canonical(path)]
        return entry?.type === 'file' ? decoder.decode(decode(entry.content)) : null
    },
    bytes(sessionId: string, path: string) {
        const entry = files(sessionId)[canonical(path)]
        return entry?.type === 'file' ? Array.from(decode(entry.content)) : null
    },
    paths(sessionId: string) { return Object.keys(files(sessionId)).sort() },
    changeFile(sessionId: string, path: string, text: string) {
        const resolved = canonical(path)
        const entry = requireEntry(sessionId, resolved)
        if (entry.type !== 'file') throw new Error('External edit requires an existing file.')
        entry.content = encode(encoder.encode(text))
        changed(sessionId, [resolved])
    },
    removeFile(sessionId: string, path: string) {
        const resolved = canonical(path)
        if (requireEntry(sessionId, resolved).type !== 'file') throw new Error('External deletion requires an existing file.')
        delete files(sessionId)[resolved]
        changed(sessionId, [resolved])
    },
    holdDirectory(sessionId: string, path: string) {
        const key = `${sessionId}:${canonical(path)}`
        let release!: () => void
        const promise = new Promise<void>(resolve => { release = resolve })
        heldDirectories.set(key, { promise, release })
    },
    releaseDirectories() {
        for (const held of heldDirectories.values()) held.release()
        heldDirectories.clear()
    },
    holdMutation(sessionId: string, action: string, path: string) {
        const key = `${sessionId}:${action}:${canonical(path)}`
        let release!: () => void
        const promise = new Promise<void>(resolve => { release = resolve })
        heldMutations.set(key, { promise, release })
    },
    releaseMutations() {
        for (const held of heldMutations.values()) held.release()
        heldMutations.clear()
    },
}
declare global { interface Window { __fileWorkbenchFixture: typeof probe } }
window.__fileWorkbenchFixture = probe

const fallbackFetch = window.fetch.bind(window)
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin)
    const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(directory|files|file|file-info|filesystem(?:\/.*)?)$/)
    if (!match) {
        const response = await fallbackFetch(input, init)
        if (/^\/api\/sessions(?:\/chat-\d+)?$/.test(url.pathname) && response.ok && (init?.method ?? 'GET') === 'GET') {
            // Equal machine + absolute path deliberately share a document in
            // production. Distinct fixture bytes therefore need distinct
            // machines, even though these projects use the same path spelling.
            const data = await response.json()
            const isolate = (session: { id: string; metadata?: Record<string, unknown> | null }) => ({
                ...session, metadata: { ...session.metadata, machineId: sharedFiles ? 'file-fixture-shared' : `file-fixture-${session.id}` },
            })
            if (Array.isArray(data.sessions)) data.sessions = data.sessions.map(isolate)
            if (data.session) data.session = isolate(data.session)
            return json(data, response.status)
        }
        return response
    }
    const sessionId = decodeURIComponent(match[1]), route = match[2]
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const body = method === 'GET' ? {} : JSON.parse(typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : '{}')
    const requestedPath = String(url.searchParams.get('path') ?? body.path ?? '')
    probe.requests.push({ sessionId, method, route, path: requestedPath })
    let mutation: Mutation | undefined
    try {
        const path = canonical(requestedPath)
        const entries = files(sessionId)
        if (route === 'directory' && method === 'GET') {
            await heldDirectories.get(`${sessionId}:${path}`)?.promise
            if (requireEntry(sessionId, path).type !== 'directory') throw new FileFailure('invalid', 'Not a directory.')
            return json({ success: true, entries: Object.entries(entries).filter(([key]) => parent(key) === path).map(([key, entry]) => ({
                name: basename(key), type: entry.type,
                size: entry.type === 'file' ? decode(entry.content).byteLength : undefined,
                modified: 1_790_000_000_000 + entry.revision,
            })) })
        }
        if (route === 'files' && method === 'GET') {
            const query = (url.searchParams.get('query') ?? '').toLowerCase()
            return json({ success: true, files: Object.entries(entries).filter(([path, entry]) => entry.type === 'file' && path.toLowerCase().includes(query)).map(([path, entry]) => ({ path: path.slice(root.length + 1), name: basename(path), size: decode(entry.content).byteLength })) })
        }
        if (route === 'filesystem/entry' && method === 'GET') return json({ success: true, entry: inspect(sessionId, path) })
        if (route === 'file-info' && method === 'GET') {
            const entry = inspect(sessionId, path)
            return json({ success: true, entries: [{ path, size: entry.size, modified: entry.modified }] })
        }
        if (route === 'file' && method === 'GET') {
            const entry = requireEntry(sessionId, path)
            if (entry.type !== 'file') throw new FileFailure('invalid', 'Not a file.')
            return json({ success: true, path, content: entry.content, size: decode(entry.content).byteLength, hash: await hash(entry.content), writable: true })
        }
        if (route === 'filesystem/download' && method === 'GET') {
            const entry = requireEntry(sessionId, path)
            if (entry.type !== 'file') throw new FileFailure('invalid', 'Not a file.')
            return new Response(decode(entry.content), { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${basename(path)}"` } })
        }
        if (route === 'file' && method === 'PUT') {
            mutation = { sessionId, action: 'write', path, success: false }
            probe.mutations.push(mutation)
            const entry = requireEntry(sessionId, path)
            if (body.expectedHash !== await hash(entry.content)) throw new FileFailure('conflict', 'The file changed on disk.')
            entry.content = body.content
            changed(sessionId, [path])
            mutation.success = true
            return json({ success: true, hash: await hash(entry.content) })
        }
        if ((route === 'filesystem' || route === 'filesystem/upload') && method === 'POST') {
            const action = route === 'filesystem/upload' ? 'upload' : String(body.action)
            mutation = { sessionId, action, path, ...(body.destination ? { destination: canonical(body.destination) } : {}), success: false }
            probe.mutations.push(mutation)
            await heldMutations.get(`${sessionId}:${action}:${path}`)?.promise
            if (action === 'create-file' || action === 'create-directory' || action === 'upload') {
                requireDestination(sessionId, path)
                entries[path] = { type: action === 'create-directory' ? 'directory' : 'file', content: action === 'upload' ? body.content : '', revision: state.revision }
                changed(sessionId, [path])
            } else {
                if (path === root) throw new FileFailure('denied', 'The session directory cannot be changed.')
                const original = inspect(sessionId, path)
                if (body.expectedRevision !== original.revision) throw new FileFailure('conflict', 'The source changed on disk. Review it again before retrying.')
                const affected = Object.keys(entries).filter(key => key === path || key.startsWith(`${path}/`))
                if (action === 'delete') {
                    if (original.type === 'directory' && original.entryCount > 0 && body.recursive !== true) throw new FileFailure('invalid', 'Confirm recursive deletion of this folder.')
                    for (const key of affected) delete entries[key]
                    changed(sessionId, [path])
                    mutation.success = true
                    return json({ success: true })
                }
                if (!['rename', 'move', 'copy'].includes(action)) throw new FileFailure('invalid', 'Unsupported operation.')
                const destination = canonical(body.destination)
                requireDestination(sessionId, destination)
                if (destination.startsWith(`${path}/`)) throw new FileFailure('invalid', 'A folder cannot be copied or moved inside itself.')
                for (const key of affected) entries[destination + key.slice(path.length)] = { ...entries[key] }
                if (action !== 'copy') for (const key of affected) delete entries[key]
                changed(sessionId, [path, ...affected.map(key => destination + key.slice(path.length))])
                mutation.success = true
                return json({ success: true, entry: inspect(sessionId, destination) })
            }
            mutation.success = true
            return json({ success: true, entry: inspect(sessionId, path) })
        }
        probe.unhandled.push(`${method} ${url.pathname}`)
        return json({ error: 'Unhandled file fixture route.' }, 404)
    } catch (error) {
        if (!(error instanceof FileFailure)) throw error
        if (mutation) mutation.code = error.code
        return json({ success: false, code: error.code, error: error.message })
    }
}
