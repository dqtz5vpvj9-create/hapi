import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ home: '', auth: 'token', windows: false, processes: new Map<number, string | undefined>(), markers: vi.fn(), alive: vi.fn(), marker: vi.fn() }));
vi.mock('@/configuration', () => ({ configuration: { get happyHomeDir() { return state.home; }, apiUrl: 'hub', get cliApiToken() { return state.auth; } } }));
vi.mock('@/utils/process', () => ({ isWindows: () => state.windows, getWindowsProcessStartMarkers: state.markers,
    isProcessAlive: state.alive.mockImplementation((pid: number) => state.processes.has(pid)),
    getProcessStartMarker: state.marker.mockImplementation((pid: number) => state.processes.get(pid)) }));
import { findRuntime, readRuntimes, runtimeAlive, runtimeAuthHash, runtimeMayBeAlive, saveRuntime, withThreadOwnership, type CodexRuntimeRecord } from './registry';

const directories: string[] = [];
afterEach(async () => { state.processes.clear(); state.auth = 'token'; state.windows = false; state.markers.mockReset(); state.alive.mockClear(); state.marker.mockClear(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(): Promise<CodexRuntimeRecord> {
    const home = await mkdtemp(join(tmpdir(), 'hapi-owner-')); directories.push(home); state.home = join(home, 'hapi');
    return { id: 'owner', pid: 1111, marker: 'worker-start', serverPid: 2222, serverMarker: 'server-start', command: 'codex', args: [],
        codexHome: join(home, 'codex'), endpoint: 'unix://private', hub: 'hub', authHash: runtimeAuthHash(),
        sessions: { sid: { threadId: 'thread', namespace: 'ns', active: true } } };
}
describe('shared runtime ownership', () => {
    it('keeps Windows lock admission asynchronous and batches only relevant generations', async () => {
        const owner = await fixture(); owner.pendingCreations = ['unbound']; await saveRuntime(owner);
        await saveRuntime({ ...owner, id: 'unrelated', pid: 3333, serverPid: 4444, pendingCreations: [], sessions: {} });
        state.windows = true;
        let heartbeat = false;
        const timer = setTimeout(() => { heartbeat = true; }, 0);
        state.markers.mockImplementation(async () => {
            await new Promise(resolve => setTimeout(resolve, 20));
            expect(heartbeat).toBe(true);
            return new Map(); // Both generations have exited.
        });
        try {
            await expect(Promise.all([
                withThreadOwnership(owner.codexHome, 'discovered', 'bridge', async () => 'discovered'),
                withThreadOwnership(owner.codexHome, 'created', 'new', async () => 'created', 'created'),
            ])).resolves.toEqual(['discovered', 'created']);
            expect(state.markers).toHaveBeenCalledWith([1111, 2222]);
            expect(state.markers).not.toHaveBeenCalledWith(expect.arrayContaining([3333]));
            expect(state.alive).not.toHaveBeenCalled(); expect(state.marker).not.toHaveBeenCalled();
        } finally { clearTimeout(timer); }
    });
    it('retains Windows orphan, unknown-creation and inaccessible-process protection', async () => {
        const owner = await fixture(); owner.pendingCreations = ['unbound']; await saveRuntime(owner); state.windows = true;
        state.markers.mockResolvedValue(new Map([[2222, owner.serverMarker]]));
        await expect(withThreadOwnership(owner.codexHome, 'unknown', 'new', async () => {})).rejects.toThrow('unconfirmed creation');
        await expect(withThreadOwnership(owner.codexHome, 'thread', 'new', async () => {}, 'created')).rejects.toThrow('orphaned');
        state.markers.mockResolvedValue(new Map([[1111, 'reused'], [2222, 'reused']]));
        await expect(withThreadOwnership(owner.codexHome, 'thread', 'new', async () => 'safe')).resolves.toBe('safe');
        state.markers.mockRejectedValue(new Error('OpenProcess denied'));
        const work = vi.fn();
        await expect(withThreadOwnership(owner.codexHome, 'thread', 'new', work)).rejects.toThrow('OpenProcess denied');
        expect(work).not.toHaveBeenCalled();
    });
    it('distinguishes PID reuse from an unknown generation and a live orphan engine', async () => {
        const owner = await fixture(); state.processes.set(1111, 'different-start');
        expect(runtimeAlive(owner)).toBe(false); expect(runtimeMayBeAlive(owner)).toBe(false);
        state.processes.set(1111, undefined); expect(runtimeMayBeAlive(owner)).toBe(true);
        state.processes.delete(1111); state.processes.set(2222, 'server-start'); expect(runtimeMayBeAlive(owner)).toBe(true);
        await saveRuntime(owner);
        await expect(withThreadOwnership(owner.codexHome, 'thread', 'new', async () => {})).rejects.toThrow('orphaned');
    });
    it('protects one native store even across HAPI homes and scopes attach by authentication', async () => {
        const owner = await fixture(); state.processes.set(1111, owner.marker); await saveRuntime(owner);
        expect(await findRuntime('sid')).toMatchObject({ id: owner.id });
        state.auth = 'other'; expect(await findRuntime('sid')).toBeUndefined();
        state.home = join(directories[0], 'different-hapi');
        await expect(withThreadOwnership(owner.codexHome, 'thread', 'new', async () => {})).rejects.toThrow('hapi resume sid');
        state.processes.clear(); expect(await withThreadOwnership(owner.codexHome, 'thread', 'new', async () => 'safe')).toBe('safe');
    });
    it('fails closed on corrupt records and unknown thread IDs after a creation timeout', async () => {
        const owner = await fixture(); owner.pendingCreations = ['unbound']; state.processes.set(1111, owner.marker); await saveRuntime(owner);
        await expect(withThreadOwnership(owner.codexHome, 'unknown-thread', 'new', async () => {})).rejects.toThrow('unconfirmed creation');
        const directory = join(owner.codexHome, 'hapi-runtime-owners'); await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'broken.json'), '{');
        await expect(withThreadOwnership(owner.codexHome, 'thread', 'new', async () => {})).rejects.toThrow('Cannot verify');
    });
    it('allows confirmed new threads while retaining cold-resume and active-owner protection', async () => {
        const owner = await fixture(); owner.pendingCreations = ['unbound']; state.processes.set(1111, owner.marker); await saveRuntime(owner);
        expect(await withThreadOwnership(owner.codexHome, 'new-thread', 'new', async () => 'bound', 'created')).toBe('bound');
        await expect(withThreadOwnership(owner.codexHome, 'thread', 'new', async () => {}, 'created')).rejects.toThrow('hapi resume sid');
        await expect(withThreadOwnership(owner.codexHome, 'new-thread', 'new', async () => {})).rejects.toThrow('unconfirmed creation');
    });
    it('readRuntimes({ strict: true }) fails closed on corrupt hub registry files', async () => {
        // Soft [] would let stopSession argv-sweep tree-kill shared wrappers (#1911).
        const owner = await fixture();
        const directory = join(state.home, 'codex-runtimes');
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'broken.json'), '{');
        expect(await readRuntimes()).toEqual([]);
        await expect(readRuntimes({ strict: true })).rejects.toThrow('Cannot verify');
    });
});
