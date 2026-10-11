import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentState, Metadata } from '@/api/types';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { NativeStopFixture } from '@/test/nativeStopFixture';
import { record, type GatewayHooks } from './gateway';
import { runSharedRuntime, type RuntimeReady } from './runtime';

type NativeThread = { id: string; cwd: string; historyMode: string; status: { type: string }; turns: Record<string, unknown>[] };
type RequestReceipt = { method: string; params: Record<string, unknown>; turns: number; bytes: number };
const native = vi.hoisted(() => ({
    home: '', sessions: [] as TestSession[], clients: [] as NativeClient[], threads: new Map<string, NativeThread>(),
    settings: new Map<string, Record<string, unknown>>(), histories: new Map<string, NativeStopFixture>(),
    requests: [] as RequestReceipt[], hooks: undefined as GatewayHooks | undefined,
}));

class TestSession extends EventEmitter {
    readonly sessionId = `session-${native.sessions.length}`;
    state: AgentState = {};
    metadata: Metadata;
    rpc = new Map<string, (raw: unknown) => Promise<unknown>>();
    rpcHandlerManager = { registerHandler: (name: string, handler: (raw: unknown) => Promise<unknown>) => this.rpc.set(name, handler) };
    messages: unknown[] = [];
    snapshots: unknown[] = [];
    readiness = 0;
    runtime?: Record<string, unknown>;
    constructor(cwd: string, overrides: Partial<Metadata>) {
        super(); this.metadata = { path: cwd, host: 'test', flavor: 'codex', ...overrides };
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
    sendSessionDeath() {} async flush() {} close() {}
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
vi.mock('@/agent/sessionFactory', () => ({ bootstrapSession: async (options: { workingDirectory: string; metadataOverrides: Partial<Metadata> }) => {
    const session = new TestSession(options.workingDirectory, options.metadataOverrides); native.sessions.push(session);
    return { session, workingDirectory: options.workingDirectory, sessionInfo: { namespace: 'test' }, metadata: session.metadata };
}, bootstrapExistingSession: vi.fn(() => { throw new Error('Unexpected cold binding'); }) }));
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
});
