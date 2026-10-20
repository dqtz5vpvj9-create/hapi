import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { acquireCodexWriterLock, type CodexWriterLock } from './codexWriterLock'

type Statement = { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown }
type Database = { query(sql: string): Statement; exec(sql: string): void; close(): void }

export type NativeThreadMigrationOptions = {
    sourceHome: string
    targetHome: string
    threadId: string
    /** Target provider id; when set, the copied thread is rebound to it. */
    targetProvider?: string
    targetModel?: string
    /** Allow experimental provider rebinding (not yet production-safe). */
    allowCrossProvider?: boolean
    /** Start a temporary target app-server and verify thread/read or resume. */
    validate?: boolean
    /** Use Codex's cross-process thread writer lock protocol. Default true. */
    useWriterLocks?: boolean
    /** Online import requires WAL on the target. Default true. */
    requireWal?: boolean
    /** Defaults to HAPI_HOME/codex-thread-transfers. */
    journalRoot?: string
    dryRun?: boolean
}

export type NativeThreadPlan = {
    threadId: string
    sourceHome: string
    targetHome: string
    sourceDb: string
    sourceHistoryDb: string
    targetDb: string
    targetHistoryDb: string
    threadRow: Record<string, unknown>
    rollouts: Array<{ source: string; target: string; role: 'current' | 'ancestor' }>
    rowCounts: Record<string, number>
    historyKeys: string[]
    historyMode: string
    resumeProvider?: string
    resumeModel?: string
    warnings: string[]
}

type TransferState = {
    version: 1
    transferId: string
    threadId: string
    sourceHome: string
    targetHome: string
    status: 'preparing' | 'source-frozen' | 'files-staged' | 'history-imported' | 'published' | 'validated' | 'failed' | 'superseded'
    targetRollout: string
    files: string[]
    targetFiles?: string[]
    historyKeys?: string[]
    targetDb?: string
    targetHistoryDb?: string
    createdAt: number
    updatedAt: number
    published?: boolean
    error?: string
}

const require = (await import('node:module')).createRequire(import.meta.url)

function openDatabase(path: string, readOnly = false): Database {
    if (typeof Bun !== 'undefined') {
        const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
        return new Database(path, { create: false, readonly: readOnly }) as unknown as Database
    }
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
    const database = new DatabaseSync(path, { readOnly })
    return {
        query: sql => database.prepare(sql) as unknown as Statement,
        exec: sql => database.exec(sql),
        close: () => database.close(),
    }
}

function sqliteHome(home: string): string {
    const configured = process.env.CODEX_SQLITE_HOME?.trim()
    if (configured) return resolve(configured)
    try {
        const config = readFileSync(join(home, 'config.toml'), 'utf8')
        const match = /^\s*sqlite_home\s*=\s*["']([^"']+)["']/m.exec(config)
        if (match) return resolve(home, match[1])
    } catch { /* default home */ }
    return home
}

function findDb(home: string, prefix: string): string {
    const databaseHome = sqliteHome(home)
    const canonical = prefix === 'state' ? 'state_5.sqlite' : 'thread_history_1.sqlite'
    if (existsSync(join(databaseHome, canonical))) return join(databaseHome, canonical)
    const names = require('node:fs').readdirSync(databaseHome) as string[]
    const candidates = names
        .map(name => ({ name, match: new RegExp(`^${prefix}_(\\d+)\\.sqlite$`).exec(name) }))
        .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
        .sort((a, b) => Number(b.match[1]) - Number(a.match[1]))
    if (!candidates[0]) throw new Error(`Codex database ${prefix}_*.sqlite not found in ${home}`)
    return join(databaseHome, candidates[0].name)
}

function columns(database: Database, table: string): string[] {
    return (database.query(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{ name: string }>).map(row => row.name)
}

function insertRow(database: Database, table: string, row: Record<string, unknown>, overrides: Record<string, unknown> = {}): void {
    const available = columns(database, table)
    const values = { ...row, ...overrides }
    const names = Object.keys(values).filter(name => available.includes(name))
    if (names.length === 0) throw new Error(`No compatible columns for ${table}`)
    const placeholders = names.map(() => '?').join(', ')
    database.query(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${placeholders})`).run(...names.map(name => values[name] as never))
}

function migrationFingerprint(database: Database): string {
    const rows = database.query('SELECT version, description, success FROM _sqlx_migrations ORDER BY version').all()
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

function assertSchema(source: Database, target: Database): void {
    const sourceMigrations = migrationFingerprint(source)
    const targetMigrations = migrationFingerprint(target)
    if (sourceMigrations !== targetMigrations) throw new Error('Source and target Codex databases have different migration histories')
    for (const table of ['threads', 'thread_turns', 'thread_items']) {
        const missing = columns(source, table).filter(name => !columns(target, table).includes(name))
        if (missing.length) throw new Error(`Target ${table} is missing columns: ${missing.join(', ')}`)
    }
}

function readRolloutText(path: string): string {
    if (path.endsWith('.zst')) {
        const bun = (globalThis as { Bun?: { zstdDecompressSync?: (data: Uint8Array) => Uint8Array } }).Bun
        if (bun?.zstdDecompressSync) return new TextDecoder().decode(bun.zstdDecompressSync(readFileSync(path)))
        const zstd = require('node:zlib').zstdDecompressSync as ((data: Uint8Array) => Uint8Array) | undefined
        if (!zstd) throw new Error(`Cannot decompress ${path}: zstd support unavailable`)
        return new TextDecoder().decode(zstd(readFileSync(path)))
    }
    return readFileSync(path, 'utf8')
}

function rolloutLogicalBytes(path: string): number {
    return Buffer.byteLength(readRolloutText(path), 'utf8')
}

function validLogicalCutoff(path: string, offset: number, endOrdinalExclusive?: number): boolean {
    const text = readRolloutText(path)
    const bytes = Buffer.from(text, 'utf8')
    if (offset <= 0 || offset > bytes.length) return false
    if (offset !== bytes.length && bytes.subarray(offset - 1, offset).toString('utf8') !== '\n') return false
    if (endOrdinalExclusive === undefined) return true
    let cursor = 0
    let lastOrdinal = -1
    for (const line of text.split('\n')) {
        const lineBytes = Buffer.byteLength(line, 'utf8') + 1
        if (cursor + lineBytes > offset) break
        cursor += lineBytes
        try {
            const parsed = JSON.parse(line) as { ordinal?: unknown }
            if (typeof parsed.ordinal === 'number') lastOrdinal = Math.max(lastOrdinal, parsed.ordinal)
        } catch { /* trailing/empty line */ }
    }
    return lastOrdinal >= endOrdinalExclusive - 1
}

function readRolloutMeta(path: string): { id?: string; historyBase?: { thread_id?: string; end_ordinal_exclusive?: number; end_byte_offset?: number }; historyMode?: string } {
    const text = readRolloutText(path)
    const first = text.split('\n', 1)[0]
    const line = JSON.parse(first) as { type?: string; payload?: Record<string, unknown> }
    if (line.type !== 'session_meta' || !line.payload) throw new Error(`Invalid rollout metadata: ${path}`)
    const base = line.payload.history_base && typeof line.payload.history_base === 'object'
        ? line.payload.history_base as { thread_id?: string; end_ordinal_exclusive?: number; end_byte_offset?: number }
        : undefined
    return {
        id: typeof line.payload.id === 'string' ? line.payload.id : undefined,
        historyBase: base,
        historyMode: typeof line.payload.history_mode === 'string' ? line.payload.history_mode : undefined,
    }
}

function relativeRolloutPath(sourceHome: string, path: string): string {
    const rel = relative(sourceHome, path)
    if (rel.startsWith('..') || resolve(sourceHome, rel) !== resolve(path)) throw new Error(`Rollout escapes source home: ${path}`)
    return rel
}

function rolloutIdFromPath(path: string): string | undefined {
    const matches = basename(path).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)
    return matches?.[matches.length - 1]
}

function collectRollouts(sourceHome: string, threadRow: Record<string, unknown>): { rollouts: NativeThreadPlan['rollouts']; historyKeys: string[]; warnings: string[] } {
    const rawInitial = String(threadRow.rollout_path ?? '')
    const initial = rawInitial && !resolve(rawInitial).startsWith(sourceHome) ? resolve(sourceHome, rawInitial) : resolve(rawInitial)
    if (!rawInitial || !existsSync(initial)) throw new Error(`Source rollout not found: ${initial}`)
    const rollouts: NativeThreadPlan['rollouts'] = []
    const historyKeys: string[] = [String(threadRow.id ?? '')].filter(Boolean)
    const warnings: string[] = []
    const seen = new Set<string>()
    let next: string | undefined = initial
    while (next) {
        const path = resolve(next)
        const meta = readRolloutMeta(path)
        if (seen.has(path)) throw new Error(`Cycle in rollout lineage at ${path}`)
        seen.add(path)
        const rel = relativeRolloutPath(sourceHome, path)
        if (!rollouts.some(entry => entry.source === path)) {
            rollouts.push({ source: path, target: rel, role: 'current' })
        }
        const rolloutId = rolloutIdFromPath(path)
        if (rolloutId && !historyKeys.includes(rolloutId)) historyKeys.push(rolloutId)
        if (!meta.historyBase?.thread_id) break
        const baseId = meta.historyBase.thread_id
        const basePath = findRolloutById(sourceHome, baseId)
        if (!basePath) throw new Error(`Missing history_base rollout ${baseId}`)
        const baseMeta = readRolloutMeta(basePath)
        if (baseMeta.id !== baseId && !basename(basePath).includes(baseId)) throw new Error(`history_base rollout identity mismatch: ${baseId}`)
        if (meta.historyBase.end_byte_offset && (!validLogicalCutoff(basePath, meta.historyBase.end_byte_offset, meta.historyBase.end_ordinal_exclusive) || meta.historyBase.end_byte_offset > rolloutLogicalBytes(basePath))) throw new Error(`history_base byte offset is not a valid JSONL boundary in ${basePath}`)
        if (meta.historyBase.end_ordinal_exclusive === 0) throw new Error(`Invalid history_base ordinal in ${path}`)
        if (!seen.has(resolve(basePath))) {
            rollouts.push({ source: basePath, target: relativeRolloutPath(sourceHome, basePath), role: 'ancestor' })
        }
        next = basePath
    }
    if (new Set(rollouts.map(entry => entry.target)).size !== rollouts.length) warnings.push('Lineage contains duplicate target paths; publish will reject')
    return { rollouts, historyKeys, warnings }
}

function findRolloutById(home: string, id: string): string | undefined {
    const roots = [join(home, 'sessions'), join(home, 'archived_sessions')]
    const queue = [...roots]
    while (queue.length) {
        const root = queue.shift()!
        if (!existsSync(root)) continue
        for (const entry of require('node:fs').readdirSync(root, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean }>) {
            const path = join(root, entry.name)
            if (entry.isDirectory()) queue.push(path)
            else if (entry.name.includes(id)) return path
        }
    }
    return undefined
}

async function writeJournal(path: string, state: TransferState): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temp = `${path}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temp, path)
}

function tableCount(database: Database, table: string, threadIds: string | string[]): number {
    const ids = Array.isArray(threadIds) ? threadIds : [threadIds]
    const placeholders = ids.map(() => '?').join(', ')
    return Number((database.query(`SELECT COUNT(*) AS count FROM ${table} WHERE thread_id IN (${placeholders})`).get(...ids) as { count: number }).count)
}

export async function planNativeThreadMigration(options: NativeThreadMigrationOptions): Promise<NativeThreadPlan> {
    if (!options.threadId) throw new Error('Thread id is required')
    const sourceHome = resolve(options.sourceHome)
    const targetHome = resolve(options.targetHome)
    if (sourceHome === targetHome) throw new Error('Source and target homes are the same')
    const sourceDb = findDb(sourceHome, 'state')
    const sourceHistoryDb = findDb(sourceHome, 'thread_history')
    const targetDb = findDb(targetHome, 'state')
    const targetHistoryDb = findDb(targetHome, 'thread_history')
    if (realpathSync(sourceDb) === realpathSync(targetDb) || realpathSync(sourceHistoryDb) === realpathSync(targetHistoryDb)) {
        throw new Error('Source and target SQLite databases resolve to the same file')
    }
    const source = openDatabase(sourceDb, true)
    const target = openDatabase(targetDb, true)
    if (options.requireWal !== false) {
        const targetHistory = openDatabase(targetHistoryDb, true)
        try {
            const stateJournal = (target.query('PRAGMA journal_mode').get() as { journal_mode?: string }).journal_mode
            const historyJournal = (targetHistory.query('PRAGMA journal_mode').get() as { journal_mode?: string }).journal_mode
            if (stateJournal !== 'wal' || historyJournal !== 'wal') throw new Error('Target Codex databases are not in WAL mode; refusing online migration')
        } finally { targetHistory.close() }
    }
    let threadRow: Record<string, unknown> | undefined
    try {
        assertSchema(source, target)
        threadRow = source.query('SELECT * FROM threads WHERE id = ?').get(options.threadId) as Record<string, unknown> | undefined
        if (!threadRow) throw new Error(`Thread not found in source home: ${options.threadId}`)
        if (target.query('SELECT 1 FROM threads WHERE id = ?').get(options.threadId)) throw new Error(`Target home already contains thread ${options.threadId}; reverse migration requires an explicit fast-forward plan and is not supported yet`)
        const { rollouts, historyKeys, warnings } = collectRollouts(sourceHome, threadRow)
        const sourceProvider = String(threadRow.model_provider ?? '')
        const historyMode = String(threadRow.history_mode ?? 'legacy')
        if (options.targetProvider && sourceProvider && sourceProvider !== options.targetProvider && options.allowCrossProvider !== true) {
            throw new Error('Cross-provider native thread migration is not supported: Codex persists the source provider in rollout/turn history, so rebinding only the thread metadata is unsafe')
        }
        const targetHistoryCheck = openDatabase(targetHistoryDb, true)
        try {
            for (const table of ['thread_turns', 'thread_items', 'thread_realtime_items', 'thread_history_projection_state']) {
                if (!columns(targetHistoryCheck, table).length) continue
                const placeholders = historyKeys.map(() => '?').join(', ')
                if (Number((targetHistoryCheck.query(`SELECT COUNT(*) AS count FROM ${table} WHERE thread_id IN (${placeholders})`).get(...historyKeys) as { count: number }).count) > 0) {
                    throw new Error(`Target history already contains rows for thread ${options.threadId}`)
                }
            }
        } finally { targetHistoryCheck.close() }
        const rowCounts: Record<string, number> = { threads: 1, thread_turns: 0 }
        const history = openDatabase(sourceHistoryDb, true)
        try {
            rowCounts.thread_turns = tableCount(history, 'thread_turns', historyKeys)
            rowCounts.thread_items = tableCount(history, 'thread_items', historyKeys)
            const realtime = columns(history, 'thread_realtime_items').length ? tableCount(history, 'thread_realtime_items', historyKeys) : 0
            rowCounts.thread_realtime_items = realtime
            const projection = columns(history, 'thread_history_projection_state').length
                ? tableCount(history, 'thread_history_projection_state', historyKeys)
                : 0
            rowCounts.thread_history_projection_state = projection
        } finally { history.close() }
        rowCounts.thread_dynamic_tools = columns(source, 'thread_dynamic_tools').length ? tableCount(source, 'thread_dynamic_tools', options.threadId) : 0
        if (columns(source, 'thread_attachments').length && tableCount(source, 'thread_attachments', options.threadId) > 0) {
            throw new Error('Thread has attachments; refusing an incomplete migration until attachment transfer is implemented')
        }
        if (columns(source, 'thread_spawn_edges').length && Number((source.query('SELECT COUNT(*) AS count FROM thread_spawn_edges WHERE parent_thread_id = ? OR child_thread_id = ?').get(options.threadId, options.threadId) as { count: number }).count) > 0) {
            throw new Error('Thread participates in spawn edges; refusing an incomplete migration until descendant transfer is implemented')
        }
        for (const rollout of rollouts) {
            if (existsSync(join(targetHome, rollout.target))) throw new Error(`Target rollout already exists: ${join(targetHome, rollout.target)}`)
        }
        if (options.targetProvider && String(threadRow.model_provider ?? '') !== options.targetProvider) warnings.push(`Provider will be rebound from ${String(threadRow.model_provider ?? 'unknown')} to ${options.targetProvider}; encrypted reasoning compatibility must be verified`)
        return {
            threadId: options.threadId, sourceHome, targetHome, sourceDb, sourceHistoryDb, targetDb, targetHistoryDb,
            threadRow, rollouts, rowCounts, historyKeys, historyMode,
            ...(options.targetProvider && sourceProvider !== options.targetProvider ? { resumeProvider: options.targetProvider, ...(options.targetModel ? { resumeModel: options.targetModel } : {}) } : {}), warnings,
        }
    } finally { source.close(); target.close() }
}

async function stageFiles(plan: NativeThreadPlan, staging: string): Promise<string[]> {
    await mkdir(staging, { recursive: true, mode: 0o700 })
    const staged: string[] = []
    for (const rollout of plan.rollouts) {
        const target = join(staging, rollout.target)
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await copyFile(rollout.source, target)
        staged.push(target)
    }
    return staged
}

async function publishFiles(plan: NativeThreadPlan, staging: string): Promise<{ targetRollout: string; published: string[] }> {
    let currentTarget = ''
    const published: string[] = []
    for (const rollout of plan.rollouts) {
        const staged = join(staging, rollout.target)
        const target = join(plan.targetHome, rollout.target)
        if (existsSync(target)) throw new Error(`Target rollout already exists: ${target}`)
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await copyFile(staged, target)
        published.push(target)
        if (rollout.role === 'current') currentTarget = target
    }
    return { targetRollout: currentTarget, published }
}

async function insertHistory(plan: NativeThreadPlan): Promise<void> {
    const source = openDatabase(plan.sourceHistoryDb, true)
    const target = openDatabase(plan.targetHistoryDb)
    try {
        target.exec('PRAGMA busy_timeout = 5000')
        target.exec('BEGIN IMMEDIATE')
        try {
            for (const table of ['thread_turns', 'thread_items', 'thread_realtime_items', 'thread_history_projection_state']) {
                if (!columns(source, table).length) continue
                const placeholders = plan.historyKeys.map(() => '?').join(', ')
                const rows = source.query(`SELECT * FROM ${table} WHERE thread_id IN (${placeholders})`).all(...plan.historyKeys) as Array<Record<string, unknown>>
                for (const row of rows) insertRow(target, table, row)
            }
            target.exec('COMMIT')
        } catch (error) { target.exec('ROLLBACK'); throw error }
    } finally { source.close(); target.close() }
}

async function publishThread(plan: NativeThreadPlan, targetRollout: string, targetProvider: string | undefined, optionsTargetModel?: string): Promise<void> {
    const source = openDatabase(plan.sourceDb, true)
    const target = openDatabase(plan.targetDb)
    try {
        target.exec('PRAGMA busy_timeout = 5000')
        target.exec('BEGIN IMMEDIATE')
        try {
            const row: Record<string, unknown> = { ...plan.threadRow, rollout_path: targetRollout }
            const threadColumns = columns(target, 'threads')
            if (threadColumns.includes('project_id')) row.project_id = null
            if (threadColumns.includes('thread_section_id')) row.thread_section_id = null
            if (targetProvider && threadColumns.includes('model_provider')) row.model_provider = targetProvider
            if (optionsTargetModel && threadColumns.includes('model')) row.model = optionsTargetModel
            insertRow(target, 'threads', row)
            if (columns(source, 'thread_dynamic_tools').length) {
                const tools = source.query('SELECT * FROM thread_dynamic_tools WHERE thread_id = ?').all(plan.threadId) as Array<Record<string, unknown>>
                for (const tool of tools) insertRow(target, 'thread_dynamic_tools', tool)
            }
            target.exec('COMMIT')
        } catch (error) { target.exec('ROLLBACK'); throw error }
    } finally { source.close(); target.close() }
}

async function cleanupTarget(plan: NativeThreadPlan, publishedFiles: string[] = [], targetRollout = ''): Promise<void> {
    const history = openDatabase(plan.targetHistoryDb)
    const target = openDatabase(plan.targetDb)
    try {
        const existing = target.query('SELECT rollout_path FROM threads WHERE id = ?').get(plan.threadId) as { rollout_path?: string } | undefined
        // Never delete a row that a different transfer already published.
        if (existing && (!targetRollout || existing.rollout_path !== targetRollout)) return
        history.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE')
        try {
            for (const table of ['thread_turns', 'thread_items', 'thread_realtime_items', 'thread_history_projection_state']) {
                if (!columns(history, table).length) continue
                const placeholders = plan.historyKeys.map(() => '?').join(', ')
                history.query(`DELETE FROM ${table} WHERE thread_id IN (${placeholders})`).run(...plan.historyKeys)
            }
            history.exec('COMMIT')
        } catch (error) { history.exec('ROLLBACK'); throw error }
        target.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE')
        try {
            if (columns(target, 'thread_dynamic_tools').length) target.query('DELETE FROM thread_dynamic_tools WHERE thread_id = ?').run(plan.threadId)
            if (targetRollout) target.query('DELETE FROM threads WHERE id = ? AND rollout_path = ?').run(plan.threadId, targetRollout)
            else target.query('DELETE FROM threads WHERE id = ?').run(plan.threadId)
            target.exec('COMMIT')
        } catch (error) { target.exec('ROLLBACK'); throw error }
    } finally { history.close(); target.close() }
    const filesToRemove = publishedFiles.length > 0 ? publishedFiles : plan.rollouts.map(rollout => join(plan.targetHome, rollout.target))
    for (const file of filesToRemove) await rm(file, { force: true }).catch(() => {})
}

async function validateTarget(plan: NativeThreadPlan): Promise<void> {
    const { CodexAppServerClient } = await import('../codexAppServerClient')
    const client = new CodexAppServerClient({ cwd: String(plan.threadRow.cwd ?? plan.targetHome), codexHome: plan.targetHome })
    try {
        await client.connect()
        await client.initialize({ clientInfo: { name: 'hapi-thread-migrate', title: 'HAPI migration', version: '1' }, capabilities: { experimentalApi: true } })
        const overrides = {
            ...(plan.resumeProvider ? { modelProvider: plan.resumeProvider } : {}),
            ...(plan.resumeModel ? { model: plan.resumeModel } : {}),
        }
        try {
            await client.request('thread/resume', { threadId: plan.threadId, excludeTurns: true, ...overrides })
        } catch {
            await client.request('thread/read', { threadId: plan.threadId, includeTurns: true })
        }
    } finally { await client.disconnect() }
}

async function bindProvider(plan: NativeThreadPlan, targetProvider?: string, targetModel?: string): Promise<void> {
    if (!targetProvider && !targetModel) return
    const target = openDatabase(plan.targetDb)
    try {
        const assignments: string[] = []
        const values: unknown[] = []
        const threadColumns = columns(target, 'threads')
        if (targetProvider && threadColumns.includes('model_provider')) { assignments.push('model_provider = ?'); values.push(targetProvider) }
        if (targetModel && threadColumns.includes('model')) { assignments.push('model = ?'); values.push(targetModel) }
        if (!assignments.length) return
        values.push(plan.threadId)
        target.query(`UPDATE threads SET ${assignments.join(', ')} WHERE id = ?`).run(...values)
    } finally { target.close() }
}

async function verify(plan: NativeThreadPlan, expectedProvider?: string, expectedModel?: string): Promise<void> {
    const target = openDatabase(plan.targetDb, true)
    const history = openDatabase(plan.targetHistoryDb, true)
    try {
        const row = target.query('SELECT id, rollout_path, model_provider, model FROM threads WHERE id = ?').get(plan.threadId) as {
            id?: string; rollout_path?: string; model_provider?: string; model?: string
        } | undefined
        if (!row?.id || !row.rollout_path || !existsSync(row.rollout_path)) throw new Error('Published thread row or rollout is missing')
        if (expectedProvider && row.model_provider !== expectedProvider) throw new Error(`Published thread provider is ${String(row.model_provider)} instead of ${expectedProvider}`)
        if (expectedModel && row.model !== expectedModel) throw new Error(`Published thread model is ${String(row.model)} instead of ${expectedModel}`)
        if (tableCount(history, 'thread_items', plan.historyKeys) !== plan.rowCounts.thread_items) throw new Error('Published thread item count does not match source')
        if (tableCount(history, 'thread_turns', plan.historyKeys) !== plan.rowCounts.thread_turns) throw new Error('Published thread turn count does not match source')
    } finally { target.close(); history.close() }
}

type TransferJournal = { path: string; state: TransferState }

async function readTransferJournals(journalRoot: string): Promise<TransferJournal[]> {
    let names: string[]
    try { names = require('node:fs').readdirSync(journalRoot) as string[] } catch { return [] }
    const entries: TransferJournal[] = []
    for (const name of names) {
        if (!name.endsWith('.json')) continue
        const path = join(journalRoot, name)
        try { entries.push({ path, state: JSON.parse(await readFile(path, 'utf8')) as TransferState }) } catch { /* skip corrupt or non-journal JSON */ }
    }
    return entries
}

async function supersedePriorTransfers(journalRoot: string, threadId: string, transferId: string): Promise<void> {
    for (const { path, state } of await readTransferJournals(journalRoot)) {
        if (state.transferId === transferId || state.threadId !== threadId) continue
        if (state.published === true || state.status === 'published' || state.status === 'validated' || state.status === 'superseded') continue
        state.status = 'superseded'
        state.error = `Superseded by transfer ${transferId}`
        state.updatedAt = Date.now()
        await writeJournal(path, state)
    }
}

export async function recoverInterruptedTransfers(journalRoot: string): Promise<number> {
    let recovered = 0
    const entries = await readTransferJournals(journalRoot)
    for (const { path, state } of entries) {
        if (!state.targetDb || !state.targetHistoryDb || !state.historyKeys) continue
        if (state.published === true || state.status === 'published' || state.status === 'validated' || state.status === 'superseded') continue
        if (Date.now() - state.updatedAt < 5 * 60_000) continue
        const newerCompletion = entries.some(entry => entry.state.threadId === state.threadId
            && entry.state.transferId !== state.transferId
            && entry.state.createdAt > state.createdAt
            && (entry.state.published === true || entry.state.status === 'published' || entry.state.status === 'validated'))
        if (newerCompletion) {
            state.status = 'superseded'
            state.error = 'A later transfer completed this thread'
            state.updatedAt = Date.now()
            await writeJournal(path, state)
            continue
        }
        const history = openDatabase(state.targetHistoryDb)
        const target = openDatabase(state.targetDb)
        try {
            const existing = target.query('SELECT rollout_path FROM threads WHERE id = ?').get(state.threadId) as { rollout_path?: string } | undefined
            if (existing && (!state.targetRollout || existing.rollout_path !== state.targetRollout)) {
                state.status = 'superseded'
                state.error = 'Target thread is owned by another transfer'
                state.updatedAt = Date.now()
                await writeJournal(path, state)
                continue
            }
            history.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE')
            try {
                const placeholders = state.historyKeys.map(() => '?').join(', ')
                for (const table of ['thread_turns', 'thread_items', 'thread_realtime_items', 'thread_history_projection_state']) {
                    if (columns(history, table).length) history.query(`DELETE FROM ${table} WHERE thread_id IN (${placeholders})`).run(...state.historyKeys)
                }
                history.exec('COMMIT')
            } catch (error) { history.exec('ROLLBACK'); throw error }
            target.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE')
            try {
                if (columns(target, 'thread_dynamic_tools').length) target.query('DELETE FROM thread_dynamic_tools WHERE thread_id = ?').run(state.threadId)
                if (state.targetRollout) target.query('DELETE FROM threads WHERE id = ? AND rollout_path = ?').run(state.threadId, state.targetRollout)
                else target.query('DELETE FROM threads WHERE id = ?').run(state.threadId)
                target.exec('COMMIT')
            } catch (error) { target.exec('ROLLBACK'); throw error }
        } finally { history.close(); target.close() }
        for (const file of state.targetFiles ?? []) {
            if (resolve(file).startsWith(resolve(state.targetHome))) await rm(file, { force: true }).catch(() => {})
        }
        state.status = 'failed'; state.error = 'Interrupted transfer recovered'; state.updatedAt = Date.now()
        await writeJournal(path, state)
        recovered += 1
    }
    return recovered
}

export async function migrateNativeThread(options: NativeThreadMigrationOptions): Promise<{ plan: NativeThreadPlan; journalPath: string }> {
    for (const home of [options.sourceHome, options.targetHome]) {
        if (!existsSync(resolve(home)) || !statSync(resolve(home)).isDirectory()) throw new Error(`Codex home is not a directory: ${resolve(home)}`)
    }
    const journalRoot = options.journalRoot ?? join(process.env.HAPI_HOME ?? join(process.env.HOME ?? '.', '.hapi'), 'codex-thread-transfers')
    await recoverInterruptedTransfers(journalRoot).catch(() => {})
    let sourceLock: CodexWriterLock | undefined
    let targetLock: CodexWriterLock | undefined
    if (options.useWriterLocks !== false) {
        sourceLock = acquireCodexWriterLock(resolve(options.sourceHome), options.threadId)
    }
    try {
        if (options.useWriterLocks !== false) targetLock = acquireCodexWriterLock(resolve(options.targetHome), options.threadId)
        const plan = await planNativeThreadMigration(options)
        return await runMigration(plan, options)
    } finally {
        targetLock?.release()
        sourceLock?.release()
    }
}

async function runMigration(plan: NativeThreadPlan, options: NativeThreadMigrationOptions): Promise<{ plan: NativeThreadPlan; journalPath: string }> {
    const journalRoot = options.journalRoot ?? join(process.env.HAPI_HOME ?? join(process.env.HOME ?? '.', '.hapi'), 'codex-thread-transfers')
    const transferId = randomUUID()
    const journalPath = join(journalRoot, `${plan.threadId}-${transferId}.json`)
    const state: TransferState = {
        version: 1, transferId, threadId: plan.threadId, sourceHome: plan.sourceHome, targetHome: plan.targetHome,
        status: 'preparing', targetRollout: '', files: [], targetFiles: [], historyKeys: [], targetDb: plan.targetDb, targetHistoryDb: plan.targetHistoryDb, createdAt: Date.now(), updatedAt: Date.now(),
    }
    await supersedePriorTransfers(journalRoot, plan.threadId, transferId)
    const staging = join(plan.targetHome, '.hapi-thread-transfer', transferId)
    let targetRollout = ''
    let publishedFiles: string[] = []
    const update = async (status: TransferState['status'], extra: Partial<TransferState> = {}) => {
        Object.assign(state, extra, { status, updatedAt: Date.now() })
        await writeJournal(journalPath, state)
    }
    let published = false
    try {
        await update('preparing', { historyKeys: plan.historyKeys, targetDb: plan.targetDb, targetHistoryDb: plan.targetHistoryDb })
        const staged = await stageFiles(plan, staging)
        await update('files-staged', { files: staged, targetFiles: plan.rollouts.map(rollout => join(plan.targetHome, rollout.target)) })
        const files = await publishFiles(plan, staging)
        targetRollout = files.targetRollout
        publishedFiles = files.published
        await update('source-frozen', { targetRollout })
        await insertHistory(plan)
        await update('history-imported')
        await publishThread(plan, targetRollout, options.targetProvider, options.targetModel)
        await bindProvider(plan, options.targetProvider, options.targetModel)
        published = true
        await update('published', { published: true })
        await verify(plan, options.targetProvider, options.targetModel)
        if (options.validate !== false) await validateTarget(plan)
        await bindProvider(plan, options.targetProvider, options.targetModel)
        await update('validated')
        return { plan, journalPath }
    } catch (error) {
        if (published) {
            // The target app-server may already have observed the row. Do not
            // delete it automatically; leave the journal for explicit repair.
            await update('failed', { error: error instanceof Error ? error.message : String(error) })
        } else {
            await cleanupTarget(plan, publishedFiles, targetRollout).catch(cleanupError => {
                error = new Error(`${error instanceof Error ? error.message : String(error)}; cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
            })
            await update('failed', { error: error instanceof Error ? error.message : String(error) })
        }
        throw error
    } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => {})
    }
}
