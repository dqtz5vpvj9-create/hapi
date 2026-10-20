import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { createScopedGateway } from './scopedGateway'

let directory: string, root: string, token: string
const calls: { path: string; method?: string; range: string | null; body?: unknown }[] = []
const origin = 'https://hapi-share.example.org'
let app: Awaited<ReturnType<typeof createScopedGateway>>
const db = new Database(':memory:')
beforeAll(async () => {
    directory = await mkdtemp('/mnt/cache/data-cache/hapi-sharing-test-')
    root = `${directory}/training`
    await mkdir(root)
    await mkdir(`${directory}/training-private`)
    await writeFile(`${root}/README.md`, 'Project notes')
    await writeFile(`${directory}/secret`, 'private')
    await symlink(`${directory}/secret`, `${root}/outside-link`)
    const sessions = [{ id: 'allowed', metadata: { path: root, machineId: 'local', codexSessionId: 'native-shared', codexStoreId: '/private/codex' } },
        { id: 'private', metadata: { path: `${directory}/training-private`, machineId: 'local' } },
        { id: 'other-machine', metadata: { path: root, machineId: 'remote' } }]
    app = await createScopedGateway({ root, machineId: 'local', origin, accessToken: 'classroom-access-token', jwtSecret: new TextEncoder().encode('sharing-test-secret'), database: db,
        upstream: async (path, init) => {
            calls.push({ path, method: init?.method, range: new Headers(init?.headers).get('Range'), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
            if (path.startsWith('/api/machines?') || path === '/api/machines') return Response.json({ machines: [
                { id: 'local', active: true, namespace: 'owner', metadata: { host: 'Local', platform: 'linux', happyCliVersion: '1', homeDir: directory,
                    happyHomeDir: '/private/hapi', capabilities: ['agent-availability', 'machine-terminal', 'stop-runner'] }, runnerState: { pid: 123 } },
                { id: 'remote', active: true, metadata: { homeDir: '/private' } }
            ] })
            if (path === '/api/machines/local/agent-availability') return Response.json({ agents: [
                { agent: 'codex', available: true }, { agent: 'claude', available: true }
            ] })
            if (path === '/api/machines/local/spawn') return Response.json({ type: 'success', sessionId: 'allowed' })
            if (path.startsWith('/api/codex/sessions?')) return Response.json({ success: true, sessions: [
                { id: 'native-shared', cwd: root, title: 'Shared' }, { id: 'native-private', cwd: directory, title: 'Private' }
            ] })
            if (path === '/api/machines/local/list-directory') return Response.json({ success: true, entries: [
                { name: 'README.md', type: 'file' }, { name: 'outside-link', type: 'file' }
            ] })
            if (path === '/api/sessions') return Response.json({ sessions, readStates: { private: { seenAt: 10 } } })
            if (path.startsWith('/api/events?')) return new Response([
                { type: 'connection-changed', data: { status: 'connected' } },
                { type: 'message-received', sessionId: 'private', message: 'Private answer' },
                { type: 'message-received', sessionId: 'allowed', message: 'Shared answer' },
                { type: 'session-updated', sessionId: 'allowed', data: { metadata: { version: 3, value: { path: root, codexStoreId: '/private/codex' } } } },
                { type: 'workspaces-updated', revision: 300 },
                { type: 'machine-updated', machineId: 'private-machine', data: { homeDir: '/private' } }
            ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
            const session = sessions.find(session => path === `/api/sessions/${session.id}`)
            if (session) return Response.json({ session })
            if (path === '/api/sessions/allowed/upload') return Response.json({ success: true, path: '/uploads/owned-file.png' })
            if (path === '/api/sessions/allowed/document-preview/prepared') return new Response(new Uint8Array(1024), {
                status: 206, headers: { 'Content-Type': 'application/pdf', 'Content-Range': 'bytes 0-1023/2048', 'Accept-Ranges': 'bytes' }
            })
            return Response.json({ ok: true })
        }
    })
    const auth = await app.request('/api/auth', { method: 'POST', body: JSON.stringify({ accessToken: 'classroom-access-token' }) })
    token = (await auth.json() as { token: string }).token
})
afterAll(async () => { db.close(); await rm(directory, { recursive: true }) })
const request = (path: string, method = 'GET', body?: unknown, headers?: Record<string, string>) => app.request(path, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
})

describe('project-scoped sharing gateway', () => {
    test('requires independent authentication and rejects foreign browser origins', async () => {
        expect((await app.request('/api/sessions')).status).toBe(401)
        expect((await app.request('/api/auth', { method: 'POST', body: JSON.stringify({ accessToken: 'owner-token' }) })).status).toBe(401)
        expect((await request('/api/sessions', 'GET', undefined, { Origin: 'https://other.example.org' })).status).toBe(403)
    })
    test('lists only canonical descendants, without owner read state or store paths', async () => {
        const data = await (await request('/api/sessions')).json() as { sessions: { id: string; metadata: { codexStoreId?: string; capabilities: { terminal: boolean } } }[]; readStates: object }
        expect(data.sessions.map((session: { id: string }) => session.id)).toEqual(['allowed'])
        expect(data.readStates).toEqual({})
        expect(data.sessions[0].metadata.codexStoreId).toBeUndefined()
        expect(data.sessions[0].metadata.capabilities.terminal).toBe(false)
    })
    test('rejects direct private session URLs and writes before forwarding them', async () => {
        expect((await request('/api/sessions/allowed')).status).toBe(200)
        expect((await request('/api/sessions/private')).status).toBe(404)
        expect((await request('/api/sessions/other-machine')).status).toBe(404)
        expect((await request('/api/sessions/private/messages', 'POST', { text: 'forbidden' })).status).toBe(404)
        expect(calls.some(call => call.path === '/api/sessions/private/messages')).toBe(false)
    })
    test('allows shared messaging but blocks global controls and credentials', async () => {
        expect((await request('/api/sessions/allowed/messages', 'POST', { text: 'Shared question', localId: 'one' })).status).toBe(200)
        for (const path of ['/api/machines/id/spawn', '/api/machines/local/restart-runner', '/api/sessions/allowed/terminal', '/api/voice/transcription/credentials', '/socket.io/']) {
            expect((await request(path, 'POST', {})).status).not.toBe(200)
        }
    })
    test('shows the actual shared machine with project roots and no private installation state', async () => {
        const data = await (await request('/api/machines')).json() as { machines: { id: string; namespace: string; metadata: Record<string, unknown>; runnerState: unknown }[] }
        expect(data.machines.map(machine => machine.id)).toEqual(['local'])
        expect(data.machines[0].metadata.homeDir).toBe(root)
        expect(data.machines[0].metadata.workspaceRoots).toEqual([root])
        expect(data.machines[0].metadata.happyHomeDir).toBeUndefined()
        expect(data.machines[0].runnerState).toBeNull()
        expect(data.machines[0].namespace).toBe('training')
        expect(await (await request('/api/machines/local/agent-availability')).json()).toEqual({ agents: [{ agent: 'codex', available: true }] })
    })
    test('creates a project session and never forwards other machines, outside paths or symlink escapes', async () => {
        const before = calls.filter(call => call.path.endsWith('/spawn')).length
        for (const [machine, path] of [['remote', root], ['local', `${directory}/training-private`], ['local', `${root}/outside-link/child`], ['local', '../training-private']]) {
            expect((await request(`/api/machines/${machine}/spawn`, 'POST', { directory: path, agent: 'codex' })).status).not.toBe(200)
        }
        expect(calls.filter(call => call.path.endsWith('/spawn')).length).toBe(before)
        expect((await request('/api/machines/local/spawn', 'POST', { directory: root, agent: 'codex', model: 'test-model', permissionMode: 'yolo' })).status).toBe(200)
        expect(calls.filter(call => call.path.endsWith('/spawn')).at(-1)?.body).toEqual({ directory: root, agent: 'codex', model: 'test-model', permissionMode: 'yolo', sessionType: 'simple', startingMode: 'remote' })
        expect((await request('/api/machines/local/spawn', 'POST', { directory: `${root}/new/subdir` })).status).toBe(200)
        expect((await request('/api/machines/local/spawn', 'POST', { directory: root, startingMode: 'pty' })).status).toBe(400)
        expect((await request('/api/machines/local/spawn', 'POST', { directory: root, sessionType: 'worktree' })).status).toBe(403)
    })
    test('scopes directory browsing and existence checks, including missing children', async () => {
        const data = await (await request('/api/machines/local/paths/exists', 'POST', { paths: [root, `${root}/new`, `${directory}/secret`, `${root}/outside-link`] })).json()
        expect(data).toEqual({ exists: { [root]: true, [`${root}/new`]: false, [`${directory}/secret`]: false, [`${root}/outside-link`]: false }, outsideWorkspaceRoots: [`${directory}/secret`, `${root}/outside-link`] })
        expect((await request('/api/machines/local/list-directory', 'POST', { path: '../' })).status).toBe(403)
        const listing = await (await request('/api/machines/local/list-directory', 'POST', { path: root })).json()
        expect(listing).toEqual({ success: true, entries: [{ name: 'README.md', type: 'file' }] })
    })
    test('retains project conversation actions and text edits instead of inventing a read-only role', async () => {
        for (const action of ['fork', 'rewind', 'archive', 'clear', 'permission-mode', 'codex/goal', 'codex/plan/implement']) {
            expect((await request(`/api/sessions/allowed/${action}`, 'POST', {})).status).toBe(200)
        }
        expect((await request('/api/sessions/allowed', 'PATCH', { name: 'Renamed' })).status).toBe(200)
        expect((await request('/api/sessions/allowed', 'DELETE')).status).toBe(200)
        expect((await request('/api/sessions/private', 'DELETE')).status).toBe(404)
        expect((await request('/api/sessions/allowed/file', 'PUT', { path: 'README.md', content: 'edited' })).status).toBe(200)
        expect(calls.filter(call => call.path === '/api/sessions/allowed/file').at(-1)?.body).toEqual({ path: 'README.md', content: 'edited' })
        expect((await request('/api/sessions/allowed/file', 'PUT', { path: '../secret', content: 'edited' })).status).toBe(403)
    })
    test('allows native project history connection without exposing other project threads', async () => {
        const listing = await (await request('/api/codex/sessions?machineId=local')).json() as { sessions: { id: string }[] }
        expect(listing.sessions.map((session: { id: string }) => session.id)).toEqual(['native-shared'])
        expect((await request('/api/codex/sessions?machineId=remote')).status).toBe(404)
        expect((await request('/api/codex/connect-session', 'POST', { threadId: 'native-shared', machineId: 'local' })).status).toBe(200)
        expect((await request('/api/codex/sync-session', 'POST', { sessionIds: ['native-shared'], machineId: 'local', cwd: root })).status).toBe(200)
        for (const action of ['connect-session', 'sync-session', 'archive-session']) {
            const before = calls.filter(call => call.path === `/api/codex/${action}`).length
            expect((await request(`/api/codex/${action}`, 'POST', { threadId: 'native-private', sessionIds: ['native-private'], sessionId: 'native-private', machineId: 'local' })).status).toBe(404)
            expect(calls.filter(call => call.path === `/api/codex/${action}`).length).toBe(before)
        }
    })
    test('rejects relative traversal and symlink escapes from project files', async () => {
        expect((await request('/api/sessions/allowed/file?path=README.md')).status).toBe(200)
        for (const path of ['../secret', 'outside-link', `${directory}/secret`]) {
            expect((await request(`/api/sessions/allowed/file?path=${encodeURIComponent(path)}`)).status).toBe(403)
        }
    })
    test('authorizes document preparation before conversion and preserves PDF ranges', async () => {
        expect((await request('/api/sessions/allowed/document-preview', 'POST', { document: { kind: 'file', path: `${directory}/secret` } })).status).toBe(403)
        expect((await request('/api/sessions/allowed/document-preview', 'POST', { document: { kind: 'file', path: `${root}/README.md` } })).status).toBe(200)
        const response = await request('/api/sessions/allowed/document-preview/prepared', 'GET', undefined, { Range: 'bytes=0-1023' })
        expect(response.status).toBe(206)
        expect(response.headers.get('Content-Range')).toBe('bytes 0-1023/2048')
        expect((await response.arrayBuffer()).byteLength).toBe(1024)
        expect(calls.filter(call => call.path.endsWith('/document-preview/prepared')).at(-1)?.range).toBe('bytes=0-1023')
    })
    test('permits only attachments uploaded through the same shared session', async () => {
        const body = { text: 'image', attachments: [{ path: '/private/file' }] }
        expect((await request('/api/sessions/allowed/messages', 'POST', body)).status).toBe(403)
        expect((await request('/api/sessions/allowed/upload', 'POST', { filename: 'image.png', content: 'aGVsbG8=' })).status).toBe(200)
        body.attachments[0].path = '/uploads/owned-file.png'
        expect((await request('/api/sessions/allowed/messages', 'POST', body)).status).toBe(200)
    })
    test('allows recorded resources only from the shared native thread and scopes file-backed resource IDs', async () => {
        const artifact = (threadId: string) => `codex-artifact:${Buffer.from(JSON.stringify({ threadId, turnId: 'turn', itemId: 'item', index: 0 })).toString('base64url')}`
        const pathId = (path: string) => `session-file:${Buffer.from(path).toString('base64url')}`
        for (const id of [artifact('native-shared'), pathId(`${root}/README.md`)]) {
            expect((await request(`/api/sessions/allowed/artifacts/${encodeURIComponent(id)}`)).status).toBe(200)
            expect((await request('/api/sessions/allowed/document-preview', 'POST', { document: { kind: 'artifact', artifactId: id } })).status).toBe(200)
        }
        for (const id of [artifact('native-private'), pathId(`${directory}/secret`), pathId(`${root}/outside-link`), 'codex-artifact:invalid', 'unregistered-attachment']) {
            const path = `/api/sessions/allowed/artifacts/${encodeURIComponent(id)}`
            expect((await request(path)).status).toBe(403)
            expect(calls.some(call => call.path === path)).toBe(false)
            expect((await request('/api/sessions/allowed/document-preview', 'POST', { document: { kind: 'artifact', artifactId: id } })).status).toBe(403)
        }
    })
    test('filters private live events even when the upstream subscription requests all', async () => {
        const response = await request('/api/events?all=true')
        const stream = await response.text()
        expect(stream).toContain('Shared answer')
        expect(stream).toContain('connection-changed')
        expect(stream).not.toContain('Private answer')
        expect(stream).not.toContain('private-machine')
        expect(stream).not.toContain('workspaces-updated')
        expect(stream).toContain('"version":3,"value":')
        expect(stream).not.toContain('/private/codex')
        expect((await request('/api/events?sessionId=private')).status).toBe(404)
    })
    test('stores read cursors independently with compare-and-swap', async () => {
        const first = await request('/api/sessions/allowed/read-state', 'PUT', { expectedVersion: 0, seenAt: 123, manualUnreadAt: null })
        expect(await first.json()).toEqual({ applied: true, state: { version: 1, seenAt: 123, manualUnreadAt: null } })
        expect((await request('/api/sessions/allowed/read-state', 'PUT', { expectedVersion: 0, seenAt: 125, manualUnreadAt: null })).status).toBe(409)
        expect(calls.some(call => call.path.includes('read-state'))).toBe(false)
    })
    test('starts with a separate workspace and rejects private restore bindings', async () => {
        expect(await (await request('/api/workspaces')).json()).toEqual({ schemaVersion: 2, revision: 0, workspaces: [] })
        const body = { expectedRevision: 0, operation: { id: crypto.randomUUID(), command: { type: 'create', workspace: {
            id: 'w1', name: 'Training', root: { type: 'pane', id: 'p1', resource: { kind: 'chat', sessionId: 'private' } }
        } } } }
        expect((await request('/api/workspaces/operations', 'POST', body)).status).toBe(404)
        body.operation.id = crypto.randomUUID()
        body.operation.command.workspace.root.resource.sessionId = 'allowed'
        expect((await request('/api/workspaces/operations', 'POST', body)).status).toBe(200)
    })
})

test('shares Windows alongside Linux with machine-specific canonical boundaries', async () => {
    const winRoot = 'C:\\Users\\student\\openharmony-training'
    const localDb = new Database(':memory:')
    const forwarded: string[] = []
    const gateway = await createScopedGateway({ root, machineId: 'local', origin,
        additionalScopes: [{ machineId: 'windows', root: winRoot }],
        resolveRemotePath: async (_machineId, path) => ({ path: path.endsWith('escape') ? 'C:\\private' : path, exists: true }),
        accessToken: 'test', jwtSecret: new TextEncoder().encode('test-key'), database: localDb,
        upstream: async (path, init) => {
            forwarded.push(path)
            if (path === '/api/machines') return Response.json({ machines: [{ id: 'local', metadata: { platform: 'linux' } }, { id: 'windows', metadata: { platform: 'win32' } }, { id: 'private' }] })
            if (path === '/api/sessions') return Response.json({ sessions: [
                { id: 'linux', metadata: { machineId: 'local', path: root } },
                { id: 'win', metadata: { machineId: 'windows', path: winRoot } },
                { id: 'escape', metadata: { machineId: 'windows', path: `${winRoot}\\escape` } },
                { id: 'other', metadata: { machineId: 'windows', path: 'C:\\private' } },
            ] })
            if (path.endsWith('/spawn')) return Response.json({ ...JSON.parse(init!.body as string), type: 'success' })
            return Response.json({ success: true })
        },
    })
    const login = await gateway.request('/api/auth', { method: 'POST', body: JSON.stringify({ accessToken: 'test' }) })
    const jwt = (await login.json() as { token: string }).token
    const req = (path: string, body?: object) => gateway.request(path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    try {
        const machines = await (await req('/api/machines')).json() as any
        expect(machines.machines.map((m: any) => m.id)).toEqual(['local', 'windows'])
        expect(machines.machines[1].metadata.workspaceRoots).toEqual([winRoot])
        expect((await (await req('/api/sessions')).json() as any).sessions.map((s: any) => s.id)).toEqual(['linux', 'win'])
        const spawn = await req('/api/machines/windows/spawn', { directory: '~', agent: 'codex' })
        expect(spawn.status).toBe(200)
        expect((await spawn.json() as any).directory).toBe(winRoot)
        expect(forwarded).toContain('/api/machines/windows/spawn')
        for (const directory of ['C:\\private', `${winRoot}\\..\\private`, `${winRoot}\\escape`]) {
            expect((await req('/api/machines/windows/spawn', { directory, agent: 'codex' })).status).toBe(403)
        }
        expect((await req('/api/machines/windows/terminal', {})).status).toBe(403)
    } finally { localDb.close() }
})
