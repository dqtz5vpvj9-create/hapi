import { win32 } from 'node:path';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock, existsSyncMock, homedirMock } = vi.hoisted(() => ({
    execFileSyncMock: vi.fn(),
    existsSyncMock: vi.fn(),
    homedirMock: vi.fn(() => 'home\junes')
}));

vi.mock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    return {
        ...actual,
        execFileSync: execFileSyncMock
    };
});

vi.mock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    return {
        ...actual,
        existsSync: existsSyncMock
    };
});

vi.mock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');
    return {
        ...actual,
        homedir: homedirMock
    };
});

const originalEnv = process.env;
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const homeDir = win32.join('home', 'junes');
const nodeRoot = win32.join('toolchains', 'nodejs');

function codexShimPath(): string {
    return win32.join(nodeRoot, 'codex.cmd');
}

function nativeCodexPath(): string {
    return win32.join(
        nodeRoot,
        'node_modules',
        '@openai',
        'codex',
        'node_modules',
        '@openai',
        'codex-win32-x64',
        'vendor',
        'x86_64-pc-windows-msvc',
        'bin',
        'codex.exe'
    );
}

function codexScriptPath(): string {
    return win32.join(nodeRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
}

function userCodexExePath(): string {
    return win32.join(homeDir, '.local', 'bin', 'codex.exe');
}

function setPlatform(value: string) {
    Object.defineProperty(process, 'platform', {
        value,
        configurable: true
    });
}

describe('resolveCodexCommand', () => {
    beforeAll(() => {
        if (!originalPlatformDescriptor?.configurable) {
            throw new Error('process.platform is not configurable in this runtime');
        }
    });

    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        process.env = { ...originalEnv };
        homedirMock.mockReturnValue(homeDir);
        process.env.PATH = `${nodeRoot};${win32.join(homeDir, '.local', 'bin')}`;
        process.env.PATHEXT = '.exe;.cmd';
        execFileSyncMock.mockImplementation(() => {
            throw new Error('not found');
        });
        existsSyncMock.mockReturnValue(false);
    });

    afterAll(() => {
        process.env = originalEnv;
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', originalPlatformDescriptor);
        }
    });

    it('resolves a Windows npm codex.cmd shim through the Codex launcher', async () => {
        setPlatform('win32');
        const shim = codexShimPath();
        const laterExe = userCodexExePath();
        const executable = nativeCodexPath();
        const script = codexScriptPath();
        existsSyncMock.mockImplementation((candidate: string) =>
            candidate === shim || candidate === laterExe || candidate === executable || candidate === script
        );
        const { resolveCodexCommand } = await import('./codexExecutable');

        expect(execFileSyncMock).not.toHaveBeenCalled();
        expect(resolveCodexCommand()).toEqual({
            command: 'node',
            args: [script]
        });
    });

    it('continues to the next Windows PATH candidate when a shim has no launcher script', async () => {
        setPlatform('win32');
        const shim = codexShimPath();
        const executable = userCodexExePath();
        existsSyncMock.mockImplementation((candidate: string) => candidate === shim || candidate === executable);
        const { resolveCodexCommand } = await import('./codexExecutable');

        expect(execFileSyncMock).not.toHaveBeenCalled();
        expect(resolveCodexCommand()).toEqual({
            command: executable,
            args: []
        });
    });

    it('keeps a Windows codex.exe found first on PATH', async () => {
        setPlatform('win32');
        const executable = userCodexExePath();
        existsSyncMock.mockImplementation((candidate: string) => candidate === executable);
        const { resolveCodexCommand } = await import('./codexExecutable');

        expect(execFileSyncMock).not.toHaveBeenCalled();
        expect(resolveCodexCommand()).toEqual({
            command: executable,
            args: []
        });
    });

    it('falls back to node plus codex.js when a Windows shim has no native exe', async () => {
        setPlatform('win32');
        const shim = codexShimPath();
        const script = codexScriptPath();
        existsSyncMock.mockImplementation((candidate: string) => candidate === shim || candidate === script);
        const { resolveCodexCommand } = await import('./codexExecutable');

        expect(execFileSyncMock).not.toHaveBeenCalled();
        expect(resolveCodexCommand()).toEqual({
            command: 'node',
            args: [script]
        });
    });

    it('uses the plain codex command outside Windows', async () => {
        setPlatform('linux');
        process.env.PATH = '';
        const { resolveCodexCommand } = await import('./codexExecutable');

        expect(execFileSyncMock).not.toHaveBeenCalled();
        expect(resolveCodexCommand()).toEqual({
            command: 'codex',
            args: []
        });
    });

    it('uses the fixed macOS Codex app executable when PATH has no CLI', async () => {
        setPlatform('darwin');
        process.env.PATH = '';
        const { MACOS_CODEX_APP_COMMAND, resolveCodexCommand } = await import('./codexExecutable');
        existsSyncMock.mockImplementation((candidate: string) => candidate === MACOS_CODEX_APP_COMMAND);

        expect(execFileSyncMock).not.toHaveBeenCalled();
        expect(resolveCodexCommand()).toEqual({
            command: MACOS_CODEX_APP_COMMAND,
            args: []
        });
    });
});
