import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ readRuntimes: vi.fn(), runtimeAlive: vi.fn(), markers: vi.fn(), connect: vi.fn(), initialize: vi.fn(), request: vi.fn(), disconnect: vi.fn(), client: vi.fn() }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));
vi.mock('@/configuration', () => ({ configuration: { apiUrl: 'hub' } }));
vi.mock('@/utils/process', () => ({ getWindowsProcessStartMarkers: mocks.markers }));
vi.mock('./registry', () => ({ readRuntimes: mocks.readRuntimes, runtimeAlive: mocks.runtimeAlive, codexHome: () => 'home', runtimeAuthHash: () => 'auth' }));
vi.mock('../codexAppServerClient', () => ({ CodexAppServerClient: class {
    constructor(options: unknown) { mocks.client(options); }
    connect = mocks.connect; initialize = mocks.initialize; request = mocks.request; disconnect = mocks.disconnect;
    setServerRequestHandler() {}
} }));
vi.mock('./launch', () => ({ initializeSharedClient: async (client: { connect(): Promise<void>; initialize(): Promise<void> }) => { await client.connect(); await client.initialize(); } }));
import { nativeCodexEligibility, connectNativeCodexThread, nativeCodexModels } from './nativeConnection';
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const runtime = { nativeEndpoint: 'pipe', endpoint: 'ws://bridge', token: 'capability', pid: 12, marker: 'saved', codexHome: 'home', hub: 'hub', authHash: 'auth' };
beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.resetAllMocks();
    mocks.readRuntimes.mockResolvedValue([runtime]);
    mocks.markers.mockResolvedValue(new Map([[12, 'saved']]));
    mocks.request.mockResolvedValue({ loaded: ['thread'] });
});
afterEach(() => Object.defineProperty(process, 'platform', platform));
describe('native bridge discovery', () => {
    it('uses an authenticated existing bridge for model discovery', async () => {
        const models = { data: [{ id: 'model' }] };
        mocks.request.mockResolvedValue(models);
        expect(await nativeCodexModels(true)).toBe(models);
        expect(mocks.request).toHaveBeenCalledExactlyOnceWith('model/list', { includeHidden: true });
        expect(mocks.client).toHaveBeenCalledExactlyOnceWith({ endpoint: runtime.endpoint, token: runtime.token });
        expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    });
    it('allows standalone model discovery only when no matching native bridge is configured', async () => {
        mocks.readRuntimes.mockResolvedValue([{ ...runtime, authHash: 'other' }]);
        expect(await nativeCodexModels(false)).toBeNull();
        expect(mocks.readRuntimes).toHaveBeenCalledWith({ strict: true });
        expect(mocks.markers).not.toHaveBeenCalled();
        expect(mocks.client).not.toHaveBeenCalled();
        await expect(connectNativeCodexThread('thread')).rejects.toThrow('unavailable');
    });
    it('does not downgrade model discovery when bridge identity or transport is unavailable', async () => {
        mocks.markers.mockResolvedValue(new Map());
        await expect(nativeCodexModels(false)).rejects.toThrow('unavailable');
        mocks.markers.mockRejectedValue(new Error('CIM unavailable'));
        await expect(nativeCodexModels(false)).rejects.toThrow('CIM unavailable');
        mocks.markers.mockResolvedValue(new Map([[12, 'saved']]));
        mocks.request.mockRejectedValue(new Error('Bridge disconnected'));
        await expect(nativeCodexModels(false)).rejects.toThrow('Bridge disconnected');
        expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    });
    it('does not treat unreadable ownership records as an absent native bridge', async () => {
        mocks.readRuntimes.mockRejectedValue(new Error('Cannot verify Codex ownership record'));
        await expect(nativeCodexModels(false)).rejects.toThrow('Cannot verify Codex ownership record');
        expect(mocks.client).not.toHaveBeenCalled();
    });
    it('batches matching Windows records without synchronous per-record liveness probes', async () => {
        mocks.readRuntimes.mockResolvedValue([runtime, { ...runtime, pid: 13 }, { ...runtime, pid: 14, hub: 'other' }, { ...runtime, pid: 15, authHash: 'other' }, { ...runtime, pid: 16, codexHome: 'other' }]);
        expect(await nativeCodexEligibility()).toEqual({ loaded: new Set(['thread']) });
        expect(mocks.markers).toHaveBeenCalledExactlyOnceWith([12, 13]);
        expect(mocks.runtimeAlive).not.toHaveBeenCalled();
        expect(mocks.client).toHaveBeenCalledExactlyOnceWith({ endpoint: 'ws://bridge', token: 'capability' });
        expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    });
    it('rejects missing and reused generations before opening a connection', async () => {
        mocks.markers.mockResolvedValue(new Map([[12, 'reused']]));
        expect((await nativeCodexEligibility()).error).toContain('unavailable');
        mocks.markers.mockResolvedValue(new Map());
        expect((await nativeCodexEligibility()).error).toContain('unavailable');
        expect(mocks.client).not.toHaveBeenCalled();
    });
    it('rejects multiple authenticated live bridges', async () => {
        mocks.readRuntimes.mockResolvedValue([runtime, { ...runtime, pid: 13 }]);
        mocks.markers.mockResolvedValue(new Map([[12, 'saved'], [13, 'saved']]));
        expect((await nativeCodexEligibility()).error).toContain('Multiple native Codex bridges');
        expect(mocks.client).not.toHaveBeenCalled();
    });
    it('reports a failed batch query without skipping identity checks', async () => {
        mocks.markers.mockRejectedValue(new Error('CIM unavailable'));
        expect((await nativeCodexEligibility()).error).toBe('CIM unavailable');
        expect(mocks.client).not.toHaveBeenCalled();
    });
    it('also checks generation when connecting an existing thread', async () => {
        await connectNativeCodexThread('thread');
        expect(mocks.request).toHaveBeenCalledExactlyOnceWith('hapi/connectThread', { threadId: 'thread' });
    });
    it('preserves Linux process validation', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        mocks.runtimeAlive.mockReturnValue(true);
        expect((await nativeCodexEligibility()).loaded).toEqual(new Set(['thread']));
        expect(mocks.runtimeAlive).toHaveBeenCalledExactlyOnceWith(runtime);
        expect(mocks.markers).not.toHaveBeenCalled();
    });
});
