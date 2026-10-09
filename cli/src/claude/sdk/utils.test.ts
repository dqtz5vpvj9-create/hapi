import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { existsSyncMock, execFileSyncMock, execSyncMock, homedirMock } = vi.hoisted(() => ({
    existsSyncMock: vi.fn(),
    execFileSyncMock: vi.fn(),
    execSyncMock: vi.fn(),
    homedirMock: vi.fn(() => 'C:\\Users\\junes')
}))

vi.mock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    return {
        ...actual,
        existsSync: existsSyncMock
    }
})

vi.mock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    return {
        ...actual,
        execFileSync: execFileSyncMock,
        execSync: execSyncMock
    }
})

vi.mock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os')
    return {
        ...actual,
        homedir: homedirMock
    }
})

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
const originalEnv = process.env

function setPlatform(value: string) {
    Object.defineProperty(process, 'platform', {
        value,
        configurable: true
    })
}

describe('getDefaultClaudeCodePath', () => {
    beforeAll(() => {
        if (!originalPlatformDescriptor?.configurable) {
            throw new Error('process.platform is not configurable in this runtime')
        }
    })

    beforeEach(() => {
        vi.clearAllMocks()
        vi.resetModules()
        process.env = { ...originalEnv }
        delete process.env.HAPI_CLAUDE_PATH
        process.env.PATH = 'C:\\nvm4w\\nodejs;C:\\tools'
        process.env.PATHEXT = '.EXE;.CMD'
        homedirMock.mockReturnValue('C:\\Users\\junes')
        execFileSyncMock.mockImplementation(() => {
            throw new Error('not found')
        })
        execSyncMock.mockImplementation(() => {
            throw new Error('not found')
        })
        existsSyncMock.mockReturnValue(false)
    })

    afterAll(() => {
        process.env = originalEnv
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', originalPlatformDescriptor)
        }
    })

    it('uses HAPI_CLAUDE_PATH when set', async () => {
        process.env.HAPI_CLAUDE_PATH = 'C:\\tools\\claude.exe'
        const { getDefaultClaudeCodePath } = await import('./utils')

        expect(getDefaultClaudeCodePath()).toBe('C:\\tools\\claude.exe')
        expect(execFileSyncMock).not.toHaveBeenCalled()
    })

    it('resolves HAPI_CLAUDE_PATH when it points to a Windows npm shim', async () => {
        setPlatform('win32')
        const shim = 'C:\\nvm4w\\nodejs\\claude.cmd'
        const executable = 'C:\\nvm4w\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
        process.env.HAPI_CLAUDE_PATH = shim
        existsSyncMock.mockImplementation((candidate: string) => candidate === shim || candidate === executable)
        const { getDefaultClaudeCodePath } = await import('./utils')

        expect(getDefaultClaudeCodePath()).toBe(executable)
        expect(execFileSyncMock).not.toHaveBeenCalled()
        expect(execFileSyncMock).not.toHaveBeenCalled()
    })

    it('resolves Windows npm claude.cmd shim to the real Claude Code exe', async () => {
        setPlatform('win32')
        const shim = 'C:\\nvm4w\\nodejs\\claude.cmd'
        const executable = 'C:\\nvm4w\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
        existsSyncMock.mockImplementation((candidate: string) => candidate === shim || candidate === executable)
        const { getDefaultClaudeCodePath } = await import('./utils')

        expect(getDefaultClaudeCodePath()).toBe(executable)
        expect(execFileSyncMock).not.toHaveBeenCalled()
    })

    it('continues through Windows PATH candidates until it finds a resolvable shim', async () => {
        setPlatform('win32')
        process.env.PATH = 'C:\\old-node;C:\\nvm4w\\nodejs'
        const staleShim = 'C:\\old-node\\claude.cmd'
        const validShim = 'C:\\nvm4w\\nodejs\\claude.cmd'
        const executable = 'C:\\nvm4w\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
        existsSyncMock.mockImplementation((candidate: string) => (
            candidate === staleShim || candidate === validShim || candidate === executable
        ))
        const { getDefaultClaudeCodePath } = await import('./utils')

        expect(getDefaultClaudeCodePath()).toBe(executable)
        expect(execFileSyncMock).not.toHaveBeenCalled()
    })

    it('resolves Windows npm extensionless claude shim to the real Claude Code exe', async () => {
        setPlatform('win32')
        const shim = 'C:\\nvm4w\\nodejs\\claude'
        const executable = 'C:\\nvm4w\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
        existsSyncMock.mockImplementation((candidate: string) => candidate === shim || candidate === executable)
        const { getDefaultClaudeCodePath } = await import('./utils')

        expect(getDefaultClaudeCodePath()).toBe(executable)
        expect(execFileSyncMock).not.toHaveBeenCalled()
    })

    it('keeps an actual Windows claude.exe result from PATH', async () => {
        setPlatform('win32')
        const executable = 'C:\\tools\\claude.exe'
        existsSyncMock.mockImplementation((candidate: string) => candidate === executable)
        const { getDefaultClaudeCodePath } = await import('./utils')

        expect(getDefaultClaudeCodePath()).toBe(executable)
        expect(execFileSyncMock).not.toHaveBeenCalled()
    })
})
