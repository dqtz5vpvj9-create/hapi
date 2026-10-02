import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState, Metadata, UserMessage } from '@/api/types';
import type { SessionBootstrapResult } from '@/agent/sessionFactory';
import { SharedCodexRoot, type RootHost } from './root';
import { codexPlanProposalId } from './plan';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { NativeStopFixture } from '@/test/nativeStopFixture';

type NativeTurn = { id: string; status: string; items: unknown[] };

vi.mock('../codexAppServerClient', () => ({
    CodexAppServerClient: class {
        initialized = false;
        thread = { id: 'thread', turns: [] as NativeTurn[] };
        settings: Record<string, unknown> = { model: 'mock', collaborationMode: { mode: 'default' } };
        queue: Array<{ id: string; clientUserMessageId: unknown; input: unknown }> = [];
        items: unknown[] = [];
        notify?: (method: string, params: unknown) => void;
        abandoned?: () => void;
        setNotificationHandler(handler: typeof this.notify) { this.notify = handler; }
        setTransportAbandonedHandler(handler: (() => void) | null) { this.abandoned = handler ?? undefined; }
        serverRequest?: (request: { id: string | number; method: string; params: unknown }) => void;
        respond = vi.fn();
        setServerRequestHandler(handler: typeof this.serverRequest) { this.serverRequest = handler; }
        async connect() {}
        async initialize() { this.initialized = true; }
        isInitialized() { return this.initialized; }
        async disconnect() { this.initialized = false; }
        async request(method: string, params: Record<string, unknown> = {}) {
            if (method === 'thread/read' || method === 'thread/resume') return { ...this.settings, thread: structuredClone(this.thread) };
            if (method === 'thread/turns/list') return { data: this.thread.turns.slice(-1), nextCursor: null };
            if (method === 'thread/items/list') return { data: this.items, nextCursor: null };
            if (method === 'thread/list') return { data: [] };
            if (method === 'thread/goal/get') return { goal: null };
            if (method === 'thread/queue/list') return { data: this.queue };
            if (method === 'thread/settings/update') {
                const updated = { ...this.settings, ...params,
                    ...('serviceTier' in params ? { serviceTier: params.serviceTier ?? 'default' } : {}) };
                if (JSON.stringify(updated) === JSON.stringify(this.settings)) return {};
                this.settings = updated;
                this.notify?.('thread/settings/updated', { threadId: 'thread', threadSettings: this.settings });
                return {};
            }
            if (method === 'thread/queue/add') {
                const entry = { id: `queued-${this.queue.length}`, clientUserMessageId: params.clientUserMessageId, input: params.input };
                this.queue.push(entry);
                return { queuedSubmission: entry };
            }
            throw new Error(`Unexpected request: ${method}`);
        }
    },
    isIndeterminateError: () => false
}));
vi.mock('../utils/buildHapiMcpBridge', () => ({ buildHapiMcpBridge: async () => ({
    mcpServers: {}, server: { stop() {} }
}) }));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    try { for (const cleanup of cleanups.splice(0)) await cleanup(); }
    finally { vi.useRealTimers(); }
});

async function fixture(opts?: { hubArchived?: boolean; external?: boolean; nativeHistory?: boolean; end?: RootHost['end'] }) {
    const directory = await mkdtemp(`${process.env.TMPDIR ?? '/mnt/cache/data-cache'}/hapi-shared-root-`);
    let state: AgentState = { steeringActive: true };
    let metadata: Metadata = { path: directory, host: 'test', flavor: 'codex' };
    let reconnect: (() => void) | null = null;
    let userMessage: ((message: UserMessage, localId?: string) => void) | undefined;
    const updateState = vi.fn((fn: (value: AgentState) => AgentState) => { state = fn(state); });
    const rpc = new Map<string, (raw: unknown) => Promise<unknown>>();
    const send = vi.fn();
    const hubArchivedListeners: Array<() => void> = [];
    const session = {
        sessionId: 'sid', getMetadata: () => metadata,
        hubArchived: opts?.hubArchived ?? false,
        updateMetadata: (fn: (value: Metadata) => Metadata) => { metadata = fn(metadata); },
        updateAgentState: updateState, keepAlive() {},
        onUserMessage(handler: typeof userMessage) { userMessage = handler; }, onCancelQueuedMessage() {}, onRetryQueuedMessage() {},
        onReconnect: (fn: (() => void) | null) => { reconnect = fn; },
        on(event: string, listener: () => void) {
            if (event === 'hub-archived') hubArchivedListeners.push(listener);
        },
        rpcHandlerManager: { registerHandler: (name: string, handler: (raw: unknown) => Promise<unknown>) => rpc.set(name, handler) },
        emitNativeHistoryChanged: vi.fn(), sendSessionEvent: vi.fn(), sendAgentMessage: send, emitSessionReady() {},
        sendUserMessage() {}, emitMessagesConsumed: vi.fn(), emitSteerIndeterminate: vi.fn(), syncNativeQueuedMessage() {}, syncNativeQueueSnapshot: vi.fn(), setSteerDeliveryState: vi.fn(async () => true),
        sendSessionDeath() {}, async flush() {}, close() {}
    } as unknown as ApiSessionClient;
    const end = opts?.end ?? (async () => { throw new Error('Unexpected root archive'); });
    const root = new SharedCodexRoot({ session, workingDirectory: directory } as SessionBootstrapResult, {
        directory, generation: 'test', endpoint: 'mock', external: opts?.external, codexHome: directory, settingsFor: () => undefined,
        create: async () => { throw new Error('Unexpected root creation'); },
        end
    } satisfies RootHost);
    cleanups.push(async () => { await root.close(false); await rm(directory, { recursive: true, force: true }); });
    await root.prepare();
    await root.bind('thread', { model: 'mock', thread: { turns: [] } }, false);
    const native = root.client as unknown as {
        initialized: boolean;
        thread: { id: string; turns: NativeTurn[] };
        queue: Array<{ id: string; clientUserMessageId: string; input: unknown }>;
        items: unknown[];
        notify(method: string, params: unknown): void;
        abandoned(): void;
        serverRequest(request: { id: string | number; method: string; params: unknown }): void;
        respond: ReturnType<typeof vi.fn>;
    };
    const stopSource = opts?.nativeHistory ? new NativeStopFixture(directory) : undefined;
    if (stopSource) {
        const request = root.client.request.bind(root.client);
        root.client.request = (async (method: string, params: Record<string, unknown> = {}) => {
            if (method === 'thread/items/list' || method === 'thread/turns/list' && params.itemsView === 'notLoaded')
                return stopSource.request(method, params);
            return request(method, params);
        }) as typeof root.client.request;
        cleanups.unshift(async () => { stopSource.close(); });
    }
    return {
        root, native, rpc, send, stopSource, metadata: () => metadata, state: () => state, updateState,
        userMessage: (message: UserMessage, localId: string) => userMessage?.(message, localId),
        reconnect: () => reconnect?.(),
        emitHubArchived: () => { for (const listener of hubArchivedListeners) listener(); },
        hubArchivedListenerCount: () => hubArchivedListeners.length,
        end,
    };
}

it.each([false, true])('publishes goal controls through their full lifecycle without queueing a model turn (external=%s)', async external => {
    const f = await fixture({ external });
    await f.root.activate();
    let goal: Record<string, unknown> | null = null;
    let revision = 0;
    const request = f.root.client.request.bind(f.root.client);
    vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params = {}) => {
        if (method === 'thread/goal/get') return { goal };
        if (method === 'thread/goal/clear') { goal = null; return { cleared: true }; }
        if (method === 'thread/goal/set') {
            const input = params as Record<string, unknown>;
            goal = { ...goal, threadId: 'thread', objective: input.objective ?? goal?.objective,
                status: input.status ?? 'active', tokensUsed: 12, updatedAt: ++revision };
            return { goal };
        }
        return request(method, params);
    });
    for (const [action, status] of [
        ['public goal lifecycle', 'active'], ['', 'active'], ['pause', 'paused'], ['resume', 'active'], ['clear', null]
    ] as const) {
        const localId = `goal-action-${revision}-${action}`;
        f.userMessage({ role: 'user', content: { type: 'text', text: `/goal ${action}` } }, localId);
        await (f.root as any).work;
        if (status === null) expect(f.state().threadGoal).toBeNull();
        else expect(f.state().threadGoal).toMatchObject({ objective: 'public goal lifecycle', status });
        expect(f.root.session.emitMessagesConsumed).toHaveBeenCalledWith([localId], { clearQueuedThinkingGrace: true });
    }
    expect(f.native.queue).toHaveLength(0);
    expect(f.root.session.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('"goal"') }));
});

it('updates goal controls from native activity in an external thread without replaying its transcript', async () => {
    const f = await fixture({ external: true });
    f.native.notify('thread/goal/updated', { threadId: 'thread', goal: {
        threadId: 'thread', objective: 'native goal', status: 'blocked', tokensUsed: 32
    } });
    await (f.root as any).notifications;
    expect(f.state().threadGoal).toMatchObject({ objective: 'native goal', status: 'blocked' });
    f.native.notify('thread/goal/cleared', { threadId: 'thread' });
    await (f.root as any).notifications;
    expect(f.state().threadGoal).toBeNull();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.native.queue).toHaveLength(0);
});

it('waits for native YOLO confirmation before submitting an old-turn approval and then suppresses later prompts', async () => {
    const f = await fixture();
    await f.root.activate();
    f.root.acceptSettings({ model: 'mock', approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } });
    const request = { id: 9, method: 'item/commandExecution/requestApproval', params: {
        threadId: 'thread', turnId: 'running', itemId: 'command', command: 'printf probe'
    } };
    f.native.serverRequest(request);
    await vi.waitFor(() => expect(Object.keys(f.state().requests!)).toHaveLength(1));
    const nativeRequest = f.root.client.request.bind(f.root.client);
    let confirm!: () => void;
    f.root.client.request = (async (method: string, params: Record<string, unknown>) => {
        if (method !== 'thread/settings/update') return nativeRequest(method, params);
        confirm = () => f.native.notify('thread/settings/updated', { threadId: 'thread', threadSettings: { model: 'mock', ...params } });
        return {};
    }) as typeof f.root.client.request;
    const applying = f.root.applySettings({ permissionMode: 'yolo' });
    await vi.waitFor(() => expect(confirm).toBeTypeOf('function'));
    expect(f.native.respond).not.toHaveBeenCalled();
    confirm();
    expect((await applying).applied.permissionMode).toBe('yolo');
    await vi.waitFor(() => expect(f.native.respond).toHaveBeenCalledExactlyOnceWith(9, { decision: 'accept' }));
    expect(Object.keys(f.state().requests!)).toHaveLength(1);
    f.native.notify('serverRequest/resolved', { threadId: 'thread', requestId: 9 });
    expect(Object.keys(f.state().requests!)).toHaveLength(0);
    f.native.serverRequest({ ...request, id: 10 });
    await vi.waitFor(() => expect(f.native.respond).toHaveBeenLastCalledWith(10, { decision: 'accept' }));
    expect(Object.keys(f.state().requests!)).toHaveLength(0);
});

describe('queue consumption notification ordering', () => {
    it.each([false, true])('uses received acceptance while queue reconciliation is blocked (external=%s)', async external => {
        const f = await fixture({ external });
        await f.root.activate();
        f.userMessage({ role: 'user', content: { type: 'text', text: 'public ordering probe' } }, 'web-ordering');
        await vi.waitFor(() => expect(f.native.queue).toHaveLength(1));
        await (f.root as any).work;
        f.native.queue = [];
        const request = f.root.client.request.bind(f.root.client);
        let release!: () => void;
        let listing = false;
        vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            if (method === 'thread/queue/list') {
                listing = true;
                await new Promise<void>(resolve => { release = resolve; });
                return { data: [] };
            }
            return request(method, params);
        });
        f.native.notify('thread/queue/changed', { threadId: 'thread' });
        await vi.waitFor(() => expect(listing).toBe(true));
        f.native.notify('item/started', { threadId: 'thread', turnId: 'turn', item: {
            type: 'userMessage', id: 'accepted-item', clientId: 'web-ordering', content: [{ type: 'text', text: 'public ordering probe' }]
        } });
        release();
        await (f.root as any).notifications;
        expect(f.root.session.emitMessagesConsumed).toHaveBeenCalledWith(['web-ordering'], { steered: undefined });
        expect(f.root.session.emitSteerIndeterminate).not.toHaveBeenCalled();
        expect((f.root as any).queue.state('web-ordering')).toBe('consumed');
        expect(f.root.client.request).toHaveBeenCalledTimes(1);
    });

    it('retains uncertainty when only unrelated acceptance arrives, without resubmitting', async () => {
        const f = await fixture({ external: true });
        await f.root.activate();
        f.userMessage({ role: 'user', content: { type: 'text', text: 'public ordering probe' } }, 'unconfirmed');
        await vi.waitFor(() => expect(f.native.queue).toHaveLength(1));
        await (f.root as any).work;
        f.native.queue = [];
        f.native.notify('item/started', { threadId: 'other-thread', turnId: 'turn', item: {
            type: 'userMessage', id: 'different-item', clientId: 'unconfirmed', content: []
        } });
        f.native.notify('thread/queue/changed', { threadId: 'thread' });
        await (f.root as any).notifications;
        expect((f.root as any).queue.state('unconfirmed')).toBe('dispatching');
        expect(f.root.session.emitSteerIndeterminate).not.toHaveBeenCalled();
        await (f.root as any).queue.transportLost();
        expect(f.root.session.emitSteerIndeterminate).toHaveBeenCalledWith(['unconfirmed']);
        expect((f.root as any).queue.state('unconfirmed')).toBe('unknown');
        const request = vi.spyOn(f.root.client, 'request');
        f.userMessage({ role: 'user', content: { type: 'text', text: 'public ordering probe' } }, 'unconfirmed');
        await (f.root as any).work;
        expect(request.mock.calls.filter(([method]) => method === 'thread/queue/add')).toHaveLength(0);
    });
});

it('does not infer YOLO from an unrestricted sandbox whose approval policy still prompts', async () => {
    const f = await fixture();
    await f.root.activate();
    f.root.acceptSettings({ model: 'mock', approvalPolicy: 'on-request', sandboxPolicy: { type: 'dangerFullAccess' } });
    expect((await f.root.applySettings({})).applied.permissionMode).toBe('default');
    f.native.serverRequest({ id: 9, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', itemId: 'command' } });
    await vi.waitFor(() => expect(Object.keys(f.state().requests!)).toHaveLength(1));
    expect(f.native.respond).not.toHaveBeenCalled();
});

it.each(['standard', null] as const)('confirms native standard tier when requested as %s', async serviceTier => {
    const f = await fixture();
    await f.root.applySettings({ serviceTier: 'fast' });
    const result = await f.root.applySettings({ serviceTier });
    expect(result.applied.serviceTier).toBe('standard');
    expect((await f.root.applySettings({ serviceTier })).applied.serviceTier).toBe('standard');
});

async function completePlan(f: Awaited<ReturnType<typeof fixture>>, status = 'completed') {
    await f.root.applySettings({ collaborationMode: 'plan' });
    const turn = { id: 'plan-turn', status: 'inProgress', items: [{ id: 'plan-item', type: 'plan', text: '# Implement me' }] };
    f.native.thread.turns.push(turn);
    f.native.notify('turn/started', { threadId: 'thread', turn: { id: turn.id } });
    f.native.notify('item/completed', { threadId: 'thread', turnId: turn.id, item: turn.items[0] });
    expect(f.state().codexPlanProposalId).toBeNull();
    turn.status = status;
    f.native.notify('turn/completed', { threadId: 'thread', turn: { id: turn.id, status } });
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ name: 'ExitPlanMode' }), expect.any(String)));
    return codexPlanProposalId('thread', turn.id, 'plan-item');
}

describe('shared plan actions', () => {
    it('queues uploaded images as native image inputs while retaining file references', async () => {
        const f = await fixture({ external: true });
        await f.root.activate();
        f.userMessage({ role: 'user', content: { type: 'text', text: 'Inspect these', attachments: [
            { id: 'image', filename: 'my image.png', path: '/uploads/my image.png', mimeType: 'image/png', size: 123 },
            { id: 'file', filename: 'notes.txt', path: '/uploads/notes.txt', mimeType: 'text/plain', size: 12 }
        ] } }, 'uploaded-message');
        await vi.waitFor(() => expect(f.native.queue).toHaveLength(1));
        expect(f.native.queue[0].clientUserMessageId).toBe('uploaded-message');
        expect(f.native.queue[0].input).toEqual([
            { type: 'text', text: '@/uploads/my image.png @/uploads/notes.txt\n\nInspect these' },
            { type: 'localImage', path: '/uploads/my image.png' }
        ]);
    });

    it('applies remote change_title as metadata.name then lets native terminal rename win', async () => {
        const f = await fixture();
        const item = { id: 'title', type: 'mcpToolCall', server: 'hapi', tool: 'change_title',
            arguments: { title: 'Remote title' }, status: 'completed', result: { content: [], isError: false } };
        f.native.notify('item/completed', { threadId: 'thread', turnId: 'turn', item });
        await vi.waitFor(() => expect(f.metadata().name).toBe('Remote title'));
        f.native.notify('thread/name/updated', { threadId: 'thread', threadName: 'Terminal title' });
        await vi.waitFor(() => expect(f.metadata().name).toBe('Terminal title'));
        await f.root.refresh();
        expect(f.metadata().name).toBe('Terminal title');
    });

    it('preserves content while native turns, mode changes and disconnects withdraw controls', async () => {
        const f = await fixture();
        const id = await completePlan(f);
        expect(f.state().codexPlanProposalId).toBe(id);
        expect(f.state().requests).toEqual({});
        await f.root.applySettings({ collaborationMode: 'default' });
        expect(f.state().codexPlanProposalId).toBeNull();
        await f.root.applySettings({ collaborationMode: 'plan' });
        expect(f.state().codexPlanProposalId).toBe(id);
        f.native.initialized = false; f.native.abandoned();
        expect(f.state().codexPlanProposalId).toBeNull();
        await vi.waitFor(() => expect(f.state().codexPlanProposalId).toBe(id));
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'new' } });
        f.native.notify('turn/completed', { threadId: 'thread', turn: { id: 'plan-turn', status: 'completed' } });
        expect(f.state().codexPlanProposalId).toBeNull();
        expect(f.send.mock.calls.some(([message]) => message.input?.plan === '# Implement me')).toBe(true);
    });

    it.each(['failed', 'interrupted'])('does not offer a proposal from a %s turn', async status => {
        const f = await fixture();
        await completePlan(f, status);
        await f.root.refresh();
        expect(f.state().codexPlanProposalId).toBeNull();
    });

    it('uses only the latest root turn when replaying history', async () => {
        const f = await fixture();
        const id = await completePlan(f);
        f.reconnect();
        await f.root.refresh();
        await vi.waitFor(() => expect(f.state().codexPlanProposalId).toBe(id));
        f.native.thread.turns.push({ id: 'new', status: 'completed', items: [] });
        await f.root.refresh();
        expect(f.state().codexPlanProposalId).toBeNull();
        f.native.notify('item/completed', { threadId: 'child', turnId: 'child-turn', item: { id: 'p', type: 'plan', text: 'child' } });
        expect(f.state().codexPlanProposalId).toBeNull();
    });

    it('switches mode and submits once across repeated Web actions and lost replies', async () => {
        const f = await fixture();
        await f.root.activate();
        const id = await completePlan(f);
        const action = () => f.rpc.get(RPC_METHODS.ImplementCodexPlan)!({ planId: id });
        const request = vi.spyOn(f.root.client, 'request');
        expect(await Promise.all([action(), action()])).toEqual([{ ok: true }, { ok: true }]);
        f.reconnect();
        expect(await action()).toEqual({ ok: true });
        expect(request.mock.calls.filter(([method]) => method === 'thread/queue/add')).toHaveLength(1);
        const settingsIndex = request.mock.calls.findIndex(([method]) => method === 'thread/settings/update');
        const queueIndex = request.mock.calls.findIndex(([method]) => method === 'thread/queue/add');
        expect(settingsIndex).toBeLessThan(queueIndex);
        expect(request.mock.calls[settingsIndex][1]).toMatchObject({ collaborationMode: { mode: 'default' } });
        expect(f.native.queue[0]).toMatchObject({ input: [{ type: 'text', text: 'Implement the plan.' }] });
        expect(f.state().codexPlanProposalId).toBeNull();
    });

    it('does not let a slow history snapshot resurrect a plan after native continuation', async () => {
        const f = await fixture();
        await completePlan(f);
        const request = f.root.client.request.bind(f.root.client);
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        let reading!: () => void;
        const started = new Promise<void>(resolve => { reading = resolve; });
        vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            const result = await request(method, params);
            if (method === 'thread/read' && (params as { includeTurns?: boolean }).includeTurns) {
                reading(); await blocked;
            }
            return result;
        });
        const refresh = f.root.refresh();
        await started;
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'terminal-continued' } });
        release(); await refresh;
        expect(f.state().codexPlanProposalId).toBeNull();
    });

    it('does not change mode when native input appears during the action preflight', async () => {
        const f = await fixture();
        await f.root.activate();
        const id = await completePlan(f);
        const request = f.root.client.request.bind(f.root.client);
        const spy = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            const result = await request(method, params);
            if (method === 'thread/queue/list') f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'terminal' } });
            return result;
        });
        expect(await f.rpc.get(RPC_METHODS.ImplementCodexPlan)!({ planId: id })).toMatchObject({ ok: false, code: 'stale_plan' });
        expect(spy.mock.calls.some(([method]) => method === 'thread/settings/update')).toBe(false);
        expect(f.native.queue).toHaveLength(0);
    });

    it('rejects stale proposals and native activity arriving during the mode switch', async () => {
        const f = await fixture();
        await f.root.activate();
        const id = await completePlan(f);
        const action = (planId = id) => f.rpc.get(RPC_METHODS.ImplementCodexPlan)!({ planId });
        expect(await action('old')).toMatchObject({ ok: false, code: 'stale_plan' });
        const request = f.root.client.request.bind(f.root.client);
        vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            const result = await request(method, params);
            if (method === 'thread/settings/update') f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'terminal' } });
            return result;
        });
        expect(await action()).toMatchObject({ ok: false, code: 'stale_plan' });
        expect(f.native.queue).toHaveLength(0);
    });

    it('does not resend an implementation with an unknown queue outcome', async () => {
        const f = await fixture();
        await f.root.activate();
        const id = await completePlan(f);
        const request = f.root.client.request.bind(f.root.client);
        const spy = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            const result = await request(method, params);
            // An invalid response schema leaves delivery indeterminate even after acceptance.
            return method === 'thread/queue/add' ? {} : result;
        });
        const action = () => f.rpc.get(RPC_METHODS.ImplementCodexPlan)!({ planId: id });
        expect(await action()).toMatchObject({ ok: false, code: 'indeterminate' });
        f.native.queue = []; // Absence is not proof of cancellation or delivery.
        expect(await action()).toMatchObject({ ok: false, code: 'indeterminate' });
        expect(spy.mock.calls.filter(([method]) => method === 'thread/queue/add')).toHaveLength(1);
    });
});

describe('shared steering availability', () => {
    it('keeps idle sessions online without polling usage or publishing agent-state updates', async () => {
        const f = await fixture();
        const requests = vi.spyOn(f.root.client, 'request');
        const heartbeat = vi.spyOn(f.root.session, 'keepAlive');
        const updates = f.updateState.mock.calls.length;
        vi.useFakeTimers();

        await f.root.activate();
        await vi.advanceTimersByTimeAsync(5 * 60_000);

        expect(heartbeat).toHaveBeenCalled();
        expect(requests).not.toHaveBeenCalled();
        expect(f.updateState).toHaveBeenCalledTimes(updates);
    });

    it('publishes root turn transitions, ignores child turns, and clears on shutdown', async () => {
        const f = await fixture();
        expect(f.state().steeringActive).toBe(false);
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
        expect(f.state().steeringActive).toBe(true);
        f.native.notify('turn/completed', { threadId: 'thread', turn: { id: 'old-turn' } });
        expect(f.state().steeringActive).toBe(true);
        f.native.notify('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
        expect(f.state().steeringActive).toBe(false);
        f.native.notify('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
        expect(f.state().steeringActive).toBe(false);
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'next' } });
        f.root.stopAccepting();
        expect(f.state().steeringActive).toBe(false);
    });

    it('reconciles native and Hub reconnects without publishing on every refresh', async () => {
        const f = await fixture();
        const updates = f.updateState.mock.calls.length;
        await f.root.refresh(); await f.root.refresh();
        expect(f.updateState).toHaveBeenCalledTimes(updates);
        f.native.thread.turns = [{ id: 'busy', status: 'inProgress', items: [] }];
        f.reconnect();
        await vi.waitFor(() => expect(f.state().steeringActive).toBe(true));
        f.native.initialized = false; f.native.abandoned();
        expect(f.state().steeringActive).toBe(false);
        await vi.waitFor(() => expect(f.state().steeringActive).toBe(true));
        f.native.thread.turns = [{ id: 'busy', status: 'completed', items: [] }];
        f.reconnect();
        await vi.waitFor(() => expect(f.state().steeringActive).toBe(false));
    });

    it('ends the shared root on hub-archived metadata (#1911 C2 / AC6)', async () => {
        const end = vi.fn<RootHost['end']>(async () => {});
        const f = await fixture({ end });
        await f.root.activate();
        expect(f.hubArchivedListenerCount()).toBe(1);
        f.emitHubArchived();
        await vi.waitFor(() => expect(end).toHaveBeenCalledTimes(1));
        expect(end.mock.calls[0]?.[0]).toBe(f.root);
    });

    it('ends when hubArchived was latched before activate (production order, #1911 AC6)', async () => {
        // Bootstrap may refuse CAS / noteHubArchived before Codex bind+activate
        // registers controls — same late-listener miss as other flavors.
        const end = vi.fn<RootHost['end']>(async () => {});
        const f = await fixture({ hubArchived: true, end });
        await f.root.activate();
        await vi.waitFor(() => expect(end).toHaveBeenCalledTimes(1));
    });
});


describe('external native lifecycle', () => {
    it('confirms actual native page user identities before the RPC response, without persisting the transcript', async () => {
        const f = await fixture({ external: true, nativeHistory: true });
        await f.root.activate();
        f.stopSource!.addTurn('turn', 'completed');
        f.stopSource!.items[0].item.clientId = 'web-client';
        const response = await f.rpc.get(RPC_METHODS.ReadCodexHistory)!({ limit: 20 }) as { messages: Array<{ localId: string }> };
        expect(response.messages[0].localId).toBe('web-client');
        expect(f.root.session.emitMessagesConsumed).toHaveBeenCalledWith(['web-client'], { steered: undefined });
        expect(f.send).not.toHaveBeenCalled();
    });

    it('external notification recovers native stopped history after persistence, without Hub transcript emissions', async () => {
        const f = await fixture({ external: true, nativeHistory: true });
        const turn = f.stopSource!.addTurn('stopped', 'inProgress');
        await f.root.activate();
        const read = () => f.rpc.get(RPC_METHODS.ReadCodexHistory)!({ limit: 20 }) as Promise<{ messages: any[] }>;
        expect((await read()).messages.some(row => row.content.content.type === 'event')).toBe(false);
        f.stopSource!.complete(turn, 'interrupted', false);
        f.native.notify('turn/completed', { threadId: 'thread', turn: { id: turn.id, status: 'interrupted' } });
        await vi.waitFor(() => expect(f.root.session.emitNativeHistoryChanged).toHaveBeenCalled());
        await expect(read()).rejects.toMatchObject({ retryable: true });
        f.stopSource!.persist(turn);
        const interrupted = await read();
        expect(interrupted.messages.filter(row => row.content.content.type === 'event')).toHaveLength(1);
        f.stopSource!.addTurn('next', 'completed');
        f.native.notify('turn/completed', { threadId: 'thread', turn: { id: 'next', status: 'completed' } });
        await vi.waitFor(() => expect(f.root.session.emitNativeHistoryChanged).toHaveBeenCalledTimes(2));
        const next = await read();
        expect(next.messages.filter(row => row.content.content.type === 'event').map(row => row.id))
            .toEqual(['native-turn-status:thread:stopped:turn_aborted']);
        expect(f.send).not.toHaveBeenCalled();
        expect(f.root.session.sendSessionEvent).not.toHaveBeenCalled();
    });

    it('settles live external user acceptance while keeping direct history nonpersisting', async () => {
        const f = await fixture({ external: true });
        f.native.notify('item/started', { threadId: 'thread', turnId: 'turn', item: {
            type: 'userMessage', id: 'native-item', clientId: 'external-client', content: [{ type: 'text', text: 'processed' }]
        } });
        await vi.waitFor(() => expect(f.root.session.emitMessagesConsumed).toHaveBeenCalledWith(['external-client'], { steered: undefined }));
        expect(f.send).not.toHaveBeenCalled();
    });

    it('does not inject settings or delete native queued work when detaching', async () => {
        const { root, native } = await fixture({ external: true });
        const params = { threadId: 'thread' };
        expect(root.config(params)).toEqual(params);
        native.queue.push({ id: 'native-entry', clientUserMessageId: 'web-entry', input: [{ type: 'text', text: 'keep working' }] });
        await root.refresh();
        await root.suspend();
        await root.close(false);
        expect(native.queue).toHaveLength(1);
    });
});


it('edits goals directly through RPC, treating reserved command words as objectives and preserving the native budget', async () => {
    const f = await fixture({ external: true });
    await f.root.activate();
    let goal: Record<string, unknown> | null = null;
    const request = f.root.client.request.bind(f.root.client);
    const native = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params = {}) => {
        if (method === 'thread/goal/get') return { goal };
        if (method === 'thread/goal/clear') { goal = null; return { cleared: true }; }
        if (method === 'thread/goal/set') {
            const input = params as Record<string, unknown>;
            goal = { ...goal, threadId: 'thread', objective: input.objective ?? goal?.objective,
                status: input.status ?? 'active', tokenBudget: 800, tokensUsed: 12 };
            return { goal };
        }
        return request(method, params);
    });
    const apply = f.rpc.get(RPC_METHODS.CodexGoal)!;
    await apply({ action: 'set', objective: 'clear' });
    expect(f.state().threadGoal).toMatchObject({ objective: 'clear', tokenBudget: 800 });
    await apply({ action: 'pause' });
    expect(f.state().threadGoal?.status).toBe('paused');
    await apply({ action: 'resume' });
    expect(f.state().threadGoal?.status).toBe('active');
    expect(await apply({ action: 'get' })).toMatchObject({ goal: { objective: 'clear' } });
    await apply({ action: 'clear' });
    expect(f.state().threadGoal).toBeNull();
    expect(f.native.queue).toHaveLength(0);
    expect(native).not.toHaveBeenCalledWith('turn/start', expect.anything());
    const count = native.mock.calls.length;
    await expect(apply({ action: 'set', objective: '' })).rejects.toThrow();
    expect(native.mock.calls.length).toBe(count);
});
