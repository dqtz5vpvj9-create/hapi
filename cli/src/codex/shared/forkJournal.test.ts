import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ForkOperationRpcRequest } from '@hapi/protocol/forkOperations';
import { ForkJournal } from './forkJournal';

const filesystem = vi.hoisted(() => ({ failMarkerSync: false, failDirectorySync: false, directoryOpens: 0, markerSyncs: 0 }));
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
        const handle = await actual.open(...args);
        const directory = (await handle.stat()).isDirectory();
        const marker = String(args[0]).endsWith('sqlite-initialized');
        if (directory) filesystem.directoryOpens++;
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
            if (marker) filesystem.markerSyncs++;
            if (marker && filesystem.failMarkerSync) throw new Error('injected marker sync failure');
            if (directory && filesystem.failDirectorySync) throw new Error('injected directory sync failure');
            await sync();
        };
        return handle;
    } };
});

const homes: string[] = [];
const identity = { namespace: 'team', hub: 'http://hub', authHash: 'auth', owner: 'process-a' };
const request = (extra: Partial<ForkOperationRpcRequest> = {}): ForkOperationRpcRequest => ({ action: 'start', operationId: randomUUID(), sourceSessionId: 'parent', childSessionId: randomUUID(), sourceRevision: 1, sourceNativeThreadId: 'native-parent', sourceMachineId: 'machine', fingerprint: 'immutable-boundary', ...extra });
const dispatch = { requestId: 7, transportGeneration: 1, plan: { params: { threadId: 'native-parent', excludeTurns: true }, settings: { collaborationMode: 'plan' } } };
const setup = async () => { const home = await mkdtemp(join(tmpdir(), 'hapi-fork-journal-')); homes.push(home); return { home, journal: await ForkJournal.open(home, identity) }; };
afterEach(async () => {
    filesystem.failMarkerSync = false; filesystem.failDirectorySync = false;
    filesystem.directoryOpens = 0; filesystem.markerSyncs = 0;
    await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

function sourceState(journal: ForkJournal) {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const database = new DatabaseSync(journal.databasePath);
    try {
        const row = database.prepare(`SELECT s.revision, s.active_blocker, o.claim_json FROM sources s JOIN operations o ON s.head_key = o.operation_key WHERE s.source_thread_id = ?`).get('native-parent') as { revision: number; active_blocker: string | null; claim_json: string };
        return { revision: row.revision, blocked: row.active_blocker !== null, operationId: JSON.parse(row.claim_json).request.operationId as string };
    } finally { database.close(); }
}
function sqlite(journal: ForkJournal) {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    return new DatabaseSync(journal.databasePath);
}
function oldWriterInsert(journal: ForkJournal, op: ForkOperationRpcRequest, authHash = identity.authHash) {
    const database = sqlite(journal);
    try {
        const claim = { version: 1, origin: 'hub', ...identity, authHash, sourceThreadId: op.sourceNativeThreadId, createdAt: Date.now(), request: op };
        const key = createHash('sha256').update(JSON.stringify([identity.namespace, identity.hub, authHash, op.operationId])).digest('hex');
        database.prepare(`INSERT INTO operations(operation_key, source_thread_id, claim_json, outcome, message, updated_at)
            VALUES (?, ?, ?, 'running', 'Old writer admission', ?)`).run(key, op.sourceNativeThreadId, JSON.stringify(claim), Date.now());
    } finally { database.close(); }
}
const override = (original: ForkOperationRpcRequest, revision: number): ForkOperationRpcRequest => ({ ...original,
    operationId: randomUUID(), childSessionId: randomUUID(), sourceRevision: revision, duplicateRiskOf: original.operationId,
    fingerprint: `confirmed-duplicate-risk-${revision}` });

describe('durable native fork journal', () => {
    it('closes only an absent B without changing A authority, then fences every late B start after reopen', async () => {
        const { journal, home } = await setup(); const a = request({ sourceStoreId: home });
        await journal.admit(a, 'native-parent'); await journal.dispatch(a, 'native-parent', dispatch); await journal.unknown(a, 'native-parent', 'reply lost');
        const before = sourceState(journal); const b = override(a, 2);
        const closed = await journal.closeUnadmitted({ ...b, action: 'close-unadmitted' }, 'native-parent');
        expect(closed.operation).toMatchObject({ operationId: b.operationId, status: 'rejected', rejectionProof: 'not_dispatched', code: 'fork_closed_unadmitted' });
        expect(closed.claim.request.action).toBe('start');
        expect(sourceState(journal)).toEqual(before);
        expect(await journal.discoveryGuard('unclaimed-child')).toBe('unknown');
        const reopened = await ForkJournal.open(home, { ...identity, owner: 'restarted' });
        expect((await reopened.closeUnadmitted(b, 'native-parent')).operation).toEqual(closed.operation);
        expect((await reopened.admit(b, 'native-parent'))).toMatchObject({ admitted: false, entry: { operation: closed.operation } });
        await expect(reopened.dispatch(b, 'native-parent', dispatch)).rejects.toThrow('cannot dispatch');
        expect(sourceState(reopened)).toEqual(before);
    });
    it.each(['running', 'unknown', 'created', 'ready', 'rejected'] as const)('never closes an already admitted %s operation', async state => {
        const { journal, home } = await setup(); const op = request({ sourceStoreId: home });
        await journal.admit(op, 'native-parent');
        if (state === 'rejected') await journal.reject(op, 'native-parent', 'preflight', 'busy');
        else if (state !== 'running') {
            await journal.dispatch(op, 'native-parent', dispatch);
            if (state === 'unknown') await journal.unknown(op, 'native-parent', 'reply lost');
            else { await journal.created(op, 'native-parent', 'exact-child'); if (state === 'ready') await journal.bound(op, 'native-parent'); }
        }
        const before = await journal.read(op, 'native-parent'); const authority = sourceState(journal);
        expect(await journal.closeUnadmitted(op, 'native-parent')).toEqual(before);
        expect(sourceState(journal)).toEqual(authority);
    });
    it('requires the immutable store/source and Hub origin before proving absence', async () => {
        const { journal, home } = await setup(); const op = request({ sourceStoreId: home });
        for (const change of [{ sourceStoreId: undefined }, { sourceStoreId: `${home}-other` }, { sourceNativeThreadId: 'different' }])
            await expect(journal.closeUnadmitted({ ...op, ...change }, 'native-parent')).rejects.toThrow('original exact native store');
        await expect(journal.closeUnadmitted(op, 'native-parent', 'native-gateway')).rejects.toThrow('authenticated Hub');
        expect(await journal.read(op, 'native-parent')).toBeUndefined();
    });
    it('fences delayed old-auth writers in the database as well as the new admission code', async () => {
        const { journal, home } = await setup(); const op = request({ sourceStoreId: home });
        await journal.closeUnadmitted(op, 'native-parent');
        expect(() => oldWriterInsert(journal, op, 'old-auth')).toThrow('UUID already exists');
        const oldAuth = await ForkJournal.open(home, { ...identity, authHash: 'old-auth' });
        await expect(oldAuth.admit(op, 'native-parent')).rejects.toThrow('authenticated scope conflict');
        await expect(oldAuth.closeUnadmitted(op, 'native-parent')).rejects.toThrow('authenticated scope conflict');
        const database = sqlite(journal); try { expect(database.prepare('SELECT count(*) AS n FROM operations').get()).toEqual({ n: 1 }); } finally { database.close(); }
    });
    it('installs guards around existing v1 rows without falsely closing an old writer admitted first', async () => {
        const { journal, home } = await setup(); const op = request({ sourceStoreId: home });
        const database = sqlite(journal); database.exec('DROP TRIGGER fork_operation_uuid_insert_guard; DROP INDEX fork_operation_uuid'); database.close();
        oldWriterInsert(journal, op);
        const reopened = await ForkJournal.open(home, identity);
        expect((await reopened.closeUnadmitted(op, 'native-parent')).operation.status).toBe('running');
        expect(() => oldWriterInsert(reopened, op, 'different-auth')).toThrow('UUID already exists');
    });
    it('preserves old duplicate UUID rows but rejects ambiguity even when one is in the current scope', async () => {
        const { journal, home } = await setup(); const op = request({ sourceStoreId: home });
        await journal.admit(op, 'native-parent');
        const database = sqlite(journal); database.exec('DROP TRIGGER fork_operation_uuid_insert_guard; DROP INDEX fork_operation_uuid'); database.close();
        oldWriterInsert(journal, op, 'foreign-secret-auth');
        const reopened = await ForkJournal.open(home, identity);
        for (const action of [() => reopened.closeUnadmitted(op, 'native-parent'), () => reopened.admit(op, 'native-parent')]) {
            const error = await action().catch(error => error as Error);
            expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain('authenticated scope conflict');
            expect((error as Error).message).not.toContain('foreign-secret-auth');
        }
        const check = sqlite(journal); try { expect(check.prepare('SELECT count(*) AS n FROM operations').get()).toEqual({ n: 2 }); } finally { check.close(); }
    });
    it('rejects same-UUID source or immutable payload conflicts across the whole native store', async () => {
        const { journal, home } = await setup(); const op = request({ sourceStoreId: home }); await journal.admit(op, 'native-parent');
        for (const change of [{ fingerprint: 'changed' }, { childSessionId: randomUUID() }, { sourceNativeThreadId: 'other-source' }, { messageLocalId: 'other-boundary' }]) {
            const changed = { ...op, ...change };
            await expect(journal.closeUnadmitted(changed, changed.sourceNativeThreadId)).rejects.toThrow('immutable request mismatch');
            await expect(journal.admit(changed, changed.sourceNativeThreadId)).rejects.toThrow('immutable request mismatch');
        }
    });
    it('fails closed for a missing identity guard or dangling source authority rather than recording absence', async () => {
        const { journal, home } = await setup(); const a = request({ sourceStoreId: home }); await journal.admit(a, 'native-parent');
        const b = override(a, 2); const database = sqlite(journal);
        database.exec('DROP TRIGGER fork_operation_uuid_insert_guard');
        await expect(journal.closeUnadmitted(b, 'native-parent')).rejects.toThrow('identity guard');
        const reopened = await ForkJournal.open(home, identity);
        database.exec('DELETE FROM operations');
        await expect(reopened.closeUnadmitted(b, 'native-parent')).rejects.toThrow('source authority');
        expect(database.prepare('SELECT count(*) AS n FROM operations').get()).toEqual({ n: 0 }); database.close();
    });
    it.skipIf(Number(process.versions.node.split('.')[0]) < 23)('serializes close and delayed start from two wrapper processes', async () => {
        const { home, journal } = await setup(); const op = request({ sourceStoreId: home });
        const run = promisify(execFile);
        const code = `
            import { registerHooks } from 'node:module';
            import { appendFile } from 'node:fs/promises';
            registerHooks({ resolve(specifier, context, next) {
                try { return next(specifier, context); }
                catch (error) { if (specifier.startsWith('.') && !/\\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context); throw error; }
            }});
            const { ForkJournal } = await import(${JSON.stringify(new URL('./forkJournal.ts', import.meta.url).href)});
            const request = JSON.parse(process.argv[1]);
            const journal = await ForkJournal.open(process.argv[2], { namespace: 'team', hub: 'http://hub', authHash: 'auth', owner: 'pid-' + process.pid });
            if (process.argv[3] === 'close') console.log(JSON.stringify((await journal.closeUnadmitted(request, 'native-parent')).operation));
            else {
                const result = await journal.admit(request, 'native-parent');
                if (result.admitted) {
                    await journal.dispatch(request, 'native-parent', ${JSON.stringify(dispatch)});
                    await appendFile(process.argv[2] + '/close-race-native-writes.txt', 'one\\n');
                }
                console.log(JSON.stringify({ admitted: result.admitted }));
            }
        `;
        const results = await Promise.all(['close', 'start'].map(action => run(process.execPath,
            ['--experimental-transform-types', '--input-type=module', '-e', code, JSON.stringify(op), home, action], { timeout: 15_000 })));
        const closed = JSON.parse(results[0].stdout.trim()); const start = JSON.parse(results[1].stdout.trim());
        const writes = await readFile(join(home, 'close-race-native-writes.txt'), 'utf8').catch(() => '');
        if (start.admitted) { expect(closed.status).toBe('indeterminate'); expect(writes).toBe('one\n'); }
        else { expect(closed).toMatchObject({ status: 'rejected', code: 'fork_closed_unadmitted' }); expect(writes).toBe(''); }
        expect((await journal.admit(op, 'native-parent')).admitted).toBe(false);
    }, 20_000);
    it('skips only POSIX directory sync on Windows while still syncing the marker and committing the journal', async () => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
        filesystem.failDirectorySync = true;
        try {
            const { journal } = await setup();
            const op = request(); await journal.admit(op, 'native-parent'); await journal.dispatch(op, 'native-parent', dispatch);
            expect(filesystem.directoryOpens).toBe(0);
            expect(filesystem.markerSyncs).toBe(1);
            expect((await journal.read(op, 'native-parent'))?.dispatch).toEqual(dispatch);
        } finally { Object.defineProperty(process, 'platform', platform); }
    });
    it('fails closed when required marker durability fails', async () => {
        filesystem.failMarkerSync = true;
        await expect(setup()).rejects.toThrow('injected marker sync failure');
    });
    it.skipIf(process.platform === 'win32')('fails closed when required POSIX directory durability fails', async () => {
        filesystem.failDirectorySync = true;
        await expect(setup()).rejects.toThrow('injected directory sync failure');
    });
    it('allows concurrent first initialization without creating competing journal authorities', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-fork-init-')); homes.push(home);
        const journals = await Promise.all(Array.from({ length: 4 }, (_, i) => ForkJournal.open(home, { ...identity, owner: `wrapper-${i}` })));
        expect(new Set(journals.map(journal => journal.databasePath)).size).toBe(1);
        const outcomes = await Promise.all(journals.map(journal => journal.admit(request(), 'native-parent')));
        expect(outcomes.filter(value => value.admitted)).toHaveLength(1);
    });
    it('reopens the dispatch fence, never readmits or redispatches a recorded operation', async () => {
        const { journal, home } = await setup(); const op = request();
        expect((await journal.admit(op, 'native-parent')).admitted).toBe(true);
        await journal.dispatch(op, 'native-parent', dispatch);
        const reopened = await ForkJournal.open(home, { ...identity, owner: 'process-b' });
        expect((await reopened.read({ ...op, action: 'read' }, 'native-parent'))?.operation.status).toBe('indeterminate');
        expect((await reopened.admit(op, 'native-parent')).admitted).toBe(false);
        await expect(reopened.dispatch(op, 'native-parent', dispatch)).rejects.toThrow('cannot dispatch');
        expect((await reopened.admit(request(), 'native-parent')).entry.operation).toMatchObject({ status: 'rejected', code: 'fork_source_unresolved', rejectionProof: 'not_dispatched' });
    });
    it('fences concurrent source aliases and different wrapper namespaces without an expiring lease', async () => {
        const { journal, home } = await setup(); const alias = `${home}-alias`; homes.push(alias); await symlink(home, alias);
        const second = await ForkJournal.open(alias, { ...identity, owner: 'other-wrapper', namespace: 'other-team' });
        const firstRequest = request(); const secondRequest = request({ sourceSessionId: 'other-hapi-source' });
        const results = await Promise.all([journal.admit(firstRequest, 'native-parent'), second.admit(secondRequest, 'native-parent')]);
        expect(results.filter(result => result.admitted)).toHaveLength(1);
        expect(results.filter(result => result.entry.operation.status === 'rejected')).toHaveLength(1);
        expect(await journal.discoveryGuard('unrelated-native-child')).toBe('unknown');
        expect(await second.read(firstRequest, 'native-parent')).toBeUndefined();
    });
    it('advances only after ready/rejected and preserves exact child through binding errors', async () => {
        const { journal } = await setup(); const op = request();
        await journal.admit(op, 'native-parent'); await journal.dispatch(op, 'native-parent', dispatch);
        await journal.created(op, 'native-parent', 'native-child'); await journal.bound(op, 'native-parent', new Error('flush false'));
        expect((await journal.read(op, 'native-parent'))?.operation).toMatchObject({ status: 'created', nativeThreadId: 'native-child', binding: 'blocked' });
        expect(await journal.discoveryGuard('native-child')).toBe('reserved');
        expect(await journal.discoveryGuard('unrelated-child')).toBe('allow');
        expect((await journal.admit(request(), 'native-parent')).admitted).toBe(false);
        await journal.bound(op, 'native-parent');
        await journal.unknown(op, 'native-parent', 'late stale timeout');
        expect((await journal.read(op, 'native-parent'))?.operation).toMatchObject({ status: 'created', binding: 'ready' });
        expect((await journal.admit(request({ sourceRevision: 2 }), 'native-parent')).admitted).toBe(true);
    });
    it('rejects immutable replay mismatch, corruption, and contradictory child identity', async () => {
        const { journal } = await setup(); const op = request(); await journal.admit(op, 'native-parent');
        await expect(journal.read({ ...op, fingerprint: 'different' }, 'native-parent')).rejects.toThrow('immutable request mismatch');
        await expect(journal.read(op, 'wrong-source')).rejects.toThrow('immutable request mismatch');
        await journal.dispatch(op, 'native-parent', dispatch); await journal.created(op, 'native-parent', 'native-child');
        await expect(journal.created(op, 'native-parent', 'different-child')).rejects.toThrow('conflicting child');
        await writeFile(journal.databasePath, 'broken SQLite journal');
        await expect(journal.read(op, 'native-parent')).rejects.toThrow('Cannot verify durable fork journal');
    });
    it('refuses to adopt a native child already recorded for another operation', async () => {
        const { journal } = await setup(); const first = request(); const second = request({ sourceSessionId: 'other-source' });
        await journal.admit(first, 'native-parent'); await journal.dispatch(first, 'native-parent', dispatch);
        await journal.created(first, 'native-parent', 'native-child'); await journal.bound(first, 'native-parent');
        await journal.admit(second, 'other-native-parent'); await journal.dispatch(second, 'other-native-parent', dispatch);
        await expect(journal.created(second, 'other-native-parent', 'native-child')).rejects.toThrow('immutable request mismatch');
        expect((await journal.knownChild('native-child'))?.operation.operationId).toBe(first.operationId);
        expect((await journal.read(second, 'other-native-parent'))?.operation.status).not.toBe('created');
    });
    it('does not release a pre-dispatch source claim merely because its wrapper restarted', async () => {
        const { journal, home } = await setup(); const op = request(); await journal.admit(op, 'native-parent');
        const reopened = await ForkJournal.open(home, { ...identity, owner: 'restarted' });
        expect((await reopened.read(op, 'native-parent'))?.operation.status).toBe('indeterminate');
        expect((await reopened.admit(request(), 'native-parent')).admitted).toBe(false);
    });
    it.skipIf(Number(process.versions.node.split('.')[0]) < 23)('uses one physical source claim across two real wrapper processes and survives their exit', async () => {
        const { home, journal } = await setup();
        const run = promisify(execFile);
        const code = `
            import { registerHooks } from 'node:module';
            import { appendFile } from 'node:fs/promises';
            registerHooks({ resolve(specifier, context, next) {
                try { return next(specifier, context); }
                catch (error) { if (specifier.startsWith('.') && !/\\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context); throw error; }
            }});
            const { ForkJournal } = await import(${JSON.stringify(new URL('./forkJournal.ts', import.meta.url).href)});
            const request = JSON.parse(process.argv[1]);
            const journal = await ForkJournal.open(process.argv[2], { namespace: 'team', hub: 'http://hub', authHash: 'auth', owner: 'pid-' + process.pid });
            const admitted = await journal.admit(request, 'native-parent');
            if (admitted.admitted) {
                await journal.dispatch(request, 'native-parent', ${JSON.stringify(dispatch)});
                await appendFile(process.argv[2] + '/native-writes.txt', request.operationId + '\\n');
            }
            console.log(JSON.stringify({ admitted: admitted.admitted, request }));
        `;
        const outcomes = await Promise.all([request(), request({ sourceSessionId: 'alias' })].map(op => run(process.execPath,
            ['--experimental-transform-types', '--input-type=module', '-e', code, JSON.stringify(op), home], { timeout: 15_000 })));
        const results = outcomes.map(result => JSON.parse(result.stdout.trim()) as { admitted: boolean; request: ForkOperationRpcRequest });
        expect(results.filter(result => result.admitted)).toHaveLength(1);
        expect((await readFile(join(home, 'native-writes.txt'), 'utf8')).trim().split('\n')).toHaveLength(1);
        const winner = results.find(result => result.admitted)!;
        expect((await journal.read(winner.request, 'native-parent'))?.operation.status).toBe('indeterminate');
        expect((await journal.admit(winner.request, 'native-parent')).admitted).toBe(false);
    }, 20_000);

    it('serializes late created-before-override as a distinct rejected B, never returning A as B', async () => {
        const { journal } = await setup(); const a = request(); await journal.admit(a, 'native-parent'); await journal.dispatch(a, 'native-parent', dispatch);
        await journal.unknown(a, 'native-parent', 'reply lost'); await journal.created(a, 'native-parent', 'child-a');
        const b = override(a, 2); const result = await journal.admit(b, 'native-parent');
        expect(result).toMatchObject({ admitted: false, entry: { operation: { operationId: b.operationId, duplicateRiskOf: a.operationId, status: 'rejected', rejectionProof: 'not_dispatched', code: 'risk_target_resolved' } } });
        expect(sourceState(journal)).toMatchObject({ operationId: a.operationId, revision: 1, blocked: true });
        await expect(journal.dispatch(b, 'native-parent', dispatch)).rejects.toThrow('cannot dispatch');
    });
    it('serializes override-before-late-created without letting late A replace B head', async () => {
        const { journal } = await setup(); const a = request(); await journal.admit(a, 'native-parent'); await journal.dispatch(a, 'native-parent', dispatch);
        await journal.unknown(a, 'native-parent', 'reply lost'); const b = override(a, 2);
        expect((await journal.admit(b, 'native-parent')).admitted).toBe(true);
        await journal.created(a, 'native-parent', 'child-a'); await journal.bound(a, 'native-parent');
        expect(sourceState(journal)).toMatchObject({ operationId: b.operationId, revision: 2, blocked: true });
        await journal.dispatch(b, 'native-parent', { ...dispatch, requestId: 8 });
        await journal.created(b, 'native-parent', 'child-b'); await journal.bound(b, 'native-parent');
        expect((await journal.read(a, 'native-parent'))?.operation).toMatchObject({ status: 'created', nativeThreadId: 'child-a' });
        expect((await journal.read(b, 'native-parent'))?.operation).toMatchObject({ status: 'created', nativeThreadId: 'child-b', duplicateRiskOf: a.operationId });
        expect(sourceState(journal)).toMatchObject({ operationId: b.operationId, blocked: false });
    });
    it.each(['unknown', 'created', 'ready'] as const)('restores CURRENT A %s after B pre-dispatch rejection with a new head revision', async state => {
        const { journal } = await setup(); const a = request(); await journal.admit(a, 'native-parent'); await journal.dispatch(a, 'native-parent', dispatch);
        await journal.unknown(a, 'native-parent', 'reply lost'); const b = override(a, 2); await journal.admit(b, 'native-parent');
        if (state !== 'unknown') await journal.created(a, 'native-parent', 'child-a');
        if (state === 'ready') await journal.bound(a, 'native-parent');
        await journal.reject(b, 'native-parent', 'fork_preflight_rejected', 'source became busy');
        expect(sourceState(journal)).toMatchObject({ operationId: a.operationId, revision: 3, blocked: state !== 'ready' });
        expect((await journal.read(a, 'native-parent'))?.operation.sourceRevision).toBe(1);
        expect((await journal.read(b, 'native-parent'))?.operation).toMatchObject({ status: 'rejected', duplicateRiskOf: a.operationId });
        expect((await journal.admit(request({ sourceRevision: 4 }), 'native-parent')).admitted).toBe(state === 'ready');
    });
    it('keeps superseded unknown outcomes quarantined even when the explicit successor becomes ready', async () => {
        const { journal } = await setup(); const a = request(); await journal.admit(a, 'native-parent'); await journal.dispatch(a, 'native-parent', dispatch);
        await journal.unknown(a, 'native-parent', 'reply lost'); const b = override(a, 2); await journal.admit(b, 'native-parent');
        await journal.dispatch(b, 'native-parent', dispatch); await journal.created(b, 'native-parent', 'child-b'); await journal.bound(b, 'native-parent');
        expect(sourceState(journal).blocked).toBe(false);
        expect((await journal.read(a, 'native-parent'))?.operation.status).toBe('indeterminate');
        expect(await journal.discoveryGuard('uncorrelated-child')).toBe('unknown');
        expect(await journal.discoveryGuard('child-b')).toBe('reserved');
    });
    it('supports A unknown to B unknown to C, and skips rejected B only when C later rejects', async () => {
        const { journal } = await setup(); const a = request(); await journal.admit(a, 'native-parent'); await journal.dispatch(a, 'native-parent', dispatch);
        await journal.unknown(a, 'native-parent', 'reply lost'); const b = override(a, 2); await journal.admit(b, 'native-parent');
        await journal.unknown(b, 'native-parent', 'wrapper acknowledgement lost before dispatch');
        const c = override(b, 3); expect((await journal.admit(c, 'native-parent')).admitted).toBe(true);
        await journal.reject(b, 'native-parent', 'fork_preflight_rejected', 'source busy');
        expect(sourceState(journal)).toMatchObject({ operationId: c.operationId, revision: 3, blocked: true });
        await journal.reject(c, 'native-parent', 'fork_preflight_rejected', 'source busy');
        expect(sourceState(journal)).toMatchObject({ operationId: a.operationId, revision: 4, blocked: true });
        expect((await journal.read(a, 'native-parent'))?.operation.status).toBe('indeterminate');
    });
    it('retains the undispatched B source fence across restart and requires another explicit confirmation for C', async () => {
        const { journal, home } = await setup(); const a = request(); await journal.admit(a, 'native-parent'); await journal.dispatch(a, 'native-parent', dispatch);
        await journal.unknown(a, 'native-parent', 'reply lost'); const b = override(a, 2); await journal.admit(b, 'native-parent');
        const reopened = await ForkJournal.open(home, { ...identity, owner: 'restarted' });
        expect((await reopened.admit(b, 'native-parent')).admitted).toBe(false);
        expect((await reopened.read(b, 'native-parent'))?.operation.status).toBe('indeterminate');
        await expect(reopened.dispatch(b, 'native-parent', dispatch)).rejects.toThrow('cannot dispatch');
        expect((await reopened.admit(request({ sourceRevision: 3 }), 'native-parent')).admitted).toBe(false);
        expect((await reopened.admit(override(b, 3), 'native-parent')).admitted).toBe(true);
    });
    it('requires exact same source, boundary, scope and current unknown head for duplicate-risk admission', async () => {
        const { journal, home } = await setup(); const a = request({ messageLocalId: 'boundary-a' }); await journal.admit(a, 'native-parent');
        expect((await journal.admit(override(a, 2), 'native-parent')).entry.operation).toMatchObject({ status: 'rejected', code: 'risk_target_not_indeterminate' });
        await journal.dispatch(a, 'native-parent', dispatch); await journal.unknown(a, 'native-parent', 'reply lost');
        for (const change of [{ messageLocalId: 'boundary-b' }, { sourceSessionId: 'alias' }, { sourceMachineId: 'other' }, { sourceStoreId: '/other' }]) {
            expect((await journal.admit({ ...override(a, 2), ...change }, 'native-parent')).entry.operation).toMatchObject({ status: 'rejected', code: 'risk_target_mismatch' });
        }
        const other = await ForkJournal.open(home, { ...identity, namespace: 'other-team', owner: 'other' });
        expect((await other.admit(override(a, 2), 'native-parent')).entry.operation).toMatchObject({ status: 'rejected', code: 'risk_target_mismatch' });
        const b = override(a, 2); expect((await journal.admit(b, 'native-parent')).admitted).toBe(true);
        expect((await journal.admit(override(a, 3), 'native-parent')).entry.operation).toMatchObject({ status: 'rejected', code: 'risk_target_mismatch' });
    });
    it('reports trusted native-origin blocker identities only to the same authenticated scope; unrelated source still works', async () => {
        const { journal, home } = await setup(); const a = request(); await journal.admit(a, 'native-parent', 'native-gateway'); await journal.dispatch(a, 'native-parent', dispatch);
        await journal.unknown(a, 'native-parent', 'reply lost');
        const blocked = (await journal.admit(request(), 'native-parent')).entry.operation;
        expect(blocked).toMatchObject({ status: 'rejected', code: 'fork_source_unresolved' });
        expect(blocked.message).toContain(a.operationId); expect(blocked.message).toContain(a.sourceSessionId);
        expect(blocked.message).toContain('native-gateway'); expect(blocked.message).toContain('Web cannot clear');
        expect((await journal.admit(request({ sourceSessionId: 'unrelated', sourceNativeThreadId: 'other-native' }), 'other-native')).admitted).toBe(true);
        const other = await ForkJournal.open(home, { ...identity, namespace: 'other-team' });
        const redacted = (await other.admit(request(), 'native-parent')).entry.operation.message;
        expect(redacted).not.toContain(a.operationId); expect(redacted).not.toContain('source session parent'); expect(redacted).not.toContain('native-gateway');
    });
    it('fails closed for missing/corrupt databases and does not adopt an older filesystem journal', async () => {
        const { home, journal } = await setup(); await rm(journal.databasePath);
        await expect(ForkJournal.open(home, identity)).rejects.toThrow('database is missing');
        const legacy = await mkdtemp(join(tmpdir(), 'hapi-fork-legacy-')); homes.push(legacy);
        const { mkdir } = await import('node:fs/promises'); await mkdir(join(legacy, 'hapi-fork-operations', 'operations'), { recursive: true });
        await expect(ForkJournal.open(legacy, identity)).rejects.toThrow('unsupported format');
    });

    it('rolls back a rejection instead of releasing a source when its restoration predecessor is missing', async () => {
        const { journal } = await setup(); const a = request(); await journal.admit(a, 'native-parent'); await journal.dispatch(a, 'native-parent', dispatch);
        await journal.unknown(a, 'native-parent', 'reply lost'); const b = override(a, 2); await journal.admit(b, 'native-parent');
        const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
        const database = new DatabaseSync(journal.databasePath);
        database.exec(`DELETE FROM operations WHERE operation_key = (SELECT predecessor_key FROM operations WHERE operation_key = (SELECT head_key FROM sources WHERE source_thread_id = 'native-parent'))`);
        database.close();
        await expect(journal.reject(b, 'native-parent', 'fork_preflight_rejected', 'busy')).rejects.toThrow('predecessor identity is missing');
        expect(sourceState(journal)).toMatchObject({ operationId: b.operationId, revision: 2, blocked: true });
        expect((await journal.read(b, 'native-parent'))?.operation.status).toBe('running');
        expect((await journal.admit(request(), 'native-parent')).admitted).toBe(false);
    });

    it('accepts a Hub-only rejected B revision gap when C4 explicitly confirms the still-current A1', async () => {
        const { journal } = await setup(); const a = request({ sourceRevision: 1 });
        await journal.admit(a, 'native-parent'); await journal.dispatch(a, 'native-parent', dispatch); await journal.unknown(a, 'native-parent', 'reply lost');
        // Hub admitted/rejected B2 locally and restored its head at revision3; CLI never saw B.
        const c = override(a, 4);
        expect((await journal.admit(c, 'native-parent')).admitted).toBe(true);
        await journal.dispatch(c, 'native-parent', { ...dispatch, requestId: 10 });
        expect((await journal.read(c, 'native-parent'))?.operation).toMatchObject({ operationId: c.operationId, sourceRevision: 4, duplicateRiskOf: a.operationId });
        expect(sourceState(journal).operationId).toBe(c.operationId);
    });

});
