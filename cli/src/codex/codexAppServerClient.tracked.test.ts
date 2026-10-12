import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, openWebSocketMock, loggerMock } = vi.hoisted(() => ({
    spawnMock: vi.fn(),
    openWebSocketMock: vi.fn(),
    loggerMock: vi.fn()
}));

vi.mock('node:child_process', async () => ({
    ...await vi.importActual<typeof import('node:child_process')>('node:child_process'),
    execFileSync: vi.fn(() => 'codex-cli 1.0.0'),
    spawn: spawnMock
}));
vi.mock('node:fs', async () => ({
    ...await vi.importActual<typeof import('node:fs')>('node:fs'),
    existsSync: vi.fn(() => false)
}));
vi.mock('./shared/webSocketTransport', () => ({ openCodexWebSocket: openWebSocketMock }));
vi.mock('@/utils/process', () => ({ killProcessByChildProcess: vi.fn(async () => true) }));
vi.mock('@/ui/logger', () => ({ logger: { debug: loggerMock } }));

import {
    CodexAppServerClient,
    isIndeterminateError,
    type TrackedForkRequestIdentity
} from './codexAppServerClient';

function fakeStream() {
    return Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
}

function fakeChild() {
    return Object.assign(new EventEmitter(), {
        stdin: Object.assign(new EventEmitter(), {
            end: vi.fn(),
            destroy: vi.fn(),
            write: vi.fn((_data: string, callback?: (error?: Error | null) => void) => {
                callback?.();
                return true;
            })
        }),
        stdout: fakeStream(),
        stderr: fakeStream()
    });
}

function fakeSocket() {
    return Object.assign(new EventEmitter(), {
        send: vi.fn((_data: string, callback?: (error?: Error | null) => void) => callback?.()),
        close: vi.fn(),
        terminate: vi.fn(),
        readyState: 1
    });
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

function trackedCount(client: CodexAppServerClient): number {
    return (client as unknown as { trackedForkRequests: Map<string, unknown> }).trackedForkRequests.size;
}

function response(child: ReturnType<typeof fakeChild>, id: number, result: unknown) {
    child.stdout.emit('data', `${JSON.stringify({ id, result })}\n`);
}

const clients: CodexAppServerClient[] = [];

async function connectedClient() {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    const client = new CodexAppServerClient();
    clients.push(client);
    await client.connect();
    return { client, child };
}

describe('CodexAppServerClient tracked forks', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        spawnMock.mockReset();
        openWebSocketMock.mockReset();
        loggerMock.mockReset();
    });

    afterEach(async () => {
        for (const client of clients.splice(0)) await client.disconnect();
        vi.useRealTimers();
    });

    it('awaits durable exact request identity before its one write and returns normal success', async () => {
        const { client, child } = await connectedClient();
        const persisted = deferred();
        const beforeSend = vi.fn((_identity: TrackedForkRequestIdentity) => persisted.promise);
        const onLateResult = vi.fn();
        const promise = client.requestTracked('thread/fork', { threadId: 'parent' }, { beforeSend, onLateResult });

        expect(beforeSend).toHaveBeenCalledOnce();
        expect(child.stdin.write).not.toHaveBeenCalled();
        const identity = beforeSend.mock.calls[0]![0];
        expect(identity).toEqual({ requestId: 1, transportGeneration: 1 });
        expect(Object.isFrozen(identity)).toBe(true);
        persisted.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(child.stdin.write).toHaveBeenCalledOnce();
        expect(JSON.parse(child.stdin.write.mock.calls[0]![0])).toEqual({
            id: identity.requestId, method: 'thread/fork', params: { threadId: 'parent' }
        });
        response(child, identity.requestId, { thread: { id: 'exact-child' } });
        await expect(promise).resolves.toEqual({ thread: { id: 'exact-child' } });
        expect(onLateResult).not.toHaveBeenCalled();
        expect(trackedCount(client)).toBe(0);
    });

    it('does not write when the durability hook rejects', async () => {
        const { client, child } = await connectedClient();
        await expect(client.requestTracked('thread/fork', {}, {
            beforeSend: async () => { throw new Error('journal fsync failed'); }
        })).rejects.toThrow('journal fsync failed');
        expect(child.stdin.write).not.toHaveBeenCalled();
        expect(trackedCount(client)).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('bounds a stalled hook and never dispatches if that hook later completes', async () => {
        const { client, child } = await connectedClient();
        const persisted = deferred();
        const result = client.requestTracked('thread/fork', {}, { beforeSend: () => persisted.promise }).catch(error => error);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(isIndeterminateError(await result)).toBe(true);
        persisted.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(child.stdin.write).not.toHaveBeenCalled();
        expect(trackedCount(client)).toBe(0);
    });

    it('times out at 20 seconds but observes one exact late success without resending', async () => {
        const { client, child } = await connectedClient();
        const beforeSend = vi.fn((_identity: TrackedForkRequestIdentity) => {});
        const onLateResult = vi.fn();
        const result = client.requestTracked('thread/fork', {}, { beforeSend, onLateResult }).catch(error => error);
        await vi.advanceTimersByTimeAsync(19_999);
        expect(trackedCount(client)).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        const error = await result;
        if (!(error instanceof Error)) throw new Error('Expected tracked fork timeout to reject with an Error');
        expect(error.message).toContain('timed out after 20000ms');
        expect(isIndeterminateError(error)).toBe(true);
        response(child, 999, { thread: { id: 'wrong-child' } });
        response(child, 1, { thread: { id: 'exact-child' } });
        response(child, 1, { thread: { id: 'duplicate-child' } });
        await vi.advanceTimersByTimeAsync(0);
        expect(onLateResult).toHaveBeenCalledExactlyOnceWith(
            { thread: { id: 'exact-child' } }, beforeSend.mock.calls[0]![0]
        );
        expect(child.stdin.write).toHaveBeenCalledOnce();
        expect(trackedCount(client)).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps observing a written request whose write callback never arrives', async () => {
        const { client, child } = await connectedClient();
        child.stdin.write.mockImplementation(() => true);
        const onLateResult = vi.fn();
        const result = client.requestTracked('thread/fork', {}, { beforeSend: () => {}, onLateResult }).catch(error => error);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(isIndeterminateError(await result)).toBe(true);
        expect(client.isConnected()).toBe(true);
        response(child, 1, { thread: { id: 'exact-child' } });
        await vi.advanceTimersByTimeAsync(0);
        expect(onLateResult).toHaveBeenCalledOnce();
        expect(child.stdin.write).toHaveBeenCalledOnce();
    });

    it('retains native error code and data on normal and late errors', async () => {
        const { client, child } = await connectedClient();
        const onLateError = vi.fn();
        const first = client.requestTracked('thread/fork', {}, { beforeSend: () => {}, onLateError }).catch(error => error);
        await vi.advanceTimersByTimeAsync(0);
        child.stdout.emit('data', `${JSON.stringify({ id: 1, error: { code: -32000, message: 'read after create failed', data: { stage: 'thread-read' } } })}\n`);
        expect(await first).toMatchObject({ message: 'read after create failed', code: -32000, data: { stage: 'thread-read' } });
        expect(onLateError).not.toHaveBeenCalled();
        const second = client.requestTracked('thread/fork', {}, { beforeSend: () => {}, onLateError }).catch(error => error);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(isIndeterminateError(await second)).toBe(true);
        child.stdout.emit('data', `${JSON.stringify({ id: 2, error: { code: -32001, message: 'late native failure', data: { stage: 'name' } } })}\n`);
        await vi.advanceTimersByTimeAsync(0);
        expect(onLateError).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ message: 'late native failure', code: -32001, data: { stage: 'name' } }),
            { requestId: 2, transportGeneration: 1 }
        );
        expect(trackedCount(client)).toBe(0);
    });

    it.each(['callback', 'throw'])('treats a %s write failure conservatively and still accepts the exact late response', async (kind) => {
        const { client, child } = await connectedClient();
        child.stdin.write.mockImplementation((_data, callback) => {
            if (kind === 'throw') throw new Error('uncertain write');
            callback?.(new Error('uncertain write'));
            return false;
        });
        const onLateResult = vi.fn();
        const error = await client.requestTracked('thread/fork', {}, { beforeSend: () => {}, onLateResult }).catch(error => error);
        expect(isIndeterminateError(error)).toBe(true);
        expect(trackedCount(client)).toBe(1);
        response(child, 1, { thread: { id: 'exact-child' } });
        await vi.advanceTimersByTimeAsync(0);
        expect(onLateResult).toHaveBeenCalledOnce();
        expect(child.stdin.write).toHaveBeenCalledOnce();
    });

    it('rejects disconnect, removes live observers and cannot match reused ids on a replacement process', async () => {
        const { client, child: oldChild } = await connectedClient();
        const onLateResult = vi.fn();
        const first = client.requestTracked('thread/fork', {}, { beforeSend: () => {}, onLateResult }).catch(error => error);
        await vi.advanceTimersByTimeAsync(0);
        oldChild.emit('exit', 1, null);
        expect(isIndeterminateError(await first)).toBe(true);
        expect(trackedCount(client)).toBe(0);
        const newChild = fakeChild();
        spawnMock.mockReturnValueOnce(newChild);
        await client.connect();
        (client as unknown as { nextId: number }).nextId = 1;
        const beforeSend = vi.fn((_identity: TrackedForkRequestIdentity) => {});
        const second = client.requestTracked('thread/fork', {}, { beforeSend, onLateResult });
        await vi.advanceTimersByTimeAsync(0);
        expect(beforeSend).toHaveBeenCalledWith({ requestId: 1, transportGeneration: 2 });
        response(oldChild, 1, { thread: { id: 'old-child' } });
        expect(trackedCount(client)).toBe(1);
        response(newChild, 1, { thread: { id: 'new-child' } });
        await expect(second).resolves.toEqual({ thread: { id: 'new-child' } });
        expect(onLateResult).not.toHaveBeenCalled();
        expect(newChild.stdin.write).toHaveBeenCalledOnce();
    });

    it('cannot dispatch a pending durability hook into a replacement transport', async () => {
        const { client, child: oldChild } = await connectedClient();
        const persisted = deferred();
        const first = client.requestTracked('thread/fork', {}, { beforeSend: () => persisted.promise }).catch(error => error);
        await client.disconnect();
        expect(isIndeterminateError(await first)).toBe(true);
        const newChild = fakeChild();
        spawnMock.mockReturnValueOnce(newChild);
        await client.connect();
        persisted.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(oldChild.stdin.write).not.toHaveBeenCalled();
        expect(newChild.stdin.write).not.toHaveBeenCalled();
    });

    it('expires late observers after five minutes and does not change generic timeout behavior', async () => {
        const { client, child } = await connectedClient();
        const onLateResult = vi.fn();
        const tracked = client.requestTracked('thread/fork', {}, { beforeSend: () => {}, onLateResult }).catch(error => error);
        const generic = client.request('thread/read', {}).catch(error => error);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(isIndeterminateError(await tracked)).toBe(true);
        expect(isIndeterminateError(await generic)).toBe(true);
        expect(trackedCount(client)).toBe(1);
        await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
        expect(trackedCount(client)).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(trackedCount(client)).toBe(0);
        response(child, 1, { thread: { id: 'too-late' } });
        await vi.advanceTimersByTimeAsync(0);
        expect(onLateResult).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('caps tracked entries at 256 without evicting earlier observers or adding per-request transport listeners', async () => {
        const { client, child } = await connectedClient();
        const onLateResult = vi.fn();
        const results = Array.from({ length: 256 }, () => client.requestTracked('thread/fork', {}, {
            beforeSend: () => {}, onLateResult
        }).catch(error => error));
        await vi.advanceTimersByTimeAsync(20_000);
        expect((await Promise.all(results)).every(isIndeterminateError)).toBe(true);
        expect(trackedCount(client)).toBe(256);
        const beforeSend = vi.fn();
        await expect(client.requestTracked('thread/fork', {}, { beforeSend })).rejects.toThrow('capacity reached');
        expect(beforeSend).not.toHaveBeenCalled();
        expect(child.stdin.write).toHaveBeenCalledTimes(256);
        expect(child.stdout.listenerCount('data')).toBe(1);
        response(child, 1, { thread: { id: 'oldest-child' } });
        await vi.advanceTimersByTimeAsync(0);
        expect(onLateResult).toHaveBeenCalledOnce();
        const admitted = client.requestTracked('thread/fork', {}, { beforeSend }).catch(error => error);
        await vi.advanceTimersByTimeAsync(0);
        expect(beforeSend).toHaveBeenCalledOnce();
        expect(trackedCount(client)).toBe(256);
        await client.disconnect();
        expect(isIndeterminateError(await admitted)).toBe(true);
        expect(trackedCount(client)).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('catches rejected late callbacks after removing their listener', async () => {
        const { client, child } = await connectedClient();
        const promise = client.requestTracked('thread/fork', {}, {
            beforeSend: () => {},
            onLateResult: async () => { throw new Error('journal unavailable'); }
        }).catch(error => error);
        await vi.advanceTimersByTimeAsync(20_000);
        await promise;
        response(child, 1, { thread: { id: 'exact-child' } });
        await vi.advanceTimersByTimeAsync(0);
        expect(loggerMock).toHaveBeenCalledWith(
            '[CodexAppServer] Late fork response handler failed',
            expect.objectContaining({ error: expect.objectContaining({ message: 'journal unavailable' }) })
        );
        expect(trackedCount(client)).toBe(0);
    });

    it('isolates shared websocket generations and rejects use before explicit initialization', async () => {
        const oldSocket = fakeSocket();
        const newSocket = fakeSocket();
        openWebSocketMock.mockReturnValueOnce(oldSocket).mockReturnValueOnce(newSocket);
        const client = new CodexAppServerClient({ endpoint: 'ws://fake-test-only' });
        clients.push(client);
        let connecting = client.connect();
        oldSocket.emit('open');
        await connecting;
        await expect(client.requestTracked('thread/fork', {}, { beforeSend: () => {} })).rejects.toThrow('not initialized');
        // Initialization is tested elsewhere; no real websocket or native daemon is used here.
        (client as unknown as { initialized: boolean }).initialized = true;
        const onLateResult = vi.fn();
        const first = client.requestTracked('thread/fork', {}, { beforeSend: () => {}, onLateResult }).catch(error => error);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(isIndeterminateError(await first)).toBe(true);
        oldSocket.emit('close');
        expect(trackedCount(client)).toBe(0);
        connecting = client.connect();
        newSocket.emit('open');
        await connecting;
        (client as unknown as { initialized: boolean; nextId: number }).initialized = true;
        (client as unknown as { nextId: number }).nextId = 1;
        const second = client.requestTracked('thread/fork', {}, { beforeSend: () => {}, onLateResult });
        await vi.advanceTimersByTimeAsync(0);
        oldSocket.emit('message', JSON.stringify({ id: 1, result: { thread: { id: 'old' } } }));
        expect(trackedCount(client)).toBe(1);
        newSocket.emit('message', JSON.stringify({ id: 1, result: { thread: { id: 'new' } } }));
        await expect(second).resolves.toEqual({ thread: { id: 'new' } });
        expect(onLateResult).not.toHaveBeenCalled();
        expect(oldSocket.send).toHaveBeenCalledOnce();
        expect(newSocket.send).toHaveBeenCalledOnce();
    });

    it.each([Infinity, NaN, 0, -1, 20_001])('rejects an unbounded or invalid deadline %s before journaling or writing', async (timeoutMs) => {
        const { client, child } = await connectedClient();
        const beforeSend = vi.fn();
        await expect(client.requestTracked('thread/fork', {}, { beforeSend, timeoutMs })).rejects.toThrow('timeout');
        expect(beforeSend).not.toHaveBeenCalled();
        expect(child.stdin.write).not.toHaveBeenCalled();
    });
});
