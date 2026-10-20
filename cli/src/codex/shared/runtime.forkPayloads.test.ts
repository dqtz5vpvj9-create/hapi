import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentState, Metadata } from '@/api/types';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { NativeStopFixture } from '@/test/nativeStopFixture';
import { record, type GatewayHooks } from './gateway';
import { runSharedRuntime, type RuntimeReady } from './runtime';
import { ForkJournal } from './forkJournal';
import { readRuntimes, runtimeAuthHash } from './registry';

type NativeThread = { id: string; cwd: string; historyMode: string; status: { type: string }; turns: Record<string, unknown>[] };
type RequestReceipt = { method: string; params: Record<string, unknown>; turns: number; bytes: number };
const native = vi.hoisted(() => ({
    home: '', sessions: [] as TestSession[], clients: [] as NativeClient[], threads: new Map<string, NativeThread>(),
    settings: new Map<string, Record<string, unknown>>(), histories: new Map<string, NativeStopFixture>(),
    requests: [] as RequestReceipt[], hooks: undefined as GatewayHooks | undefined, forkError: false, flushFailure: false,
}));

class TestSession extends EventEmitter {
    readonly sessionId: string;
    state: AgentState = {};
    metadata: Metadata;
    rpc = new Map<string, (raw: unknown) => Promise<unknown>>();
    rpcHandlerManager = { registerHandler: (name: string, handler: (raw: unknown) => Promise<unknown>) => this.rpc.set(name, handler) };
    messages: unknown[] = [];
    snapshots: unknown[] = [];
    readiness = 0;
    runtime?: Record<string, unknown>;
    constructor(cwd: string, overrides: Partial<Metadata>, sessionId = `session-${native.sessions.length}`) {
        super(); this.sessionId = sessionId; this.metadata = { path: cwd, host: 'test', flavor: 'codex', ...overrides };
    }
    getMetadata() { return this.metadata; }
    updateMetadata(fn: (value: Metadata) => Metadata) { this.metadata = fn(this.metadata); }
    updateAgentState(fn: (value: AgentState) => AgentState) { this.state = fn(this.state); }
    onUserMessage() {} onCancelQueuedMessage() {} onRetryQueuedMessage() {} onReconnect() {}
    keepAlive(_thinking: boolean, _mode: unknown, runtime: Record<string, unknown>) { this.runtime = runtime; }
    emitSessionReady() { this.readiness++; }
    emitNativeHistoryChanged() {} emitMessagesConsumed() {} emitSteerIndeterminate() {}
    async setSteerDeliveryState() { return true; }
    syncNativeQueuedMessage() {}
    syncNativeQueueSnapshot(items: unknown[]) { this.snapshots.push(items); }
    sendUserMessage(text: string) { this.messages.push(text); }
    sendAgentMessage(value: unknown) { this.messages.push(value); }
    sendSessionEvent(value: unknown) { this.messages.push(value); }
    sendSessionDeath() {} async flush() { return !(native.flushFailure && this.metadata.forkedFrom); } close() {}
}

class NativeClient {
    initialized = false;
    notify?: (method: string, params: unknown) => void;
    constructor() { native.clients.push(this); }
    setNotificationHandler(handler: typeof this.notify) { this.notify = handler; }
    setTransportAbandonedHandler() {} setServerRequestHandler() {}
    async connect() {} async initialize() { this.initialized = true; }
    isInitialized() { return this.initialized; }
    async disconnect() { this.initialized = false; }
    async supportsMethod() { return true; }
    async requestTracked(method: 'thread/fork', params: Record<string, unknown>, options: { beforeSend(identity: { requestId: number; transportGeneration: number }): Promise<void> }) {
        await options.beforeSend({ requestId: native.requests.length + 1, transportGeneration: 1 });
        return this.request(method, params);
    }
    async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
        let threadId = String(params.threadId ?? 'parent');
        let value: unknown;
        if (method === 'thread/fork' || method === 'thread/start') {
            threadId = method === 'thread/fork' ? `fork-${native.threads.size}` : 'parent';
            if (method === 'thread/fork') {
                native.threads.set(threadId, { ...native.threads.get(String(params.threadId))!, id: threadId });
                native.settings.set(threadId, { ...native.settings.get(String(params.threadId)), collaborationMode: { mode: 'default' } });
                const fixture = new NativeStopFixture(native.home, threadId);
                const parent = native.histories.get(String(params.threadId))!;
                fixture.turns.push(...parent.turns); fixture.items.push(...parent.items);
                // A sparse native fork keeps inherited rows in the parent index.
                // Its public item RPC still serves them under the child's ID.
                const directory = join(native.home, 'sessions', '2026', '10', '11');
                await mkdir(directory, { recursive: true });
                await writeFile(join(directory, `rollout-test-${threadId}.jsonl`), JSON.stringify({ type: 'session_meta', ordinal: 0,
                    payload: { id: threadId, forked_from_id: params.threadId, forked_from_ordinal_exclusive: 161 } }) + '\n');
                native.histories.set(threadId, fixture);
            }
            value = this.lifecycle(threadId, params.excludeTurns === true);
        } else if (method === 'thread/resume') {
            value = this.lifecycle(threadId, params.excludeTurns === true);
            // Native resume's response omits collaboration mode. The independent
            // control subscription retains its authoritative settings event.
            for (const client of native.clients) client.notify?.('thread/settings/updated', {
                threadId, threadSettings: native.settings.get(threadId)
            });
        } else if (method === 'thread/read') {
            const thread = native.threads.get(threadId)!;
            value = { thread: { ...thread, turns: params.includeTurns === true ? thread.turns : [] } };
        } else if (method === 'thread/turns/list') {
            if (params.itemsView === 'notLoaded') value = await native.histories.get(threadId)!.request(method, params);
            else {
                const turns = native.threads.get(threadId)!.turns;
                value = { data: params.limit === 1 ? turns.slice(-1) : turns, nextCursor: null };
            }
        } else if (method === 'thread/items/list') value = await native.histories.get(threadId)!.request(method, params);
        else if (method === 'thread/loaded/list') value = { data: ['parent'], nextCursor: null };
        else if (method === 'thread/list') value = { data: [], nextCursor: null };
        else if (method === 'thread/queue/list') value = { data: threadId === 'parent' ? [] : [{
            id: 'queued-native', clientUserMessageId: 'queued-local', input: [{ type: 'text', text: 'preserved queue', text_elements: [] }]
        }] };
        else if (method === 'thread/queue/delete') value = { deleted: true };
        else if (method === 'thread/goal/get') value = { goal: { threadId, objective: 'preserved goal', status: 'paused', tokensUsed: 99 } };
        else if (method === 'thread/metadata/update') value = {};
        else if (method === 'thread/settings/update') {
            const settings = { ...native.settings.get(threadId), ...params };
            native.settings.set(threadId, settings);
            for (const client of native.clients) client.notify?.('thread/settings/updated', { threadId, threadSettings: settings });
            value = {};
        } else if (method === 'turn/interrupt') value = {};
        else throw new Error(`Unexpected native request: ${method}`);
        // Model the wire contract, including its expensive default full-turn
        // response. Changing just a mock expectation cannot make this bounded.
        const wire = JSON.stringify(value);
        native.requests.push({ method, params, turns: Array.isArray(record(record(value).thread).turns)
            ? (record(record(value).thread).turns as unknown[]).length : 0, bytes: Buffer.byteLength(wire) });
        if (method === 'thread/fork' && native.forkError) throw new Error('native inherited goal failed after creation');
        return JSON.parse(wire);
    }
    private lifecycle(threadId: string, excludeTurns: boolean) {
        const { collaborationMode: _mode, ...settings } = native.settings.get(threadId)!;
        const thread = native.threads.get(threadId)!;
        return { ...settings, thread: { ...thread, turns: excludeTurns ? [] : thread.turns } };
    }
}
vi.mock('../codexAppServerClient', () => ({ CodexAppServerClient: class { constructor() { return new NativeClient(); } }, isIndeterminateError: () => false }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/configuration', () => ({ configuration: { get happyHomeDir() { return native.home; }, apiUrl: 'http://mock-hub', cliApiToken: 'test' } }));
vi.mock('@/agent/sessionFactory', () => ({ bootstrapSession: async (options: { workingDirectory: string; metadataOverrides: Partial<Metadata>; reservedSessionId?: string; newSessionId?: string }) => {
    if (options.reservedSessionId && options.newSessionId) throw new Error('Conflicting session creation identities');
    const existing = options.reservedSessionId && native.sessions.find(session => session.sessionId === options.reservedSessionId);
    if (options.newSessionId && native.sessions.some(session => session.sessionId === options.newSessionId)) throw new Error('New session ID collision');
    const session = existing || new TestSession(options.workingDirectory, options.metadataOverrides, options.newSessionId ?? options.reservedSessionId);
    if (!existing) native.sessions.push(session);
    session.metadata = { ...session.metadata, ...options.metadataOverrides };
    return { session, workingDirectory: options.workingDirectory, sessionInfo: { namespace: 'test' }, machineId: 'test-machine', metadata: session.metadata };
}, bootstrapExistingSession: async (options: { sessionId: string; workingDirectory: string; metadataOverrides: Partial<Metadata> }) => {
    const session = native.sessions.find(session => session.sessionId === options.sessionId);
    if (!session) throw new Error('Missing reserved existing child');
    session.metadata = { ...session.metadata, ...options.metadataOverrides };
    return { session, workingDirectory: options.workingDirectory, sessionInfo: { namespace: 'test' }, machineId: 'test-machine', metadata: session.metadata };
} }));
vi.mock('@/runner/controlClient', () => ({ notifyRunnerSessionStarted: vi.fn(async () => ({})) }));
vi.mock('../utils/buildHapiMcpBridge', () => ({ buildHapiMcpBridge: async () => ({ mcpServers: { hapi: {} }, server: { stop() {} } }) }));
vi.mock('./launch', async importOriginal => ({ ...await importOriginal<typeof import('./launch')>(), resolveSharedCodex: () => ({ command: 'mock-codex', args: [] }) }));
vi.mock('./gateway', async importOriginal => ({ ...await importOriginal<typeof import('./gateway')>(),
    startCodexGateway: async (options: { hooks: GatewayHooks }) => { native.hooks = options.hooks; return { endpoint: 'mock-gateway', async close() {} }; }
}));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: () => {
    const child = new EventEmitter(); return Object.assign(child, { pid: process.pid, exitCode: null, signalCode: null });
} }));
vi.mock('@/utils/process', async importOriginal => ({ ...await importOriginal<typeof import('@/utils/process')>(), killProcessByChildProcess: async () => true }));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    for (const fixture of native.histories.values()) fixture.close();
    await rm(native.home, { recursive: true, force: true });
    native.sessions = []; native.clients = []; native.requests = []; native.threads.clear(); native.settings.clear(); native.histories.clear(); native.hooks = undefined;
    native.forkError = false; native.flushFailure = false;
    vi.unstubAllEnvs();
});
async function start(external: boolean) {
    native.home = await mkdtemp(join(tmpdir(), 'hapi-fork-payload-'));
    vi.stubEnv('CODEX_HOME', native.home);
    native.threads.set('parent', { id: 'parent', cwd: native.home, historyMode: 'paginated', status: { type: 'idle' },
        turns: Array.from({ length: 40 }, (_, i) => ({ id: `turn-${i}`, status: 'completed', items: [{ id: `answer-${i}`, type: 'agentMessage', text: 'x'.repeat(2048) }] })) });
    native.settings.set('parent', { model: 'mock-model', modelProvider: 'mock', cwd: native.home, effort: 'high',
        serviceTier: 'priority', approvalPolicy: 'on-request', approvalsReviewer: 'user',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [native.home], networkAccess: false },
        personality: 'friendly', collaborationMode: { mode: 'plan', settings: { model: 'mock-model', reasoning_effort: 'high', developer_instructions: null } } });
    const history = new NativeStopFixture(native.home, 'parent');
    for (let i = 0; i < 40; i++) history.addTurn(`turn-${i}`, 'completed', false, true);
    native.histories.set('parent', history);
    const ready = Promise.withResolvers<RuntimeReady>();
    const abort = new AbortController();
    const running = runSharedRuntime({ workingDirectory: native.home, ...(external ? { nativeEndpoint: 'mock-native' } : {}) }, ready.resolve, abort.signal);
    cleanups.push(async () => { abort.abort(); await running; });
    await Promise.race([ready.promise, running.then(() => { throw new Error('Runtime stopped before ready'); })]);
    native.requests = [];
    return native.sessions[0];
}

async function seedKnownFork(parent: TestSession, ready: boolean, authHash = runtimeAuthHash()) {
    const journal = await ForkJournal.open(native.home, { namespace: 'test', hub: 'http://mock-hub', authHash, owner: 'previous-crashed-runtime' });
    const operation = { action: 'start' as const, operationId: randomUUID(), sourceSessionId: parent.sessionId, sourceNativeThreadId: 'parent',
        sourceMachineId: 'test-machine', sourceStoreId: native.home, childSessionId: randomUUID(), sourceRevision: 1, fingerprint: 'crash-window' };
    // The Hub row is reserved before dispatch, but no runtime registry binding exists yet.
    const child = new TestSession(native.home, { forkedFrom: parent.sessionId }, operation.childSessionId); native.sessions.push(child);
    await journal.admit(operation, 'parent');
    await journal.dispatch(operation, 'parent', { requestId: 1, transportGeneration: 1, plan: { params: { threadId: 'parent' }, settings: {} } });
    const response = record(await native.clients[0].request('thread/fork', { threadId: 'parent', excludeTurns: true }));
    const threadId = String(record(response.thread).id);
    await journal.created(operation, 'parent', threadId);
    if (ready) { child.metadata.codexSessionId = threadId; await journal.bound(operation, 'parent'); }
    return { journal, operation, child, threadId };
}

describe('shared runtime fork response payloads', () => {
    it.each([true, false])('bounds only external Web-created fork and subscription responses (external=%s)', async external => {
        const parent = await start(external);
        const result = record(await parent.rpc.get(RPC_METHODS.ForkConversation)!({}));
        const child = native.sessions.find(session => session.sessionId === result.sessionId)!;
        const threadId = String(result.nativeSessionId);
        const fork = native.requests.find(request => request.method === 'thread/fork')!;
        const resumes = native.requests.filter(request => request.method === 'thread/resume' && request.params.threadId === threadId);
        expect(fork.params).toMatchObject({ threadId: 'parent', deferGoalContinuation: true,
            model: 'mock-model', modelProvider: 'mock', approvalPolicy: 'on-request', approvalsReviewer: 'user',
            sandbox: 'workspace-write', serviceTier: 'priority', personality: 'friendly', config: {
                'sandbox_workspace_write.writable_roots': [native.home], 'sandbox_workspace_write.network_access': false, model_reasoning_effort: 'high'
            } });
        expect(fork.params.excludeTurns).toBe(external ? true : undefined);
        expect(fork.turns).toBe(external ? 0 : 40);
        expect(resumes.length).toBeGreaterThan(0);
        for (const resume of resumes) {
            expect(resume.params).toEqual({ threadId, ...(external ? { excludeTurns: true } : {}) });
            expect(resume.turns).toBe(external ? 0 : 40);
        }
        expect(child.readiness).toBe(1);
        expect(child.metadata).toMatchObject({ codexSessionId: threadId, forkedFrom: parent.sessionId });
        expect(child.runtime).toMatchObject({ model: 'mock-model', modelReasoningEffort: 'high', permissionMode: 'default',
            serviceTier: 'fast', collaborationMode: 'plan', execution: { status: 'idle', turnId: 'turn-39' } });
        expect(child.snapshots).toContainEqual([{ localId: 'queued-local', text: 'preserved queue' }]);
        expect(child.state.threadGoal).toMatchObject({ objective: 'preserved goal', status: 'paused', tokensUsed: 99 });
        expect(native.requests.some(request => request.method === 'turn/start' || request.method === 'thread/queue/start')).toBe(false);
        if (external) {
            expect(fork.bytes).toBeLessThan(2048);
            expect(child.messages).toEqual([]);
            expect(native.requests.some(request => request.method === 'thread/items/list')).toBe(false);
            const history = record(await child.rpc.get(RPC_METHODS.ReadCodexHistory)!({ limit: 10 }));
            expect(JSON.stringify(history.messages)).toContain('ANSWER turn-39');
            expect(native.requests.some(request => request.method === 'thread/items/list')).toBe(true);
            expect(child.messages).toEqual([]);
        } else expect(child.messages.length).toBeGreaterThan(0);
    });

    it.each([undefined, true, false])('preserves the external frontend fork response preference through binding (excludeTurns=%s)', async excludeTurns => {
        await start(true);
        const request = { id: 1, method: 'thread/fork', params: { threadId: 'parent', ...(excludeTurns !== undefined ? { excludeTurns } : {}) } };
        const forwarded = await native.hooks!.before(request, 'frontend');
        expect(record(forwarded.params)).toEqual({ ...request.params, deferGoalContinuation: true });
        const response = { id: 1, result: await native.clients[0].request('thread/fork', record(forwarded.params)) };
        const snapshot = structuredClone(response);
        const thread = record(record(response.result).thread);
        expect(thread.turns).toHaveLength(excludeTurns === true ? 0 : 40);
        await native.hooks!.after(forwarded, response, 'frontend');
        expect(response).toEqual(snapshot);
        const resumes = native.requests.filter(value => value.method === 'thread/resume' && value.params.threadId === thread.id);
        expect(resumes.length).toBeGreaterThan(0);
        expect(resumes.every(value => value.params.excludeTurns === true && value.turns === 0)).toBe(true);
        expect(native.sessions.at(-1)!.readiness).toBe(1);
    });
    it('keeps a native child on explicit post-create error and blocks both native and Web retries', async () => {
        const parent = await start(true); native.forkError = true;
        const operation = { action: 'start', operationId: randomUUID(), sourceSessionId: parent.sessionId, childSessionId: randomUUID(), sourceRevision: 1, sourceNativeThreadId: 'parent', sourceMachineId: 'test-machine', sourceStoreId: native.home, fingerprint: 'current' };
        const result = record(await parent.rpc.get(RPC_METHODS.ForkOperation)!(operation));
        expect(record(result.operation).status).toBe('indeterminate');
        expect(native.threads.size).toBe(2);
        await parent.rpc.get(RPC_METHODS.ForkOperation)!(operation);
        await expect(native.hooks!.before({ id: 88, method: 'thread/fork', params: { threadId: 'parent' } }, 'other-client')).rejects.toThrow('unresolved fork');
        expect(native.requests.filter(value => value.method === 'thread/fork')).toHaveLength(1);
        // The lost-reply native child has not been accidentally adopted into another HAPI row.
        const childId = [...native.threads.keys()].find(id => id !== 'parent')!;
        expect(native.sessions.filter(session => session.metadata.codexSessionId === childId)).toHaveLength(0);
    });
    it('treats a real false flush as created/blocked and reconciles the exact reserved child', async () => {
        const parent = await start(true); native.flushFailure = true;
        const operation = { action: 'start', operationId: randomUUID(), sourceSessionId: parent.sessionId, childSessionId: randomUUID(), sourceRevision: 1, sourceNativeThreadId: 'parent', sourceMachineId: 'test-machine', sourceStoreId: native.home, fingerprint: 'current' };
        const result = record(await parent.rpc.get(RPC_METHODS.ForkOperation)!(operation));
        expect(record(result.operation)).toMatchObject({ status: 'created', binding: 'blocked', childSessionId: operation.childSessionId });
        const childId = record(result.operation).nativeThreadId;
        native.flushFailure = false;
        const recovered = record(await parent.rpc.get(RPC_METHODS.ForkOperation)!({ ...operation, action: 'reconcile' }));
        expect(record(recovered.operation)).toMatchObject({ status: 'created', binding: 'ready', nativeThreadId: childId, childSessionId: operation.childSessionId });
        expect(native.requests.filter(value => value.method === 'thread/fork')).toHaveLength(1);
        expect(native.sessions.filter(session => session.sessionId === operation.childSessionId)).toHaveLength(1);
    });

    it('expires unknown native child observer sockets while retaining the source fence', async () => {
        const parent = await start(true); native.forkError = true;
        let expire: (() => void) | undefined;
        const original = globalThis.setTimeout;
        const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
            const timer = original(handler, delay, ...args);
            if (delay === 320_000) expire = () => { clearTimeout(timer); handler(...args); };
            return timer;
        }) as typeof setTimeout);
        try {
            const operation = { action: 'start', operationId: randomUUID(), sourceSessionId: parent.sessionId, childSessionId: randomUUID(), sourceRevision: 1, sourceNativeThreadId: 'parent', sourceMachineId: 'test-machine', sourceStoreId: native.home, fingerprint: 'current' };
            expect(record(record(await parent.rpc.get(RPC_METHODS.ForkOperation)!(operation)).operation).status).toBe('indeterminate');
            const childClient = native.clients.at(-1)!;
            expect(childClient.initialized).toBe(true);
            expect(expire).toBeTypeOf('function'); expire!();
            await vi.waitFor(() => expect(childClient.initialized).toBe(false));
            expect(record(record(await parent.rpc.get(RPC_METHODS.ForkOperation)!({ ...operation, action: 'read' })).operation).status).toBe('indeterminate');
            await parent.rpc.get(RPC_METHODS.ForkOperation)!(operation);
            expect(native.requests.filter(value => value.method === 'thread/fork')).toHaveLength(1);
        } finally { timers.mockRestore(); }
    });

    it('validates the authenticated source and immutable replay before any additional native write', async () => {
        const parent = await start(true);
        const operation = { action: 'start', operationId: randomUUID(), sourceSessionId: parent.sessionId, childSessionId: randomUUID(), sourceRevision: 1, sourceNativeThreadId: 'parent', sourceMachineId: 'test-machine', sourceStoreId: native.home, fingerprint: 'current' };
        await expect(parent.rpc.get(RPC_METHODS.ForkOperation)!({ ...operation, sourceSessionId: 'forged-source' })).rejects.toThrow('authenticated session');
        expect(native.requests.some(value => value.method === 'thread/fork')).toBe(false);
        await parent.rpc.get(RPC_METHODS.ForkOperation)!(operation);
        await expect(parent.rpc.get(RPC_METHODS.ForkOperation)!({ ...operation, fingerprint: 'changed-boundary' })).rejects.toThrow('immutable request mismatch');
        expect(native.requests.filter(value => value.method === 'thread/fork')).toHaveLength(1);
    });
    it('closes an unadmitted Hub request through the real root without native work and rejects its delayed start', async () => {
        const parent = await start(true);
        const operation = { action: 'close-unadmitted', operationId: randomUUID(), sourceSessionId: parent.sessionId,
            childSessionId: randomUUID(), sourceRevision: 1, sourceNativeThreadId: 'parent', sourceMachineId: 'test-machine',
            sourceStoreId: native.home, fingerprint: 'captured-original' };
        const rpc = parent.rpc.get(RPC_METHODS.ForkOperation)!;
        const requests = native.requests.length; const sessions = native.sessions.length;
        for (const changed of [{ sourceSessionId: 'forged' }, { sourceNativeThreadId: 'other' }, { sourceMachineId: 'other' },
            { sourceStoreId: undefined }, { sourceStoreId: '/other-store' }]) await expect(rpc({ ...operation, ...changed })).rejects.toThrow();
        expect(await rpc(operation)).toMatchObject({ operation: { operationId: operation.operationId,
            status: 'rejected', code: 'fork_closed_unadmitted', rejectionProof: 'not_dispatched' } });
        expect(await rpc({ ...operation, action: 'start' })).toMatchObject({ operation: { status: 'rejected', code: 'fork_closed_unadmitted' } });
        expect(native.requests).toHaveLength(requests); expect(native.sessions).toHaveLength(sessions);
    });
    it('records definite local preflight rejection before native dispatch', async () => {
        const parent = await start(true); parent.metadata.codexNativeConnection = 'history';
        const operation = { action: 'start', operationId: randomUUID(), sourceSessionId: parent.sessionId, childSessionId: randomUUID(), sourceRevision: 1, sourceNativeThreadId: 'parent', sourceMachineId: 'test-machine', sourceStoreId: native.home, fingerprint: 'current' };
        const result = record(await parent.rpc.get(RPC_METHODS.ForkOperation)!(operation));
        expect(record(result.operation)).toMatchObject({ status: 'rejected', rejectionProof: 'not_dispatched' });
        expect(native.requests.some(value => value.method === 'thread/fork')).toBe(false);
    });

    it('rejects a frozen native/machine/store source mismatch before dispatch and read/reconcile', async () => {
        const parent = await start(true);
        for (const changed of [{ sourceNativeThreadId: 'other-native' }, { sourceMachineId: 'other-machine' }, { sourceStoreId: '/other-store' }]) {
            const operation = { action: 'start', operationId: randomUUID(), sourceSessionId: parent.sessionId, childSessionId: randomUUID(), sourceRevision: 1,
                sourceNativeThreadId: 'parent', sourceMachineId: 'test-machine', sourceStoreId: native.home, fingerprint: 'current', ...changed };
            const result = record(await parent.rpc.get(RPC_METHODS.ForkOperation)!(operation));
            expect(record(result.operation)).toMatchObject({ status: 'rejected', rejectionProof: 'not_dispatched' });
            await expect(parent.rpc.get(RPC_METHODS.ForkOperation)!({ ...operation, action: 'read' })).rejects.toThrow('source identity changed');
            await expect(parent.rpc.get(RPC_METHODS.ForkOperation)!({ ...operation, action: 'reconcile' })).rejects.toThrow('source identity changed');
        }
        expect(native.requests.some(value => value.method === 'thread/fork')).toBe(false);
    });

    it('blocks native cold resume in the created-before-registry crash window without a new HAPI identity', async () => {
        const parent = await start(true); const { operation, threadId } = await seedKnownFork(parent, false);
        const count = native.sessions.length;
        await expect(native.hooks!.before({ id: 91, method: 'thread/resume', params: { threadId } }, 'cold-native')).rejects.toThrow('binding is pending');
        await expect(native.hooks!.control('hapi/connectThread', { threadId })).rejects.toThrow('binding is pending');
        expect(native.sessions).toHaveLength(count);
        expect(native.sessions.filter(session => session.sessionId === operation.childSessionId)).toHaveLength(1);
        expect(native.requests.filter(value => value.method === 'thread/fork')).toHaveLength(1);
        expect(native.requests.some(value => value.method === 'thread/resume' && value.params.threadId === threadId)).toBe(false);
        const recovered = record(await parent.rpc.get(RPC_METHODS.ForkOperation)!({ ...operation, action: 'reconcile' }));
        expect(record(recovered.operation)).toMatchObject({ status: 'created', binding: 'ready', childSessionId: operation.childSessionId, nativeThreadId: threadId });
        expect(native.sessions).toHaveLength(count);
        expect(native.requests.filter(value => value.method === 'thread/fork')).toHaveLength(1);
    });
    it('blocks managed startup in the same created-before-registry window', async () => {
        const parent = await start(true); const { threadId } = await seedKnownFork(parent, false); const count = native.sessions.length;
        await expect(runSharedRuntime({ workingDirectory: native.home, resumeSessionId: threadId })).rejects.toThrow('binding is pending');
        expect(native.sessions).toHaveLength(count);
        expect(native.requests.filter(value => value.method === 'thread/fork')).toHaveLength(1);
        expect(native.requests.some(value => value.method === 'thread/resume' && value.params.threadId === threadId)).toBe(false);
    });
    it('resumes a ready native child with missing registry mirrors into its exact reserved HAPI row', async () => {
        const parent = await start(true); const { operation, threadId } = await seedKnownFork(parent, true);
        const count = native.sessions.length;
        const request = await native.hooks!.before({ id: 92, method: 'thread/resume', params: { threadId } }, 'cold-native');
        const response = { id: 92, result: await native.clients[0].request('thread/resume', record(request.params)) };
        await native.hooks!.after(request, response, 'cold-native');
        expect(native.sessions).toHaveLength(count);
        const child = native.sessions.find(session => session.sessionId === operation.childSessionId)!;
        expect(child.metadata).toMatchObject({ codexSessionId: threadId, forkedFrom: parent.sessionId });
        expect(child.readiness).toBe(1);
        expect(native.requests.filter(value => value.method === 'thread/fork')).toHaveLength(1);
    });
    it('resumes a ready known child at managed startup without a registry mirror or second fork', async () => {
        const parent = await start(true); const { operation, threadId } = await seedKnownFork(parent, true); const count = native.sessions.length;
        const ready = Promise.withResolvers<RuntimeReady>(); const abort = new AbortController();
        const running = runSharedRuntime({ workingDirectory: native.home, resumeSessionId: threadId }, ready.resolve, abort.signal);
        try {
            const result = await Promise.race([ready.promise, running.then(() => { throw new Error('Runtime stopped before ready'); })]);
            expect(result.sessionId).toBe(operation.childSessionId);
            expect(native.sessions).toHaveLength(count);
            expect(native.sessions.find(session => session.sessionId === operation.childSessionId)?.metadata.forkedFrom).toBe(parent.sessionId);
            expect(native.requests.filter(value => value.method === 'thread/fork')).toHaveLength(1);
        } finally { abort.abort(); await running; }
    });
    it('rejects a foreign-auth known child before bootstrap', async () => {
        const parent = await start(true); const { threadId } = await seedKnownFork(parent, true, 'foreign-auth'); const count = native.sessions.length;
        await expect(native.hooks!.before({ id: 93, method: 'thread/resume', params: { threadId } }, 'cold-native')).rejects.toThrow('another authenticated HAPI namespace');
        expect(native.sessions).toHaveLength(count);
        expect(native.requests.some(value => value.method === 'thread/resume' && value.params.threadId === threadId)).toBe(false);
    });

    it('rejects a managed requested HAPI identity conflicting with the known ready reservation', async () => {
        const parent = await start(true); const { threadId } = await seedKnownFork(parent, true); const count = native.sessions.length;
        await expect(runSharedRuntime({ workingDirectory: native.home, resumeSessionId: threadId, existingSessionId: randomUUID() })).rejects.toThrow('reserved HAPI binding');
        expect(native.sessions).toHaveLength(count);
        expect(native.requests.some(value => value.method === 'thread/resume' && value.params.threadId === threadId)).toBe(false);
    });

    it('clears gateway pending ownership after a proven pre-dispatch journal failure', async () => {
        await start(true);
        const dispatch = vi.spyOn(ForkJournal.prototype, 'dispatch').mockRejectedValueOnce(new Error('journal failed before dispatch'));
        try {
            await expect(native.hooks!.before({ id: 94, method: 'thread/fork', params: { threadId: 'parent' } }, 'native-client')).rejects.toThrow('journal failed before dispatch');
            const reserved = native.sessions.at(-1)!.sessionId;
            expect((await readRuntimes()).some(runtime => runtime.pendingCreations?.includes(reserved))).toBe(false);
            expect(native.requests.some(value => value.method === 'thread/fork')).toBe(false);
        } finally { dispatch.mockRestore(); }
    });

    it('does not archive an existing ready child when cold wrapper preparation fails without registry mirrors', async () => {
        const parent = await start(true); const { journal, operation, child, threadId } = await seedKnownFork(parent, true);
        const initialize = vi.spyOn(NativeClient.prototype, 'initialize').mockRejectedValueOnce(new Error('observer initialization failed'));
        try {
            await expect(native.hooks!.before({ id: 95, method: 'thread/resume', params: { threadId } }, 'cold-native')).rejects.toThrow('observer initialization failed');
            expect(child.metadata.lifecycleState).not.toBe('archived');
            expect(native.sessions.filter(session => session.sessionId === operation.childSessionId)).toHaveLength(1);
            expect((await journal.knownChild(threadId))?.operation).toMatchObject({ status: 'created', binding: 'ready', childSessionId: operation.childSessionId });
        } finally { initialize.mockRestore(); }
    });

    it('allows only explicit same-source duplicate-risk B after unknown A and keeps A discovery quarantine', async () => {
        const parent = await start(true); native.forkError = true;
        const a = { action: 'start', operationId: randomUUID(), sourceSessionId: parent.sessionId, childSessionId: randomUUID(), sourceRevision: 1,
            sourceNativeThreadId: 'parent', sourceMachineId: 'test-machine', sourceStoreId: native.home, fingerprint: 'current' };
        expect(record(record(await parent.rpc.get(RPC_METHODS.ForkOperation)!(a)).operation).status).toBe('indeterminate');
        native.forkError = false;
        const ordinary = { ...a, operationId: randomUUID(), childSessionId: randomUUID(), sourceRevision: 2 };
        expect(record(record(await parent.rpc.get(RPC_METHODS.ForkOperation)!(ordinary)).operation)).toMatchObject({ status: 'rejected', code: 'fork_source_unresolved' });
        const b = { ...ordinary, operationId: randomUUID(), duplicateRiskOf: a.operationId, fingerprint: 'confirmed-risk' };
        expect(record(record(await parent.rpc.get(RPC_METHODS.ForkOperation)!(b)).operation)).toMatchObject({ status: 'created', binding: 'ready', duplicateRiskOf: a.operationId });
        expect(record(record(await parent.rpc.get(RPC_METHODS.ForkOperation)!({ ...a, action: 'read' })).operation).status).toBe('indeterminate');
        expect(native.requests.filter(value => value.method === 'thread/fork')).toHaveLength(2);
        const journal = await ForkJournal.open(native.home, { namespace: 'test', hub: 'http://mock-hub', authHash: runtimeAuthHash(), owner: 'observer' });
        expect(await journal.discoveryGuard('uncorrelated')).toBe('unknown');
    });
    it('requires a new explicit confirmation after B also becomes unknown before C', async () => {
        const parent = await start(true); native.forkError = true;
        const a = { action: 'start', operationId: randomUUID(), sourceSessionId: parent.sessionId, childSessionId: randomUUID(), sourceRevision: 1,
            sourceNativeThreadId: 'parent', sourceMachineId: 'test-machine', sourceStoreId: native.home, fingerprint: 'current' };
        await parent.rpc.get(RPC_METHODS.ForkOperation)!(a);
        const b = { ...a, operationId: randomUUID(), childSessionId: randomUUID(), sourceRevision: 2, duplicateRiskOf: a.operationId, fingerprint: 'confirmed-risk-b' };
        expect(record(record(await parent.rpc.get(RPC_METHODS.ForkOperation)!(b)).operation).status).toBe('indeterminate');
        const c = { ...b, operationId: randomUUID(), childSessionId: randomUUID(), sourceRevision: 3, duplicateRiskOf: b.operationId, fingerprint: 'confirmed-risk-c' };
        native.forkError = false;
        expect(record(record(await parent.rpc.get(RPC_METHODS.ForkOperation)!(c)).operation)).toMatchObject({ status: 'created', binding: 'ready', duplicateRiskOf: b.operationId });
        expect(native.requests.filter(value => value.method === 'thread/fork')).toHaveLength(3);
    });
    it('reports a native gateway unknown as a source-specific blocked Web operation without implicit override', async () => {
        const parent = await start(true);
        const forwarded = await native.hooks!.before({ id: 96, method: 'thread/fork', params: { threadId: 'parent' } }, 'native-origin');
        await native.clients[0].request('thread/fork', record(forwarded.params));
        await native.hooks!.after(forwarded, { id: 96, error: { code: -32603, message: 'error after native child creation' } }, 'native-origin');
        const operation = { action: 'start', operationId: randomUUID(), sourceSessionId: parent.sessionId, childSessionId: randomUUID(), sourceRevision: 1,
            sourceNativeThreadId: 'parent', sourceMachineId: 'test-machine', sourceStoreId: native.home, fingerprint: 'current' };
        const blocked = record(record(await parent.rpc.get(RPC_METHODS.ForkOperation)!(operation)).operation);
        expect(blocked).toMatchObject({ status: 'rejected', rejectionProof: 'not_dispatched', code: 'fork_source_unresolved' });
        expect(String(blocked.message)).toContain('native-gateway'); expect(String(blocked.message)).toContain(parent.sessionId);
        expect(String(blocked.message)).toContain('Web cannot clear');
        expect(native.requests.filter(value => value.method === 'thread/fork')).toHaveLength(1);
    });

});
