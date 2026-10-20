import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ exec: vi.fn(), stat: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: Object.assign(mocks.exec, {
    // Match execFile's custom promisify contract (stdout + stderr).
    [Symbol.for('nodejs.util.promisify.custom')]: (...args: unknown[]) => new Promise((resolve, reject) => {
        mocks.exec(...args, (error: Error | null, stdout: string) => error ? reject(error) : resolve({ stdout, stderr: '' }));
    })
}) }));
vi.mock('node:fs/promises', () => ({ stat: mocks.stat }));
vi.mock('../utils/codexExecutable', () => ({ resolveCodexCommand: () => ({ command: '/codex', args: [] }) }));
afterEach(() => { vi.resetModules(); vi.resetAllMocks(); });

it('shares an in-flight version check and rechecks after an executable replacement', async () => {
    mocks.stat.mockResolvedValue({ mtimeMs: 1, size: 42 });
    const callbacks: Array<(error: Error | null, stdout?: string) => void> = [];
    mocks.exec.mockImplementation((_command, _args, _options, callback) => callbacks.push(callback));
    const { resolveSharedCodex } = await import('./launch');
    const first = resolveSharedCodex();
    const second = resolveSharedCodex();
    await vi.waitFor(() => expect(mocks.exec).toHaveBeenCalledTimes(1));
    callbacks.shift()!(null, 'codex-cli 0.154.0');
    await expect(first).resolves.toEqual({ command: '/codex', args: [] });
    await second;
    await resolveSharedCodex();
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    mocks.stat.mockResolvedValue({ mtimeMs: 2, size: 43 });
    const replaced = resolveSharedCodex();
    await vi.waitFor(() => expect(mocks.exec).toHaveBeenCalledTimes(2));
    callbacks.shift()!(null, 'codex-cli 0.153.0');
    await expect(replaced).rejects.toThrow('Codex >= 0.154.0');
});

it('does not cache a failed process launch', async () => {
    mocks.stat.mockResolvedValue({ mtimeMs: 1, size: 42 });
    mocks.exec.mockImplementation((_command, _args, _options, callback) => callback(new Error('launch failed')));
    const { resolveSharedCodex } = await import('./launch');
    await expect(resolveSharedCodex()).rejects.toThrow('launch failed');
    await expect(resolveSharedCodex()).rejects.toThrow('launch failed');
    expect(mocks.exec).toHaveBeenCalledTimes(2);
});
