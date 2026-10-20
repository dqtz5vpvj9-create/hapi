import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { zstdCompressSync } from 'node:zlib'
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexAppServerClient } from '../codexAppServerClient'
import { initializeSharedClient } from '../shared/launch'
import { migrateNativeThread } from './nativeThreadMigration'
import { record } from '../shared/gateway'

const roots: string[] = []
const servers: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.close()))
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function mockModel(counter: { requests: number }) {
    const server = createServer((request, response) => {
        const chunks: Buffer[] = []
        request.on('data', chunk => chunks.push(Buffer.from(chunk)))
        request.on('end', () => {
            if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return }
            counter.requests += 1
            const id = randomUUID()
            const events = [
                { type: 'response.created', response: { id } },
                { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text: 'MIGRATED ANSWER' }] } },
                { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
            ]
            response.writeHead(200, { 'Content-Type': 'text/event-stream' })
            response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
        })
    })
    return new Promise<{ port: number; close(): Promise<void> }>(resolve => {
        server.listen(0, '127.0.0.1', () => resolve({
            port: (server.address() as { port: number }).port,
            close: () => new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())),
        }))
    })
}

async function homeWithConfig(provider: string, port: number, cwd: string): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), `hapi-migrate-${provider}-`)); roots.push(home)
    await mkdir(cwd, { recursive: true })
    await writeFile(join(home, 'config.toml'), `model = "mock-model"
model_provider = "${provider}"
approval_policy = "never"
sandbox_mode = "read-only"
check_for_update_on_startup = false
[model_providers.${provider}]
name = "Mock ${provider}"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
[analytics]
enabled = false
[feedback]
enabled = false
[projects."${cwd}"]
trust_level = "trusted"
`)
    return home
}

async function client(home: string, cwd: string): Promise<CodexAppServerClient> {
    const value = new CodexAppServerClient({ cwd, codexHome: home })
    await value.connect(); await initializeSharedClient(value); return value
}

describe.skipIf(process.env.HAPI_RUN_NATIVE_MIGRATION_TESTS !== '1')('native migration with installed Codex', () => {
    it('migrates a legacy thread and resumes it in the target home for a new turn', async () => {
        const count = { requests: 0 }; const model = await mockModel(count); servers.push(model)
        const base = await mkdtemp(join(tmpdir(), 'hapi-migrate-work-')); roots.push(base)
        const cwd = join(base, 'work'); await mkdir(cwd)
        const sourceHome = await homeWithConfig('mock', model.port, cwd)
        const targetHome = await homeWithConfig('mock', model.port, cwd)
        const source = await client(sourceHome, cwd)
        const started = record(await source.request('thread/start', { cwd }))
        const threadId = String(record(started.thread).id)
        await source.request('turn/start', { threadId, input: [{ type: 'text', text: 'say MIGRATED ANSWER', text_elements: [] }] })
        await vi.waitFor(async () => expect(count.requests).toBeGreaterThan(0), { timeout: 20_000 })
        await source.disconnect()
        const rolloutPath = String(record(started.thread).path)
        const rolloutText = await readFile(rolloutPath)
        const compressed = `${rolloutPath}.zst`
        await writeFile(compressed, zstdCompressSync(rolloutText))
        await rm(rolloutPath)
        const sourceDb = new DatabaseSync(join(sourceHome, 'state_5.sqlite'))
        sourceDb.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(compressed, threadId)
        sourceDb.close()
        // Initialize target DBs without keeping an app-server alive.
        const targetInit = await client(targetHome, cwd)
        const warm = record(await targetInit.request('thread/start', { cwd }))
        const warmId = String(record(warm.thread).id)
        await targetInit.request('turn/start', { threadId: warmId, input: [{ type: 'text', text: 'warm history', text_elements: [] }] })
        await vi.waitFor(() => expect(count.requests).toBeGreaterThan(0), { timeout: 20_000 })
        await targetInit.request('thread/delete', { threadId: warmId }).catch(() => {})
        await targetInit.disconnect()
        const result = await migrateNativeThread({ sourceHome, targetHome, threadId, targetProvider: 'mock', validate: true, useWriterLocks: false })
        expect(result.plan.threadId).toBe(threadId)
        const target = await client(targetHome, cwd)
        await target.request('thread/resume', { threadId })
        const before = count.requests
        await target.request('turn/start', { threadId, input: [{ type: 'text', text: 'continue', text_elements: [] }] })
        await vi.waitFor(() => expect(count.requests).toBeGreaterThan(before), { timeout: 20_000 })
        await target.disconnect()
    }, 60_000)

    it('migrates a paginated reverted thread with its retained history', async () => {
        const count = { requests: 0 }; const model = await mockModel(count); servers.push(model)
        const base = await mkdtemp(join(tmpdir(), 'hapi-migrate-work-')); roots.push(base)
        const cwd = join(base, 'work'); await mkdir(cwd)
        const sourceHome = await homeWithConfig('mock', model.port, cwd)
        const targetHome = await homeWithConfig('mock', model.port, cwd)
        const source = await client(sourceHome, cwd)
        const started = record(await source.request('thread/start', { cwd, historyMode: 'paginated' }))
        const threadId = String(record(started.thread).id)
        await source.request('turn/start', { threadId, input: [{ type: 'text', text: 'first', text_elements: [] }] })
        await vi.waitFor(() => expect(count.requests).toBeGreaterThan(0), { timeout: 20_000 })
        const second = record(await source.request('turn/start', { threadId, input: [{ type: 'text', text: 'second', text_elements: [] }] }))
        await vi.waitFor(() => expect(count.requests).toBeGreaterThan(1), { timeout: 20_000 })
        const secondTurn = String(record(second.turn).id)
        await source.request('thread/revert', { threadId, beforeTurnId: secondTurn })
        const sourceTurns = record(await source.request('thread/turns/list', { threadId }))
        expect((Array.isArray(sourceTurns.data) ? sourceTurns.data.length : 0)).toBeGreaterThan(0)
        await source.disconnect()
        const targetInit = await client(targetHome, cwd)
        const warm = record(await targetInit.request('thread/start', { cwd }))
        const warmId = String(record(warm.thread).id)
        await targetInit.request('turn/start', { threadId: warmId, input: [{ type: 'text', text: 'warm history', text_elements: [] }] })
        await vi.waitFor(() => expect(count.requests).toBeGreaterThan(2), { timeout: 20_000 })
        await targetInit.request('thread/delete', { threadId: warmId }).catch(() => {})
        await targetInit.disconnect()
        await migrateNativeThread({ sourceHome, targetHome, threadId, targetProvider: 'mock', validate: true, useWriterLocks: false })
        const target = await client(targetHome, cwd)
        const resumed = record(await target.request('thread/resume', { threadId }))
        expect(String(record(resumed.thread).id)).toBe(threadId)
        await vi.waitFor(async () => {
            const turns = record(await target.request('thread/turns/list', { threadId }))
            expect((Array.isArray(turns.data) ? turns.data.length : 0)).toBeGreaterThan(0)
        }, { timeout: 40_000 })
        const before = count.requests
        await target.request('turn/start', { threadId, input: [{ type: 'text', text: 'continue after revert', text_elements: [] }] })
        await vi.waitFor(() => expect(count.requests).toBeGreaterThan(before), { timeout: 20_000 })
        await target.disconnect()
    }, 90_000)



    it('cross-provider rebind with resume override and validation', async () => {
        const count = { requests: 0 }; const model = await mockModel(count); servers.push(model)
        const base = await mkdtemp(join(tmpdir(), 'hapi-migrate-work-')); roots.push(base)
        const cwd = join(base, 'work'); await mkdir(cwd)
        const sourceHome = await homeWithConfig('mock-source', model.port, cwd)
        const targetHome = await homeWithConfig('mock-target', model.port, cwd)
        const source = await client(sourceHome, cwd)
        const started = record(await source.request('thread/start', { cwd }))
        const threadId = String(record(started.thread).id)
        await source.request('turn/start', { threadId, input: [{ type: 'text', text: 'source', text_elements: [] }] })
        await vi.waitFor(() => expect(count.requests).toBeGreaterThan(0), { timeout: 20_000 })
        await source.disconnect()
        const targetInit = await client(targetHome, cwd)
        const warm = record(await targetInit.request('thread/start', { cwd }))
        const warmId = String(record(warm.thread).id)
        await targetInit.request('turn/start', { threadId: warmId, input: [{ type: 'text', text: 'warm', text_elements: [] }] })
        await vi.waitFor(() => expect(count.requests).toBeGreaterThan(1), { timeout: 20_000 })
        await targetInit.request('thread/delete', { threadId: warmId }).catch(() => {})
        await targetInit.disconnect()
        await migrateNativeThread({ sourceHome, targetHome, threadId, targetProvider: 'mock-target', targetModel: 'mock-model', allowCrossProvider: true, validate: true, useWriterLocks: false })
        const rowDb = new DatabaseSync(join(targetHome, 'state_5.sqlite'))
        const bound = rowDb.prepare('SELECT model_provider, model FROM threads WHERE id = ?').get(threadId) as { model_provider?: string; model?: string }
        rowDb.close()
        expect(bound.model_provider).toBe('mock-target')
        expect(bound.model).toBe('mock-model')
        const target = await client(targetHome, cwd)
        await target.request('thread/resume', { threadId, modelProvider: 'mock-target', model: 'mock-model' })
        const before = count.requests
        await target.request('turn/start', { threadId, input: [{ type: 'text', text: 'target', text_elements: [] }] })
        await vi.waitFor(() => expect(count.requests).toBeGreaterThan(before), { timeout: 20_000 })
        await target.disconnect()
    }, 90_000)

    it('migrates a forked thread', async () => {
        const count = { requests: 0 }; const model = await mockModel(count); servers.push(model)
        const base = await mkdtemp(join(tmpdir(), 'hapi-migrate-work-')); roots.push(base)
        const cwd = join(base, 'work'); await mkdir(cwd)
        const sourceHome = await homeWithConfig('mock', model.port, cwd)
        const targetHome = await homeWithConfig('mock', model.port, cwd)
        const source = await client(sourceHome, cwd)
        const started = record(await source.request('thread/start', { cwd }))
        const parentId = String(record(started.thread).id)
        await source.request('turn/start', { threadId: parentId, input: [{ type: 'text', text: 'parent', text_elements: [] }] })
        await vi.waitFor(() => expect(count.requests).toBeGreaterThan(0), { timeout: 20_000 })
        const forked = record(await source.request('thread/fork', { threadId: parentId }))
        const threadId = String(record(forked.thread).id)
        await source.disconnect()
        const targetInit = await client(targetHome, cwd)
        const warm = record(await targetInit.request('thread/start', { cwd }))
        const warmId = String(record(warm.thread).id)
        await targetInit.request('turn/start', { threadId: warmId, input: [{ type: 'text', text: 'warm', text_elements: [] }] })
        await vi.waitFor(() => expect(count.requests).toBeGreaterThan(1), { timeout: 20_000 })
        await targetInit.request('thread/delete', { threadId: warmId }).catch(() => {})
        await targetInit.disconnect()
        await migrateNativeThread({ sourceHome, targetHome, threadId, targetProvider: 'mock', validate: true, useWriterLocks: false })
        const target = await client(targetHome, cwd)
        await target.request('thread/resume', { threadId })
        const before = count.requests
        await target.request('turn/start', { threadId, input: [{ type: 'text', text: 'forked continue', text_elements: [] }] })
        await vi.waitFor(() => expect(count.requests).toBeGreaterThan(before), { timeout: 20_000 })
        await target.disconnect()
    }, 90_000)
})
