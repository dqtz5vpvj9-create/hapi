import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, open, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { FORK_CLOSED_UNADMITTED_CODE, ForkOperationRpcRequestSchema, type ForkOperationRpcRequest, type ForkOperationReceipt } from '@hapi/protocol/forkOperations';

const ClaimSchema = z.object({
    version: z.literal(1), origin: z.enum(['hub', 'legacy-root', 'native-gateway']), namespace: z.string(), hub: z.string(), authHash: z.string(),
    sourceThreadId: z.string().min(1), owner: z.string().min(1), createdAt: z.number(),
    request: ForkOperationRpcRequestSchema,
});
export type ForkOperationOrigin = 'hub' | 'legacy-root' | 'native-gateway';
export type ForkJournalClaim = z.infer<typeof ClaimSchema>;
export type ForkPlan = { params: Record<string, unknown>; settings: Record<string, unknown> };
export type ForkDispatch = { requestId: string | number; transportGeneration: string | number; plan: ForkPlan };
export type ForkJournalEntry = { claim: ForkJournalClaim; operation: ForkOperationReceipt; dispatch?: ForkDispatch };
const DispatchSchema = z.object({ requestId: z.union([z.string(), z.number()]), transportGeneration: z.union([z.string(), z.number()]),
    plan: z.object({ params: z.record(z.string(), z.unknown()), settings: z.record(z.string(), z.unknown()) }) });
const RowSchema = z.object({
    operation_key: z.string(), source_thread_id: z.string(), claim_json: z.string(),
    dispatch_json: z.string().nullable(), outcome: z.enum(['running', 'unknown', 'created', 'rejected']),
    native_thread_id: z.string().nullable(), binding: z.enum(['pending', 'ready', 'blocked']).nullable(),
    code: z.string().nullable(), message: z.string(), updated_at: z.number(), predecessor_key: z.string().nullable(),
});
type OperationRow = z.infer<typeof RowSchema>;
type SourceRow = { revision: number; head_key: string; active_blocker: string | null };
type Statement = { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
type Database = { query(sql: string): Statement; exec(sql: string): void; close(): void };
const require = createRequire(import.meta.url);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const operationIdIndex = 'fork_operation_uuid';
const operationIdTrigger = 'fork_operation_uuid_insert_guard';
const operationIdIndexSql = `CREATE INDEX ${operationIdIndex} ON operations(json_extract(claim_json, '$.request.operationId'))`;
const operationIdTriggerSql = `CREATE TRIGGER ${operationIdTrigger} BEFORE INSERT ON operations
    WHEN EXISTS(SELECT 1 FROM operations INDEXED BY ${operationIdIndex}
        WHERE json_extract(claim_json, '$.request.operationId') = json_extract(NEW.claim_json, '$.request.operationId'))
    BEGIN SELECT RAISE(ABORT, 'Fork operation UUID already exists in this native store'); END`;
const exists = async (path: string) => { try { await stat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } };
function openDatabase(path: string, create: boolean): Database {
    if (typeof Bun !== 'undefined') {
        const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
        return new Database(path, { create, readwrite: true }) as unknown as Database;
    }
    // Same dual adapter as nativeHistoryMetadata; no new dependency or native daemon access.
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const database = new DatabaseSync(path);
    return { query: sql => database.prepare(sql) as unknown as Statement, exec: sql => database.exec(sql), close: () => database.close() };
}

/** One authoritative SQLite journal. SQL-only IMMEDIATE transactions serialize source admission,
 * dispatch intent and exact native creation, including explicit duplicate-risk override races.
 * Outcome uncertainty is independent of the active source blocker: superseded unknowns still quarantine discovery.
 */
export class ForkJournal {
    readonly databasePath: string;
    private constructor(readonly directory: string, private readonly identity: { namespace: string; hub: string; authHash: string; owner: string }) {
        this.databasePath = join(directory, 'journal.sqlite');
    }
    static async open(home: string, identity: { namespace: string; hub: string; authHash: string; owner: string }): Promise<ForkJournal> {
        const canonicalHome = await realpath(home);
        const directory = join(canonicalHome, 'hapi-fork-operations');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const journal = new ForkJournal(directory, identity);
        const marker = join(directory, 'sqlite-initialized');
        if (!await exists(journal.databasePath)) {
            // This format was never released. Never silently bypass a legacy/corrupt/deleted journal.
            if ((await readdir(directory)).length) {
                if (await exists(marker)) { await journal.awaitInitialization(); journal.installIdentityGuard(); return journal; }
                throw new Error('Fork journal database is missing or uses an unsupported format; creation is blocked');
            }
            let file;
            try { file = await open(marker, 'wx', 0o600); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                await journal.awaitInitialization(); journal.installIdentityGuard(); return journal;
            }
            try { await file.writeFile('hapi-fork-journal-sqlite-v1\n'); await file.sync(); } finally { await file.close(); }
            await journal.syncDirectory(directory); await journal.syncDirectory(canonicalHome);
            journal.access(database => {
                database.exec(`CREATE TABLE journal_meta (version INTEGER NOT NULL CHECK(version = 1));
                    INSERT INTO journal_meta VALUES (1);
                    CREATE TABLE operations (
                        operation_key TEXT PRIMARY KEY, source_thread_id TEXT NOT NULL, claim_json TEXT NOT NULL,
                        dispatch_json TEXT, outcome TEXT NOT NULL CHECK(outcome IN ('running','unknown','created','rejected')),
                        native_thread_id TEXT UNIQUE, binding TEXT CHECK(binding IN ('pending','ready','blocked')),
                        code TEXT, message TEXT NOT NULL, updated_at INTEGER NOT NULL, predecessor_key TEXT,
                        CHECK((outcome = 'created') = (native_thread_id IS NOT NULL AND binding IS NOT NULL))
                    );
                    CREATE INDEX unresolved_native_outcomes ON operations(outcome) WHERE outcome IN ('running','unknown');
                    CREATE TABLE sources (source_thread_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
                        head_key TEXT NOT NULL, active_blocker TEXT);`);
            }, true, true);
            await journal.syncDirectory(directory);
        } else {
            if (!await exists(marker)) throw new Error('Fork journal initialization marker is missing; creation is blocked');
            await journal.awaitInitialization();
        }
        journal.installIdentityGuard();
        return journal;
    }
    private identityGuard(database: Database, install: boolean): void {
        for (const [type, name, sql] of [
            ['index', operationIdIndex, operationIdIndexSql], ['trigger', operationIdTrigger, operationIdTriggerSql],
        ]) {
            const existing = database.query('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?').get(type, name) as { sql: string } | undefined;
            if (!existing && install) database.exec(sql);
            else if (!existing || existing.sql !== sql) throw new Error('Fork operation identity guard is missing or inconsistent; creation is blocked');
        }
    }
    private installIdentityGuard(): void {
        // Upgrade the unpublished v1 journal in place. Preserve old duplicate rows;
        // the indexed lookup rejects ambiguity, while the trigger also fences old writers.
        this.access(database => this.identityGuard(database, true), true);
    }
    private async awaitInitialization(): Promise<void> {
        // Another process may be between marker fsync and schema commit. Only observe its result;
        // never remove a marker, initialize a replacement database, or bypass a damaged journal.
        const deadline = Date.now() + 1_000;
        let lastError: unknown;
        do {
            if (await exists(this.databasePath)) {
                try { this.access(() => {}); return; } catch (error) { lastError = error; }
            }
            if (Date.now() >= deadline) break;
            await new Promise(resolve => setTimeout(resolve, 20));
        } while (Date.now() < deadline);
        throw new Error('Fork journal database is missing, incomplete or unreadable; creation is blocked', { cause: lastError });
    }
    private async syncDirectory(directory: string) {
        // Windows does not support POSIX directory-handle fsync. SQLite's VFS provides
        // its commit durability there; the initialization marker file is still synced.
        if (process.platform === 'win32') return;
        const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); }
    }
    private access<T>(work: (database: Database) => T, transaction = false, initialize = false): T {
        let database: Database | undefined;
        try {
            database = openDatabase(this.databasePath, initialize);
            database.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = EXTRA;');
            if ((database.query('PRAGMA synchronous').get() as { synchronous: number }).synchronous !== 3)
                throw new Error('SQLite EXTRA durability could not be established');
            if (!initialize && (database.query('SELECT version FROM journal_meta').get() as { version?: number } | undefined)?.version !== 1)
                throw new Error('Unsupported fork journal schema');
            if (transaction) database.exec('BEGIN IMMEDIATE');
            try {
                const result = work(database);
                if (transaction) database.exec('COMMIT');
                return result;
            } catch (error) { if (transaction) database.exec('ROLLBACK'); throw error; }
        } catch (error) {
            throw new Error(`Cannot verify durable fork journal; creation is blocked: ${errorText(error)}`, { cause: error });
        } finally { database?.close(); }
    }
    private key(operationId: string) { return hash(JSON.stringify([this.identity.namespace, this.identity.hub, this.identity.authHash, operationId])); }
    private row(database: Database, key: string): OperationRow | undefined {
        return RowSchema.optional().parse(database.query('SELECT * FROM operations WHERE operation_key = ?').get(key) ?? undefined);
    }
    private same(claim: ForkJournalClaim, request: ForkOperationRpcRequest, sourceThreadId: string) {
        const { action: _a, ...expected } = claim.request;
        const { action: _b, ...actual } = ForkOperationRpcRequestSchema.parse(request);
        if (claim.namespace !== this.identity.namespace || claim.hub !== this.identity.hub || claim.authHash !== this.identity.authHash
            || claim.sourceThreadId !== sourceThreadId || JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Fork operation immutable request mismatch');
    }
    private verified(database: Database, request: ForkOperationRpcRequest, source: string): OperationRow | undefined {
        const row = this.row(database, this.key(request.operationId));
        if (row) this.same(ClaimSchema.parse(JSON.parse(row.claim_json)), request, source);
        return row;
    }
    private globallyVerified(database: Database, request: ForkOperationRpcRequest, source: string): OperationRow | undefined {
        this.identityGuard(database, false);
        const rows = database.query(`SELECT * FROM operations INDEXED BY ${operationIdIndex}
            WHERE json_extract(claim_json, '$.request.operationId') = ? LIMIT 2`).all(request.operationId);
        if (!rows.length) return undefined;
        try {
            if (rows.length !== 1) throw new Error('Ambiguous operation UUID');
            const row = RowSchema.parse(rows[0]);
            const entry = this.entry(row);
            this.same(entry.claim, request, source);
            return row;
        } catch {
            // An own-scope row must not hide an old-auth/foreign row or a different source.
            throw new Error('Fork operation immutable request mismatch or authenticated scope conflict; creation is blocked');
        }
    }
    private entry(row: OperationRow): ForkJournalEntry {
        const claim = ClaimSchema.parse(JSON.parse(row.claim_json));
        if (row.operation_key !== hash(JSON.stringify([claim.namespace, claim.hub, claim.authHash, claim.request.operationId]))
            || row.source_thread_id !== claim.sourceThreadId) throw new Error('Fork journal row identity is inconsistent');
        const dispatch = row.dispatch_json === null ? undefined : DispatchSchema.parse(JSON.parse(row.dispatch_json));
        const base = { operationId: claim.request.operationId, sourceSessionId: claim.request.sourceSessionId,
            childSessionId: claim.request.childSessionId, sourceRevision: claim.request.sourceRevision,
            ...(claim.request.duplicateRiskOf ? { duplicateRiskOf: claim.request.duplicateRiskOf } : {}),
            message: row.message, updatedAt: row.updated_at, ...(row.code ? { code: row.code } : {}) };
        if (row.outcome === 'created') {
            if (!row.native_thread_id || !row.binding || !dispatch) throw new Error('Invalid known fork child record');
            return { claim, dispatch, operation: { ...base, status: 'created', nativeThreadId: row.native_thread_id, binding: row.binding } };
        }
        if (row.outcome === 'rejected') {
            if (dispatch) throw new Error('A dispatched native fork cannot be rejected');
            return { claim, operation: { ...base, status: 'rejected', rejectionProof: 'not_dispatched' } };
        }
        const running = row.outcome === 'running' && claim.owner === this.identity.owner;
        return { claim, dispatch, operation: { ...base, status: running ? 'running' : 'indeterminate',
            ...(!running && row.outcome === 'running' ? { code: 'fork_result_unknown', message: 'Previous execution result is unconfirmed; creation will not be sent again' } : {}) } };
    }
    async read(request: ForkOperationRpcRequest, source: string): Promise<ForkJournalEntry | undefined> {
        return this.access(database => { const row = this.verified(database, request, source); return row && this.entry(row); });
    }
    private unresolved(row: OperationRow): boolean { return row.outcome === 'running' || row.outcome === 'unknown' || row.outcome === 'created' && row.binding !== 'ready'; }
    private insert(database: Database, claim: ForkJournalClaim, code?: string, message?: string): OperationRow {
        database.query(`INSERT INTO operations(operation_key, source_thread_id, claim_json, outcome, message, updated_at, code, predecessor_key)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(this.key(claim.request.operationId), claim.sourceThreadId, JSON.stringify(claim), code ? 'rejected' : 'running',
            message ?? 'Fork operation is in progress', Date.now(), code ?? null, claim.request.duplicateRiskOf ? this.key(claim.request.duplicateRiskOf) : null);
        return this.row(database, this.key(claim.request.operationId))!;
    }
    async admit(request: ForkOperationRpcRequest, source: string, origin: ForkOperationOrigin = 'hub'): Promise<{ entry: ForkJournalEntry; admitted: boolean }> {
        return this.access(database => {
            const existing = this.globallyVerified(database, request, source);
            if (existing) return { entry: this.entry(existing), admitted: false };
            const claim: ForkJournalClaim = { version: 1, origin, ...this.identity, sourceThreadId: source, createdAt: Date.now(), request: ForkOperationRpcRequestSchema.parse(request) };
            const head = database.query('SELECT * FROM sources WHERE source_thread_id = ?').get(source) as SourceRow | undefined;
            const reject = (code: string, message: string) => ({ entry: this.entry(this.insert(database, claim, code, message)), admitted: false });
            if (request.duplicateRiskOf) {
                const target = this.row(database, this.key(request.duplicateRiskOf));
                if (!target || request.duplicateRiskOf === request.operationId || head?.head_key !== target.operation_key)
                    return reject('risk_target_mismatch', 'The confirmed unknown operation is no longer this source head; check its current result');
                const prior = this.entry(target);
                const frozen = prior.claim.request;
                if (prior.claim.namespace !== claim.namespace || prior.claim.authHash !== claim.authHash || prior.claim.hub !== claim.hub
                    || prior.claim.sourceThreadId !== source || frozen.sourceSessionId !== request.sourceSessionId
                    || frozen.sourceNativeThreadId !== request.sourceNativeThreadId || frozen.sourceMachineId !== request.sourceMachineId
                    || frozen.sourceStoreId !== request.sourceStoreId || request.sourceRevision <= frozen.sourceRevision
                    || JSON.stringify([frozen.messageLocalId, frozen.nativeBoundary]) !== JSON.stringify([request.messageLocalId, request.nativeBoundary]))
                    return reject('risk_target_mismatch', 'Duplicate-risk confirmation does not match the original source and boundary');
                if (prior.operation.status === 'created' || prior.operation.status === 'rejected')
                    return reject('risk_target_resolved', 'The original operation now has a definite result; check that operation instead');
                if (prior.operation.status !== 'indeterminate')
                    return reject('risk_target_not_indeterminate', 'The original operation is still running in its source runtime; check it before creating another');
            } else if (head?.active_blocker) {
                // A blocker is durable authority, not a lease or a speculative native absence check.
                const blocker = this.row(database, head.active_blocker);
                if (!blocker || blocker.source_thread_id !== source) throw new Error('The native source blocker is missing or mismatched');
                const prior = this.entry(blocker).claim;
                const authorized = prior.namespace === claim.namespace && prior.hub === claim.hub && prior.authHash === claim.authHash;
                return reject('fork_source_unresolved', authorized
                    ? `This new fork was not dispatched. An unresolved fork already fences this native source: operation ${prior.request.operationId}, source session ${prior.request.sourceSessionId}, origin ${prior.origin}. ${prior.origin === 'hub' ? 'Check that original operation in its source session.' : 'Web cannot clear or duplicate-risk override this native-origin fence; use that original runtime’s diagnostics.'}`
                    : 'This new fork was not dispatched. An unresolved fork already fences this physical native source in another authenticated HAPI scope. Web cannot clear that fence; use the owning runtime’s diagnostics.');
            }
            const row = this.insert(database, claim);
            database.query(`INSERT INTO sources(source_thread_id, revision, head_key, active_blocker) VALUES (?, 1, ?, ?)
                ON CONFLICT(source_thread_id) DO UPDATE SET revision = sources.revision + 1, head_key = excluded.head_key, active_blocker = excluded.active_blocker`)
                .run(source, row.operation_key, row.operation_key);
            return { entry: this.entry(row), admitted: true };
        }, true);
    }
    async closeUnadmitted(request: ForkOperationRpcRequest, source: string, origin: ForkOperationOrigin = 'hub'): Promise<ForkJournalEntry> {
        if (origin !== 'hub') throw new Error('Only an authenticated Hub fork operation can be closed before admission');
        if (request.sourceStoreId !== dirname(this.directory) || request.sourceNativeThreadId !== source)
            throw new Error('Closing an unadmitted fork requires its original exact native store and source identity');
        return this.access(database => {
            const existing = this.globallyVerified(database, request, source);
            if (existing) return this.entry(existing); // Even admitted-but-unsent is not absence.
            const head = database.query('SELECT head_key, active_blocker FROM sources WHERE source_thread_id = ?').get(source) as SourceRow | undefined;
            for (const key of new Set([head?.head_key, head?.active_blocker].filter((key): key is string => Boolean(key)))) {
                const referenced = this.row(database, key);
                if (!referenced || this.entry(referenced).claim.sourceThreadId !== source)
                    throw new Error('Fork source authority is missing or inconsistent; unadmitted closure is blocked');
            }
            const claim: ForkJournalClaim = { version: 1, origin, ...this.identity, sourceThreadId: source, createdAt: Date.now(),
                request: ForkOperationRpcRequestSchema.parse({ ...request, action: 'start' }) };
            // Do not admit B or touch sources/head/blocker. This tombstone only closes B's
            // exact UUID; a delayed start, including an old writer, cannot create it later.
            return this.entry(this.insert(database, claim, FORK_CLOSED_UNADMITTED_CODE,
                'This request was closed before the source runtime admitted it; it was not dispatched'));
        }, true);
    }
    async dispatch(request: ForkOperationRpcRequest, source: string, value: ForkDispatch): Promise<void> {
        this.access(database => {
            const row = this.verified(database, request, source);
            const head = database.query('SELECT head_key, active_blocker FROM sources WHERE source_thread_id = ?').get(source) as SourceRow | undefined;
            if (!row || this.entry(row).claim.owner !== this.identity.owner || row.outcome !== 'running' || row.dispatch_json
                || head?.head_key !== row.operation_key || head.active_blocker !== row.operation_key) throw new Error('Fork operation cannot dispatch or was already dispatched');
            database.query('UPDATE operations SET dispatch_json = ?, updated_at = ? WHERE operation_key = ?')
                .run(JSON.stringify(DispatchSchema.parse(value)), Date.now(), row.operation_key);
        }, true); // Commit EXTRA happens before the transport's beforeSend hook resolves.
    }
    private restore(database: Database, row: OperationRow): void {
        const head = database.query('SELECT head_key FROM sources WHERE source_thread_id = ?').get(row.source_thread_id) as SourceRow | undefined;
        if (head?.head_key !== row.operation_key) return;
        let target = row;
        const visited = new Set<string>();
        for (let depth = 0; target.outcome === 'rejected' && target.predecessor_key; depth++) {
            if (depth >= 128 || visited.has(target.operation_key)) throw new Error('Fork recovery predecessor chain is invalid or exceeds the bounded recovery window');
            visited.add(target.operation_key);
            const expectedPredecessor = this.entry(target).claim.request.duplicateRiskOf;
            if (!expectedPredecessor || target.predecessor_key !== this.key(expectedPredecessor)) throw new Error('Fork recovery predecessor key is inconsistent');
            const predecessor = this.row(database, target.predecessor_key);
            if (!predecessor || predecessor.source_thread_id !== row.source_thread_id) throw new Error('Fork recovery predecessor identity is missing');
            const origin = this.entry(row).claim; const previous = this.entry(predecessor).claim;
            if (origin.namespace !== previous.namespace || origin.hub !== previous.hub || origin.authHash !== previous.authHash
                || origin.request.sourceSessionId !== previous.request.sourceSessionId
                || origin.request.sourceNativeThreadId !== previous.request.sourceNativeThreadId
                || origin.request.sourceMachineId !== previous.request.sourceMachineId
                || origin.request.sourceStoreId !== previous.request.sourceStoreId
                || JSON.stringify([origin.request.messageLocalId, origin.request.nativeBoundary]) !== JSON.stringify([previous.request.messageLocalId, previous.request.nativeBoundary])) throw new Error('Fork recovery predecessor source does not match');
            target = predecessor;
        }
        database.query('UPDATE sources SET revision = revision + CASE WHEN head_key <> ? THEN 1 ELSE 0 END, head_key = ?, active_blocker = ? WHERE source_thread_id = ? AND head_key = ?')
            .run(target.operation_key, target.operation_key, this.unresolved(target) ? target.operation_key : null, row.source_thread_id, row.operation_key);
    }
    async reject(request: ForkOperationRpcRequest, source: string, code: string, message: string): Promise<void> {
        this.access(database => {
            const row = this.verified(database, request, source); if (!row) throw new Error('Fork operation not found');
            if (row.outcome === 'created' || row.outcome === 'rejected') return;
            if (row.dispatch_json) {
                database.query("UPDATE operations SET outcome = 'unknown', code = 'fork_result_unknown', message = ?, updated_at = ? WHERE operation_key = ?")
                    .run(message, Date.now(), row.operation_key); return;
            }
            database.query("UPDATE operations SET outcome = 'rejected', code = ?, message = ?, updated_at = ? WHERE operation_key = ?")
                .run(code, message, Date.now(), row.operation_key);
            this.restore(database, this.row(database, row.operation_key)!);
        }, true);
    }
    async unknown(request: ForkOperationRpcRequest, source: string, error: unknown): Promise<void> {
        this.access(database => {
            const row = this.verified(database, request, source); if (!row) throw new Error('Fork operation not found');
            if (row.outcome === 'created' || row.outcome === 'rejected') return;
            database.query("UPDATE operations SET outcome = 'unknown', code = 'fork_result_unknown', message = ?, updated_at = ? WHERE operation_key = ?")
                .run(errorText(error), Date.now(), row.operation_key);
        }, true);
    }
    async created(request: ForkOperationRpcRequest, source: string, nativeThreadId: string): Promise<void> {
        this.access(database => {
            const row = this.verified(database, request, source);
            if (!row?.dispatch_json || !nativeThreadId || nativeThreadId === source) throw new Error('Cannot record native creation without its dispatch identity or distinct child');
            if (row.native_thread_id && row.native_thread_id !== nativeThreadId) throw new Error('Native fork returned a conflicting child identity');
            const other = this.rowByNative(database, nativeThreadId);
            if (other && other.operation_key !== row.operation_key) throw new Error('Fork operation immutable request mismatch: native child belongs to another operation');
            if (row.outcome === 'created') return;
            database.query("UPDATE operations SET outcome = 'created', native_thread_id = ?, binding = 'pending', code = NULL, message = ?, updated_at = ? WHERE operation_key = ?")
                .run(nativeThreadId, 'Native child is saved; HAPI binding is pending', Date.now(), row.operation_key);
            // Do not touch the source head: an explicitly admitted successor owns it now.
        }, true);
    }
    async bound(request: ForkOperationRpcRequest, source: string, error?: unknown): Promise<void> {
        this.access(database => {
            const row = this.verified(database, request, source);
            if (row?.outcome !== 'created') throw new Error('Fork has no known child to bind');
            if (row.binding === 'ready') return;
            database.query('UPDATE operations SET binding = ?, message = ?, updated_at = ? WHERE operation_key = ?')
                .run(error === undefined ? 'ready' : 'blocked', error === undefined ? 'Fork is ready' : errorText(error), Date.now(), row.operation_key);
            if (error === undefined) database.query('UPDATE sources SET active_blocker = NULL WHERE source_thread_id = ? AND head_key = ? AND active_blocker = ?')
                .run(source, row.operation_key, row.operation_key);
        }, true);
    }
    private rowByNative(database: Database, threadId: string): OperationRow | undefined {
        return RowSchema.optional().parse(database.query('SELECT * FROM operations WHERE native_thread_id = ?').get(threadId) ?? undefined);
    }
    async knownChild(threadId: string): Promise<ForkJournalEntry | undefined> {
        return this.access(database => {
            const row = this.rowByNative(database, threadId); if (!row) return undefined;
            const entry = this.entry(row); const claim = entry.claim;
            if (claim.hub !== this.identity.hub || claim.authHash !== this.identity.authHash
                || this.identity.namespace && claim.namespace !== this.identity.namespace) throw new Error('Native child belongs to another authenticated HAPI namespace');
            if (entry.operation.status !== 'created') throw new Error('Native child reservation is not yet committed');
            return entry;
        });
    }
    async discoveryGuard(threadId: string): Promise<'allow' | 'reserved' | 'unknown'> {
        return this.access(database => (database.query(`SELECT CASE
            WHEN EXISTS(SELECT 1 FROM operations WHERE native_thread_id = ?) THEN 'reserved'
            WHEN EXISTS(SELECT 1 FROM operations WHERE outcome IN ('running','unknown')) THEN 'unknown'
            ELSE 'allow' END AS result`).get(threadId) as { result: 'allow' | 'reserved' | 'unknown' }).result);
    }
}
