import { createRequire } from 'node:module'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
function openDb(path: string) {
    const db = new DatabaseSync(path)
    return { query: (sql: string) => db.prepare(sql), exec: (sql: string) => db.exec(sql), close: () => db.close() }
}
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateNativeThread, planNativeThreadMigration, recoverInterruptedTransfers } from './nativeThreadMigration'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function createHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'hapi-native-transfer-'))
    roots.push(home)
    return home
}

function schema(db: ReturnType<typeof openDb>) {
    db.exec(`CREATE TABLE _sqlx_migrations (version INTEGER PRIMARY KEY, description TEXT, success INTEGER);
        INSERT INTO _sqlx_migrations VALUES (1, 'init', 1);
        CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT, cwd TEXT, title TEXT, model TEXT, history_mode TEXT);
        CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT, PRIMARY KEY(thread_id, turn_id));
        CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER, item_type TEXT, item_json TEXT, PRIMARY KEY(thread_id, turn_id, item_id));
        CREATE TABLE thread_realtime_items (thread_id TEXT, item_id TEXT, rollout_ordinal INTEGER, item_type TEXT, item_json TEXT, PRIMARY KEY(thread_id, item_id));
        CREATE TABLE thread_history_projection_state (thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER, next_rollout_ordinal INTEGER);
        CREATE TABLE thread_dynamic_tools (thread_id TEXT, position INTEGER, name TEXT, description TEXT, input_schema TEXT, PRIMARY KEY(thread_id, position));`)
}

async function fixture() {
    const source = await createHome(); const target = await createHome()
    const sourceDb = join(source, 'state_5.sqlite'); const sourceHistory = join(source, 'thread_history_1.sqlite')
    const targetDb = join(target, 'state_5.sqlite'); const targetHistory = join(target, 'thread_history_1.sqlite')
    for (const [path, history] of [[sourceDb, sourceHistory], [targetDb, targetHistory]]) {
        const db = openDb(path); schema(db); db.close()
        const h = openDb(history); schema(h); h.close()
    }
    const threadId = 'thread-a'
    const rolloutRel = 'sessions/2026/01/01/rollout-' + threadId + '.jsonl'
    const rolloutPath = join(source, rolloutRel)
    await mkdir(join(source, 'sessions/2026/01/01'), { recursive: true })
    await writeFile(rolloutPath, JSON.stringify({ type: 'session_meta', payload: { id: threadId, session_id: threadId, model_provider: 'ipads', history_mode: 'legacy' } }) + '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hello' } }) + '\n')
    const db = openDb(sourceDb)
    db.query('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)').run(threadId, rolloutPath, 'ipads', '/tmp', 'hello', 'gpt', 'legacy')
    db.query('INSERT INTO thread_dynamic_tools VALUES (?, ?, ?, ?, ?)').run(threadId, 0, 'tool', 'desc', '{}')
    db.close()
    const h = openDb(sourceHistory)
    h.query('INSERT INTO thread_turns VALUES (?, ?, ?, ?)').run(threadId, 'turn-a', 1, 'completed')
    h.query('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?)').run(threadId, 'turn-a', 'item-a', 1, 'userMessage', '{}')
    h.query('INSERT INTO thread_history_projection_state VALUES (?, ?, ?)').run(threadId, 100, 2)
    h.close()
    const existing = openDb(targetDb)
    existing.query('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)').run('other', join(target, 'sessions/other.jsonl'), 'ipads', '/tmp', 'other', 'gpt', 'legacy')
    existing.close()
    return { source, target, threadId, sourceDb, targetDb, sourceHistory, targetHistory, rolloutPath }
}

describe('native thread migration', () => {
    it('copies one thread, its rows, lineage and rollout without touching other threads', async () => {
        const f = await fixture()
        const plan = await planNativeThreadMigration({ sourceHome: f.source, targetHome: f.target, threadId: f.threadId, requireWal: false })
        expect(plan.rollouts[0].target).toBe('sessions/2026/01/01/rollout-thread-a.jsonl')
        const result = await migrateNativeThread({ sourceHome: f.source, targetHome: f.target, threadId: f.threadId, journalRoot: join(f.target, 'journal'), validate: false, useWriterLocks: false, requireWal: false })
        expect(result.plan.threadId).toBe(f.threadId)
        const target = openDb(f.targetDb)
        expect((target.query('SELECT COUNT(*) AS n FROM threads').get() as { n: number }).n).toBe(2)
        expect((target.query('SELECT rollout_path FROM threads WHERE id = ?').get(f.threadId) as { rollout_path: string }).rollout_path).toContain(f.target)
        target.close()
        const history = openDb(f.targetHistory)
        expect((history.query('SELECT COUNT(*) AS n FROM thread_items WHERE thread_id = ?').get(f.threadId) as { n: number }).n).toBe(1)
        history.close()
    })

    it('copies history_base ancestors with the current rollout', async () => {
        const f = await fixture()
        const baseId = 'rollout-base'
        const baseRel = 'sessions/2026/01/01/rollout-' + baseId + '.jsonl'
        const basePath = join(f.source, baseRel)
        await writeFile(basePath, JSON.stringify({ ordinal: 0, type: 'session_meta', payload: { id: baseId, session_id: baseId } }) + '\n')
        const current = readFileSync(f.rolloutPath, 'utf8').split('\n')
        current[0] = JSON.stringify({ type: 'session_meta', payload: { id: f.threadId, session_id: f.threadId, history_mode: 'paginated', history_base: { thread_id: baseId, end_ordinal_exclusive: 1, end_byte_offset: statSync(basePath).size } } })
        await writeFile(f.rolloutPath, current.join('\n'))
        const plan = await planNativeThreadMigration({ sourceHome: f.source, targetHome: f.target, threadId: f.threadId, requireWal: false })
        expect(plan.rollouts.map(item => item.role)).toEqual(['current', 'ancestor'])
        await migrateNativeThread({ sourceHome: f.source, targetHome: f.target, threadId: f.threadId, journalRoot: join(f.target, 'journal'), validate: false, useWriterLocks: false, requireWal: false })
        expect(existsSync(join(f.target, baseRel))).toBe(true)
    })

    it('moves paginated history keyed by a distinct rollout id', async () => {
        const f = await fixture()
        const rolloutId = '11111111-2222-4333-8444-555555555555'
        const rel = 'sessions/2026/01/01/rollout-' + rolloutId + '.jsonl'
        const next = join(f.source, rel)
        await rename(f.rolloutPath, next)
        const db = openDb(f.sourceDb)
        db.query('UPDATE threads SET rollout_path = ? WHERE id = ?').run(next, f.threadId)
        db.close()
        const meta = JSON.parse(readFileSync(next, 'utf8').split('\n')[0])
        meta.payload.id = f.threadId
        meta.payload.session_id = f.threadId
        meta.payload.history_mode = 'paginated'
        await writeFile(next, JSON.stringify(meta) + '\n')
        const history = openDb(f.sourceHistory)
        history.query('UPDATE thread_items SET thread_id = ? WHERE thread_id = ?').run(rolloutId, f.threadId)
        history.query('UPDATE thread_turns SET thread_id = ? WHERE thread_id = ?').run(rolloutId, f.threadId)
        history.close()
        const plan = await planNativeThreadMigration({ sourceHome: f.source, targetHome: f.target, threadId: f.threadId, requireWal: false })
        expect(plan.historyKeys).toContain(rolloutId)
        await migrateNativeThread({ sourceHome: f.source, targetHome: f.target, threadId: f.threadId, journalRoot: join(f.target, 'journal'), validate: false, useWriterLocks: false, requireWal: false })
        const target = openDb(f.targetHistory)
        expect((target.query('SELECT COUNT(*) AS n FROM thread_items WHERE thread_id = ?').get(rolloutId) as { n: number }).n).toBe(1)
        target.close()
    })

    it('cleans a crashed pre-publish transfer and leaves the journal failed', async () => {
        const f = await fixture()
        const plan = await planNativeThreadMigration({ sourceHome: f.source, targetHome: f.target, threadId: f.threadId, requireWal: false })
        const journalRoot = join(f.target, 'journal')
        const targetFile = join(f.target, plan.rollouts[0].target)
        await mkdir(join(f.target, 'sessions/2026/01/01'), { recursive: true })
        await writeFile(targetFile, 'staged')
        const history = openDb(f.targetHistory)
        history.query('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?)').run(f.threadId, 'turn-a', 'item-a', 1, 'userMessage', '{}')
        history.close()
        await mkdir(journalRoot, { recursive: true })
        await writeFile(join(journalRoot, 'crash.json'), JSON.stringify({
            version: 1, transferId: 'crash', threadId: f.threadId, sourceHome: f.source, targetHome: f.target,
            status: 'history-imported', targetRollout: targetFile, files: [], targetFiles: [targetFile],
            historyKeys: [f.threadId], targetDb: f.targetDb, targetHistoryDb: f.targetHistory, createdAt: 0, updatedAt: 0,
        }))
        expect(await recoverInterruptedTransfers(journalRoot)).toBe(1)
        expect(existsSync(targetFile)).toBe(false)
        const check = openDb(f.targetHistory)
        expect((check.query('SELECT COUNT(*) AS n FROM thread_items WHERE thread_id = ?').get(f.threadId) as { n: number }).n).toBe(0)
        check.close()
    })

    it('does not let an old failed journal erase a later successful transfer', async () => {
        const f = await fixture()
        const journalRoot = join(f.target, 'journal')
        await migrateNativeThread({ sourceHome: f.source, targetHome: f.target, threadId: f.threadId, journalRoot, validate: false, useWriterLocks: false, requireWal: false })
        await writeFile(join(journalRoot, 'old-failed.json'), JSON.stringify({
            version: 1, transferId: 'old-failed', threadId: f.threadId, sourceHome: f.source, targetHome: f.target,
            status: 'failed', targetRollout: join(f.target, 'sessions/2026/01/01/rollout-thread-a.jsonl'), files: [],
            targetFiles: [], historyKeys: [f.threadId], targetDb: f.targetDb, targetHistoryDb: f.targetHistory,
            createdAt: 1, updatedAt: 0,
        }))
        expect(await recoverInterruptedTransfers(journalRoot)).toBe(0)
        const target = openDb(f.targetDb)
        expect(target.query('SELECT COUNT(*) AS n FROM threads WHERE id = ?').get(f.threadId)).toEqual({ n: 1 })
        target.close()
        const history = openDb(f.targetHistory)
        expect(history.query('SELECT COUNT(*) AS n FROM thread_items WHERE thread_id = ?').get(f.threadId)).toEqual({ n: 1 })
        history.close()
        expect(existsSync(join(f.target, 'sessions/2026/01/01/rollout-thread-a.jsonl'))).toBe(true)
    })

    it('applies provider and model updates to the published thread row', async () => {
        const f = await fixture()
        await migrateNativeThread({ sourceHome: f.source, targetHome: f.target, threadId: f.threadId,
            targetProvider: 'other', targetModel: 'gpt-6-astra', allowCrossProvider: true,
            journalRoot: join(f.target, 'journal'), validate: false, useWriterLocks: false, requireWal: false })
        const target = openDb(f.targetDb)
        expect(target.query('SELECT model_provider, model FROM threads WHERE id = ?').get(f.threadId))
            .toEqual({ model_provider: 'other', model: 'gpt-6-astra' })
        target.close()
    })

    it('refuses an existing target thread id', async () => {
        const f = await fixture()
        const db = openDb(f.targetDb)
        db.query('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)').run(f.threadId, '/tmp/x', 'ipads', '/tmp', 'dup', 'gpt', 'legacy')
        db.close()
        await expect(planNativeThreadMigration({ sourceHome: f.source, targetHome: f.target, threadId: f.threadId, requireWal: false }))
            .rejects.toThrow('already contains thread')
    })
})
