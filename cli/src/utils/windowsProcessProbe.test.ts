import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('@/projectPath', () => ({ runtimePath: () => '/runtime' }));
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
function child() {
    const pipe = () => Object.assign(new PassThrough(), { ref: vi.fn(), unref: vi.fn() });
    return Object.assign(new EventEmitter(), { stdin: pipe(), stdout: pipe(), stderr: pipe(), kill: vi.fn(), unref: vi.fn() });
}
beforeEach(() => {
    vi.resetModules(); spawnMock.mockReset();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
});
afterEach(() => { Object.defineProperty(process, 'platform', originalPlatform); vi.useRealTimers(); });
describe('Runner-owned native process probe', () => {
    it('reuses one child but queries fresh generations for every request and preserves response ordering', async () => {
        const helper = child(); spawnMock.mockReturnValue(helper);
        const { startWindowsProcessProbe, queryWindowsProcessGenerations } = await import('./windowsProcessProbe');
        startWindowsProcessProbe(); startWindowsProcessProbe();
        expect(helper.stdout.unref).toHaveBeenCalled();
        const first = queryWindowsProcessGenerations([12]);
        const second = queryWindowsProcessGenerations([13]);
        expect(helper.stdin.read().toString()).toBe('12\n13\n');
        helper.stdout.write('[{"ProcessId":12,"CreationDate":"original"}]\n[{"ProcessId":13,"CreationDate":"new"}]\n');
        expect(await first).toEqual(new Map([[12, 'original']]));
        expect(await second).toEqual(new Map([[13, 'new']]));
        const fresh = queryWindowsProcessGenerations([12]);
        helper.stdout.write('[]\n');
        expect(await fresh).toEqual(new Map());
        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(spawnMock.mock.calls[0][1]).toEqual(['--stdio']);
        expect(helper.stdout.ref).toHaveBeenCalledTimes(3);
    });
    it('reports an OS error without dropping concurrent queries or restarting the worker', async () => {
        const helper = child(); spawnMock.mockReturnValue(helper);
        const { queryWindowsProcessGenerations } = await import('./windowsProcessProbe');
        const failed = queryWindowsProcessGenerations([12]);
        const next = queryWindowsProcessGenerations([13]);
        const rejected = expect(failed).rejects.toThrow('OpenProcess(12) failed: 5');
        helper.stdout.write('{"error":"OpenProcess(12) failed: 5"}\n[{"ProcessId":13,"CreationDate":"valid"}]\n');
        await rejected;
        expect(await next).toEqual(new Map([[13, 'valid']]));
        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(helper.kill).not.toHaveBeenCalled();
    });
    it('rejects pending requests after helper loss and starts a new child for the next query', async () => {
        const old = child(), replacement = child();
        spawnMock.mockReturnValueOnce(old).mockReturnValueOnce(replacement);
        const { queryWindowsProcessGenerations } = await import('./windowsProcessProbe');
        const first = queryWindowsProcessGenerations([12]);
        const rejected = expect(first).rejects.toThrow('exited');
        old.stderr.write('OpenProcess denied'); old.emit('exit', 1);
        await rejected;
        const next = queryWindowsProcessGenerations([12]);
        replacement.stdout.write('[]\n');
        expect(await next).toEqual(new Map());
        expect(spawnMock).toHaveBeenCalledTimes(2);
    });
    it('fails a timed-out worker without terminating other processes', async () => {
        vi.useFakeTimers();
        const helper = child(); spawnMock.mockReturnValue(helper);
        const { queryWindowsProcessGenerations } = await import('./windowsProcessProbe');
        const pending = queryWindowsProcessGenerations([12]);
        const rejected = expect(pending).rejects.toThrow('timed out');
        await vi.advanceTimersByTimeAsync(10_000);
        helper.emit('exit', 1);
        await rejected;
        expect(helper.kill).toHaveBeenCalled();
    });
    it('does not start Windows helpers on Linux', async () => {
        Object.defineProperty(process, 'platform', originalPlatform);
        const { startWindowsProcessProbe } = await import('./windowsProcessProbe');
        startWindowsProcessProbe();
        expect(spawnMock).not.toHaveBeenCalled();
    });
});
