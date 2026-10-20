import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { SignJWT, jwtVerify } from 'jose'
import { timingSafeEqual } from 'node:crypto'
import { realpath, lstat, stat } from 'node:fs/promises'
import { resolve, relative, isAbsolute, dirname, basename, win32 } from 'node:path'
import { panes, WorkspaceSnapshotSchema, WorkspaceUpdateRequestSchema } from '@hapi/protocol/workspaces'
import { UpdateSessionReadStateSchema } from '@hapi/protocol/schemas'
import { WorkspaceStore, createWorkspaceSchema } from '../store/workspaceStore'
import { PROTOCOL_VERSION, MACHINE_CAPABILITIES, SpawnSessionRequestSchema, MachineListDirectoryRequestSchema, MachinePathsExistsRequestSchema } from '@hapi/protocol'
import type { Machine, MachineDirectoryEntry, AgentAvailabilityResponse } from '@hapi/protocol'

type CodexLocalSessionSummary = { id: string; cwd?: string | null; [key: string]: unknown }

type Session = { id: string; metadata?: { path?: string; machineId?: string; [key: string]: unknown }; [key: string]: unknown }
type Event = { type: string; sessionId?: string; machineId?: string; data?: Record<string, unknown>; [key: string]: unknown }

export type ScopedGatewayOptions = {
    root: string
    machineId: string
    additionalScopes?: Array<{ machineId: string; root: string }>
    resolveRemotePath?: (machineId: string, path: string) => Promise<{ path: string; exists: boolean }>
    origin: string
    accessToken: string
    jwtSecret: Uint8Array
    database: Database
    upstream: (path: string, init?: RequestInit) => Promise<Response>
}

function sameSecret(a: string, b: string): boolean {
    const left = Buffer.from(a), right = Buffer.from(b)
    return left.length === right.length && timingSafeEqual(left, right)
}

export async function insideRoot(root: string, path: string): Promise<boolean> {
    try {
        const target = await realpath(path)
        const child = relative(root, target)
        return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith('../'))
    } catch { return false }
}

function publicSession(session: Session): Session {
    const metadata = { ...session.metadata }
    delete metadata.codexStoreId
    metadata.capabilities = { ...(metadata.capabilities as object), terminal: false }
    return { ...session, metadata }
}

export async function createScopedGateway(options: ScopedGatewayOptions) {
    const root = await realpath(options.root)
    const roots = new Map([[options.machineId, root], ...(options.additionalScopes ?? []).map(scope => [scope.machineId, scope.root] as [string, string])])
    const pathOps = (machineId: string) => machineId === options.machineId ? { resolve, relative, isAbsolute } : win32
    function scopedRoot(machineId: string) { return roots.get(machineId)! }
    async function within(machineId: string, path: string): Promise<boolean> {
        if (!roots.has(machineId)) return false
        if (machineId === options.machineId) return insideRoot(root, path)
        const ops = pathOps(machineId)
        const child = ops.relative(scopedRoot(machineId), path)
        if (ops.isAbsolute(child) || child === '..' || child.startsWith('..\\')) return false
        const canonical = await options.resolveRemotePath!(machineId, path)
        const resolvedChild = ops.relative(scopedRoot(machineId), canonical.path)
        return canonical.exists && !ops.isAbsolute(resolvedChild) && resolvedChild !== '..' && !resolvedChild.startsWith('..\\')
    }
    const db = options.database
    createWorkspaceSchema(db)
    db.exec('CREATE TABLE IF NOT EXISTS shared_read_states (id TEXT PRIMARY KEY, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS shared_uploads (session_id TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY(session_id,path));')
    const workspaces = new WorkspaceStore(db)
    const readers = new Set<(event: Event) => void>()
    const broadcast = (event: Event) => { for (const reader of readers) reader(event) }
    const app = new Hono()

    // Credential/installation paths and machine-wide controls are not project data.
    function publicMachine(machine: Machine): Machine {
        const metadata = machine.metadata
        return { ...machine, namespace: 'training', runnerState: null, health: null,
            metadata: metadata ? {
                host: metadata.host, platform: metadata.platform, happyCliVersion: metadata.happyCliVersion,
                displayName: metadata.displayName, icon: metadata.icon, homeDir: scopedRoot(machine.id), workspaceRoots: [scopedRoot(machine.id)],
                capabilities: [...(metadata.capabilities ?? []).filter(capability =>
                    capability !== MACHINE_CAPABILITIES.MachineTerminal && capability !== MACHINE_CAPABILITIES.StopRunner), 'shared-project']
            } : null }
    }
    async function sharedMachines(includeOffline = false): Promise<Machine[]> {
        const response = await options.upstream(`/api/machines${includeOffline ? '?includeOffline=true' : ''}`)
        if (!response.ok) throw new Error('Machine source unavailable')
        const { machines } = await response.json() as { machines: Machine[] }
        return machines.filter(machine => roots.has(machine.id)).map(publicMachine)
    }
    // New directories are allowed too; resolve the nearest existing ancestor so
    // a symlink cannot disguise an outside directory as a project descendant.
    async function projectPath(path: string, machineId = options.machineId): Promise<string | null> {
        if (!roots.has(machineId)) return null
        if (machineId !== options.machineId) {
            const base = scopedRoot(machineId)
            const requested = path === '~' ? base : win32.resolve(base, path.startsWith('~/') || path.startsWith('~\\') ? path.slice(2) : path)
            const child = win32.relative(base, requested)
            if (win32.isAbsolute(child) || child === '..' || child.startsWith('..\\')) return null
            const canonical = await options.resolveRemotePath!(machineId, requested)
            const resolvedChild = win32.relative(base, canonical.path)
            return !win32.isAbsolute(resolvedChild) && resolvedChild !== '..' && !resolvedChild.startsWith('..\\') ? canonical.path : null
        }
        const requested = path === '~' ? root : path.startsWith('~/') ? resolve(root, path.slice(2)) : resolve(root, path)
        let ancestor = requested
        const missing: string[] = []
        while (true) {
            try {
                await lstat(ancestor)
                const canonical = resolve(await realpath(ancestor), ...missing)
                const child = relative(root, canonical)
                return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith('../')) ? canonical : null
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') return null
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
                // An existing dangling link has no valid canonical target.
                if (await lstat(ancestor).then(() => true, () => false)) return null
                if (dirname(ancestor) === ancestor) return null
                missing.unshift(basename(ancestor))
                ancestor = dirname(ancestor)
            }
        }
    }
    app.use('/api/*', bodyLimit({ maxSize: 72 * 1024 * 1024 }))
    app.use('/api/*', async (c, next) => {
        const origin = c.req.header('Origin')
        if (origin && origin !== options.origin) return c.json({ error: 'Origin not allowed' }, 403)
        c.header('Cache-Control', 'no-store')
        if (c.req.path === '/api/auth') return next()
        const bearer = c.req.header('Authorization')?.replace(/^Bearer /, '')
        const token = bearer ?? (c.req.path === '/api/events' ? c.req.query('token') : undefined)
        if (!token) return c.json({ error: 'Authentication required' }, 401)
        try {
            await jwtVerify(token, options.jwtSecret, { algorithms: ['HS256'], issuer: options.origin, audience: 'hapi-share' })
        } catch { return c.json({ error: 'Invalid token' }, 401) }
        return next()
    })
    app.post('/api/auth', async c => {
        const body = await c.req.json().catch(() => null)
        if (typeof body?.accessToken !== 'string' || !sameSecret(body.accessToken, options.accessToken)) return c.json({ error: 'Invalid access token' }, 401)
        const token = await new SignJWT({ uid: 1, ns: 'training' }).setProtectedHeader({ alg: 'HS256' })
            .setIssuer(options.origin).setAudience('hapi-share').setIssuedAt().setExpirationTime('4h').sign(options.jwtSecret)
        return c.json({ token, user: { id: 1, firstName: 'OpenHarmony Training' } })
    })

    let cached: { at: number; sessions: Session[] } | undefined
    async function sessions(): Promise<Session[]> {
        if (cached && Date.now() - cached.at < 500) return cached.sessions
        const response = await options.upstream('/api/sessions')
        if (!response.ok) throw new Error('Session source unavailable')
        const data = await response.json() as { sessions: Session[] }
        const allowed = await Promise.all(data.sessions.map(async session =>
            session.metadata?.machineId && session.metadata?.path && await within(session.metadata.machineId, session.metadata.path) ? publicSession(session) : null))
        const filtered = allowed.filter((session): session is Session => session !== null)
        cached = { at: Date.now(), sessions: filtered }
        return filtered
    }
    async function allowedSession(id: string): Promise<Session | null> {
        const response = await options.upstream(`/api/sessions/${encodeURIComponent(id)}`)
        if (!response.ok) return null
        const { session } = await response.json() as { session: Session }
        return session.metadata?.machineId && session.metadata?.path && await within(session.metadata.machineId, session.metadata.path) ? publicSession(session) : null
    }
    async function scopedPath(session: Session, path: string): Promise<boolean> {
        if (db.query('SELECT 1 FROM shared_uploads WHERE session_id=? AND path=?').get(session.id, path)) return true
        return within(session.metadata!.machineId!, pathOps(session.metadata!.machineId!).resolve(session.metadata!.path!, path))
    }
    async function sharedArtifact(session: Session, id: string): Promise<boolean> {
        if (id.startsWith('session-file:')) return scopedPath(session, Buffer.from(id.slice('session-file:'.length), 'base64url').toString('utf8'))
        if (!id.startsWith('codex-artifact:')) return false
        try {
            const locator = JSON.parse(Buffer.from(id.slice('codex-artifact:'.length), 'base64url').toString('utf8'))
            // Native resources are conversation content, not arbitrary file reads.
            // The Runner resolves the recorded item and validates its resource index.
            return typeof session.metadata?.codexSessionId === 'string' && locator?.threadId === session.metadata.codexSessionId
        } catch { return false }
    }
    app.get('/health', c => c.json({ status: 'ok', protocolVersion: PROTOCOL_VERSION,
        capabilities: { workGraph: false, titleSuggestion: false }, scope: 'openharmony-training' }))
    app.get('/api/sessions', async c => {
        const allowed = await sessions()
        const readStates = Object.fromEntries(allowed.flatMap(session => {
            const row = db.query('SELECT state FROM shared_read_states WHERE id=?').get(session.id) as { state: string } | null
            return row ? [[session.id, JSON.parse(row.state)]] : []
        }))
        return c.json({ sessions: allowed, readStates })
    })
    app.get('/api/machines', async c => c.json({ machines: await sharedMachines(c.req.query('includeOffline') === 'true') }))
    app.use('/api/machines/:id/*', async (c, next) => {
        if (!roots.has(c.req.param('id'))) return c.json({ error: 'Machine not shared' }, 404)
        return next()
    })
    app.get('/api/machines/:id/agent-availability', async c => {
        const response = await options.upstream(`/api/machines/${encodeURIComponent(c.req.param('id'))}/agent-availability`)
        if (!response.ok) return response
        const data = await response.json() as AgentAvailabilityResponse
        return c.json({ agents: data.agents.filter(entry => entry.agent === 'codex') })
    })
    app.post('/api/machines/:id/paths/exists', async c => {
        const parsed = MachinePathsExistsRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        const exists: Record<string, boolean> = {}, outsideWorkspaceRoots: string[] = []
        for (const path of new Set(parsed.data.paths)) {
            const canonical = await projectPath(path, c.req.param('id'))
            exists[path] = canonical ? c.req.param('id') === options.machineId ? await stat(canonical).then(() => true, () => false) : (await options.resolveRemotePath!(c.req.param('id'), canonical)).exists : false
            if (!canonical) outsideWorkspaceRoots.push(path)
        }
        return c.json({ exists, outsideWorkspaceRoots })
    })
    app.post('/api/machines/:id/list-directory', async c => {
        const parsed = MachineListDirectoryRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        const path = await projectPath(parsed.data.path, c.req.param('id'))
        if (!path) return c.json({ error: 'Directory outside shared project' }, 403)
        const response = await options.upstream(`/api/machines/${encodeURIComponent(c.req.param('id'))}/list-directory`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...parsed.data, path })
        })
        if (!response.ok) return response
        const data = await response.json() as { success: boolean; entries?: MachineDirectoryEntry[]; error?: string }
        const allowed = await Promise.all((data.entries ?? []).map(async entry =>
            await within(c.req.param('id'), pathOps(c.req.param('id')).resolve(path, entry.name)) ? entry : null))
        return c.json({ ...data, entries: allowed.filter(entry => entry !== null) })
    })
    app.post('/api/machines/:id/spawn', async c => {
        const parsed = SpawnSessionRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        const directory = await projectPath(parsed.data.directory, c.req.param('id'))
        if (!directory) return c.json({ error: 'Directory outside shared project' }, 403)
        // HAPI worktrees currently live outside their project directory.
        if (parsed.data.sessionType === 'worktree') return c.json({ error: 'Worktree destination is outside shared project' }, 403)
        if ((parsed.data.agent && parsed.data.agent !== 'codex') || parsed.data.startingMode === 'pty') return c.json({ error: 'Use a project Codex session' }, 400)
        const response = await options.upstream(`/api/machines/${encodeURIComponent(c.req.param('id'))}/spawn`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...parsed.data, directory, agent: 'codex', sessionType: 'simple', startingMode: 'remote' }), signal: c.req.raw.signal
        })
        cached = undefined
        return response
    })
    app.get('/api/machines/:id/codex-models', async c => {
        const session = (await sessions()).find(session => session.metadata?.machineId === c.req.param('id'))
        if (!session) return c.json({ error: 'Machine not shared' }, 404)
        return options.upstream(`/api/sessions/${encodeURIComponent(session.id)}/codex-models`)
    })
    async function nativeSessions(search: string, cwd = root, cursor?: string, machineId = options.machineId): Promise<Response> {
        const query = new URLSearchParams({ machineId, cwd, search, limit: '100' })
        if (cursor) query.set('cursor', cursor)
        const response = await options.upstream(`/api/codex/sessions?${query}`)
        if (!response.ok) return response
        const data = await response.json() as { sessions?: CodexLocalSessionSummary[]; [key: string]: unknown }
        const allowed = await Promise.all((data.sessions ?? []).map(async session =>
            session.cwd && await within(machineId, session.cwd) ? session : null))
        return Response.json({ ...data, sessions: allowed.filter(session => session !== null) })
    }
    app.get('/api/codex/sessions', async c => {
        if (c.req.query('machineId') && !roots.has(c.req.query('machineId')!)) return c.json({ error: 'Machine not shared' }, 404)
        const machineId = c.req.query('machineId') || options.machineId
        const cwd = await projectPath(c.req.query('cwd') || scopedRoot(machineId), machineId)
        if (!cwd) return c.json({ error: 'Directory outside shared project' }, 403)
        return nativeSessions(c.req.query('search') ?? '', cwd, c.req.query('cursor'), machineId)
    })
    app.post('/api/codex/:action', async c => {
        const action = c.req.param('action')
        if (!['connect-session', 'sync-session', 'archive-session'].includes(action)) return c.json({ error: 'Operation is not shared' }, 403)
        const body = await c.req.json().catch(() => null)
        if (!body || (body.machineId && !roots.has(body.machineId))) return c.json({ error: 'Machine not shared' }, 404)
        const machineId = body.machineId || options.machineId
        const ids: unknown[] = action === 'connect-session' ? [body.threadId] : action === 'archive-session' ? [body.sessionId] : body.sessionIds
        if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some(id => typeof id !== 'string' || !id)) return c.json({ error: 'Invalid native session selection' }, 400)
        for (const id of ids as string[]) {
            const response = await nativeSessions(id, scopedRoot(machineId), undefined, machineId)
            if (!response.ok) return response
            const data = await response.json() as { sessions: CodexLocalSessionSummary[] }
            if (!data.sessions.some(session => session.id === id)) return c.json({ error: 'Session not shared' }, 404)
        }
        const cwd = await projectPath(body.cwd || scopedRoot(machineId), machineId)
        if (!cwd) return c.json({ error: 'Directory outside shared project' }, 403)
        const response = await options.upstream(`/api/codex/${action}`, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, cwd, machineId }), signal: c.req.raw.signal })
        cached = undefined
        return response
    })
    app.get('/api/voice/backend', c => c.json({ backend: null, backends: [] }))
    app.get('/api/voice/transcription/providers', c => c.json({ providers: [] }))
    app.post('/api/visibility', c => c.json({ ok: true }))
    app.get('/api/workspaces', c => c.json(workspaces.get('training')))
    app.post('/api/workspaces/operations', async c => {
        const parsed = WorkspaceUpdateRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid workspace operation' }, 400)
        const current = workspaces.get('training')
        // Validate the resulting collection, including restore/import and document bindings.
        const { applyWorkspaceCommand } = await import('@hapi/protocol/workspaces')
        const candidate = WorkspaceSnapshotSchema.safeParse({ ...current,
            workspaces: applyWorkspaceCommand(current.workspaces, parsed.data.operation.command).workspaces })
        if (!candidate.success) return c.json({ error: 'Invalid workspace' }, 400)
        for (const pane of candidate.data.workspaces.flatMap(w => panes(w.root))) {
            const resource = pane.resource
            if (resource.kind === 'empty') continue
            if (resource.kind === 'terminal') return c.json({ error: 'Terminal access is not shared' }, 403)
            const session = await allowedSession(resource.sessionId)
            if (!session) return c.json({ error: 'Session not shared' }, 404)
            if (resource.kind === 'document' && resource.document.kind === 'file'
                && !await scopedPath(session, resource.document.path)) return c.json({ error: 'File outside shared project' }, 403)
            if (resource.kind === 'document' && resource.document.kind === 'artifact'
                && !await sharedArtifact(session, resource.document.artifactId)) return c.json({ error: 'Resource is not shared' }, 403)
        }
        const result = workspaces.update('training', parsed.data)
        if (result.status === 'applied') broadcast({ type: 'workspaces-updated', revision: result.snapshot.revision })
        return c.json(result, result.status === 'conflict' ? 409 : 200)
    })
    app.get('/api/events', async c => {
        const url = new URL(c.req.url)
        const ids = [url.searchParams.get('sessionId'), ...JSON.parse(url.searchParams.get('sessionIds') ?? '[]')] as (string | null)[]
        for (const id of ids) if (id && !await allowedSession(id)) return c.json({ error: 'Session not shared' }, 404)
        const abort = new AbortController()
        c.req.raw.signal.addEventListener('abort', () => abort.abort(), { once: true })
        url.searchParams.delete('token')
        url.searchParams.delete('machineId')
        url.searchParams.set('all', 'true')
        const upstream = await options.upstream(`/api/events?${url.searchParams}`, { signal: abort.signal,
            headers: { 'Accept-Encoding': 'identity', ...(c.req.header('Last-Event-ID') ? { 'Last-Event-ID': c.req.header('Last-Event-ID')! } : {}) } })
        if (!upstream.ok || !upstream.body) return c.json({ error: 'Event source unavailable' }, 503)
        const known = new Set((await sessions()).map(session => session.id))
        let localReader: ((event: Event) => void) | undefined
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                const encoder = new TextEncoder()
                const send = (event: Event, id?: string) => controller.enqueue(encoder.encode(`${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(event)}\n\n`))
                localReader = event => send(event)
                readers.add(localReader)
                void (async () => {
                    const reader = upstream.body!.getReader(), decoder = new TextDecoder()
                    let pending = ''
                    try {
                        while (true) {
                            const chunk = await reader.read()
                            if (chunk.done) break
                            pending += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n')
                            let end: number
                            while ((end = pending.indexOf('\n\n')) !== -1) {
                                const frame = pending.slice(0, end); pending = pending.slice(end + 2)
                                const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
                                if (!data) continue
                                const event = JSON.parse(data) as Event
                                const id = frame.split('\n').find(line => line.startsWith('id:'))?.slice(3).trim()
                                if (event.type === 'heartbeat' || event.type === 'connection-changed') { send(event, id); continue }
                                if (event.type === 'machine-updated' && event.machineId && roots.has(event.machineId)) {
                                    const machine = (await sharedMachines(true)).find(machine => machine.id === event.machineId)
                                    if (machine) send({ ...event, data: machine as unknown as Record<string, unknown> }, id)
                                    continue
                                }
                                if (!event.sessionId || event.type === 'session-read-state') continue
                                if (event.type === 'session-removed') {
                                    if (known.delete(event.sessionId)) send({ type: 'session-removed', sessionId: event.sessionId }, id)
                                    cached = undefined
                                    continue
                                }
                                if (event.type === 'session-updated' || event.type === 'session-added') cached = undefined
                                const allowed = await allowedSession(event.sessionId)
                                if (!allowed) {
                                    if (known.delete(event.sessionId)) send({ type: 'session-removed', sessionId: event.sessionId }, id)
                                    continue
                                }
                                known.add(event.sessionId)
                                if ((event.type === 'session-updated' || event.type === 'session-added') && event.data) {
                                    const metadata = event.data.metadata as Record<string, unknown> | undefined
                                    if (metadata) {
                                        const clean = 'version' in metadata && 'value' in metadata
                                            ? { ...metadata, value: metadata.value === null ? null : publicSession({ id: event.sessionId, metadata: metadata.value as Session['metadata'] }).metadata }
                                            : publicSession({ id: event.sessionId, metadata: metadata as Session['metadata'] }).metadata
                                        event.data = { ...event.data, metadata: clean }
                                    }
                                }
                                send(event, id)
                            }
                        }
                        controller.close()
                    } catch { if (!abort.signal.aborted) controller.error(new Error('Event source disconnected')) }
                    finally { readers.delete(localReader!); reader.releaseLock(); abort.abort() }
                })()
            },
            cancel() { readers.delete(localReader!); abort.abort() }
        })
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } })
    })

    // Explicit routes keep new private Hub capabilities private until reviewed.
    const reads = /^(?:messages(?:\/(?:outline|dependencies|[^/]+\/context))?|export|codex-models|slash-commands|skills|scratchlist|document-preview\/[^/]+|artifacts\/[^/]+|git-status|git-diff-numstat|git-diff-file|file|file-info|directory|files)$/
    const writes = /^(?:messages(?:\/(?:queued-state|[^/]+\/(?:steer|retry)))?|abort|resume|reopen|fork|rewind|archive|clear|switch|upload(?:\/delete)?|document-preview|model|model-reasoning-effort|permission-mode|collaboration-mode|service-tier|codex\/(?:goal|plan\/implement)|permissions\/[^/]+\/(?:approve|deny))$/
    app.get('/api/sessions/:id', async c => {
        const session = await allowedSession(c.req.param('id'))
        return session ? c.json({ session }) : c.json({ error: 'Session not shared' }, 404)
    })
    app.on(['PATCH', 'DELETE'], '/api/sessions/:id', async c => {
        if (!await allowedSession(c.req.param('id'))) return c.json({ error: 'Session not shared' }, 404)
        const body = c.req.method === 'PATCH' ? await c.req.text() : undefined
        const response = await options.upstream(c.req.path, { method: c.req.method, body,
            headers: { 'Content-Type': 'application/json' }, signal: c.req.raw.signal })
        cached = undefined
        return response
    })
    app.all('/api/sessions/:id/*', async c => {
        const sessionId = c.req.param('id')
        const session = await allowedSession(sessionId)
        if (!session) return c.json({ error: 'Session not shared' }, 404)
        const route = c.req.path.split('/').slice(4).join('/')
        if (c.req.method === 'PUT' && route === 'read-state') {
            const parsed = UpdateSessionReadStateSchema.safeParse(await c.req.json().catch(() => null))
            if (!parsed.success) return c.json({ error: 'Invalid read state' }, 400)
            const old = db.query('SELECT state FROM shared_read_states WHERE id=?').get(sessionId) as { state: string } | null
            const state = old ? JSON.parse(old.state) : { version: 0, seenAt: 0, manualUnreadAt: null }
            if (parsed.data.expectedVersion !== state.version) return c.json({ applied: false, state }, 409)
            const next = { seenAt: Math.max(state.seenAt, parsed.data.seenAt), manualUnreadAt: parsed.data.manualUnreadAt, version: state.version + 1 }
            db.query('INSERT INTO shared_read_states VALUES (?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(sessionId, JSON.stringify(next))
            broadcast({ type: 'session-read-state', sessionId, userId: 1, state: next })
            return c.json({ applied: true, state: next })
        }
        if (!(c.req.method === 'GET' && reads.test(route)) && !(c.req.method === 'POST' && writes.test(route))
            && !(c.req.method === 'PUT' && (route === 'file' || route === 'pin'))
            && !(c.req.method === 'PATCH' && route === 'summary')
            && !(c.req.method === 'DELETE' && /^messages\/[^/]+$/.test(route))) return c.json({ error: 'Operation is not shared' }, 403)
        if (c.req.method === 'GET' && ['file', 'file-info', 'directory', 'git-diff-file'].includes(route)
            && !await scopedPath(session, c.req.query('path') ?? '.')) return c.json({ error: 'File outside shared project' }, 403)
        if (route.startsWith('artifacts/') && !await sharedArtifact(session, decodeURIComponent(route.slice('artifacts/'.length)))) return c.json({ error: 'Resource is not shared' }, 403)
        let body: string | undefined
        if (['POST', 'PUT', 'PATCH'].includes(c.req.method)) {
            const json = await c.req.json().catch(() => null)
            if (route === 'file' && (typeof json?.path !== 'string' || !await scopedPath(session, json.path))) return c.json({ error: 'File outside shared project' }, 403)
            if (route === 'upload/delete' && (typeof json?.path !== 'string' || !db.query('SELECT 1 FROM shared_uploads WHERE session_id=? AND path=?').get(sessionId, json.path))) return c.json({ error: 'Attachment is not shared' }, 403)
            if (route === 'document-preview') {
                const ref = json?.document
                const allowed = ref?.kind === 'file' && typeof ref.path === 'string' ? await scopedPath(session, ref.path)
                    : ref?.kind === 'artifact' && typeof ref.artifactId === 'string' ? await sharedArtifact(session, ref.artifactId) : false
                if (!allowed) return c.json({ error: 'Document outside shared project' }, 403)
            }
            if (Array.isArray(json?.attachments)) {
                for (const attachment of json.attachments) {
                    if (typeof attachment.path !== 'string' || !db.query('SELECT 1 FROM shared_uploads WHERE session_id=? AND path=?').get(sessionId, attachment.path)) return c.json({ error: 'Attachment is not shared' }, 403)
                }
            }
            body = JSON.stringify(json)
        }
        const url = new URL(c.req.url)
        url.searchParams.delete('token')
        const response = await options.upstream(url.pathname + url.search, { method: c.req.method, body,
            headers: { 'Content-Type': 'application/json', ...(c.req.header('Range') ? { Range: c.req.header('Range')! } : {}) }, signal: c.req.raw.signal })
        if (route === 'upload' && response.ok) {
            const result = await response.clone().json() as { path?: string }
            if (result.path) db.query('INSERT OR IGNORE INTO shared_uploads VALUES (?,?)').run(sessionId, result.path)
        }
        return response
    })
    app.all('/api/*', c => c.json({ error: 'Operation is not shared' }, 403))
    app.onError((error, c) => {
        console.error('[hapi-share]', error.message)
        return c.json({ error: 'Shared service temporarily unavailable' }, 503)
    })
    return app
}
