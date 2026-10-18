import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionBootstrapResult } from '@/agent/sessionFactory';
import type { ApiSessionClient } from '@/api/apiSession';
import { SharedCodexRoot, type RootHost } from './root';

const state = vi.hoisted(() => ({ readConfig: vi.fn(), stopBridge: vi.fn(), warn: vi.fn() }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: state.warn } }));
vi.mock('../codexAppServerClient', () => ({
    CodexAppServerClient: class {
        async connect() {}
        async initialize() {}
        async disconnect() {}
        isInitialized() { return true; }
        setNotificationHandler() {}
        setTransportAbandonedHandler() {}
        setServerRequestHandler() {}
        readConfig = state.readConfig;
    },
    isIndeterminateError: () => false
}));
vi.mock('../utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async (session: ApiSessionClient) => ({
        mcpServers: { hapi: { command: 'hapi', args: ['mcp', '--session', session.sessionId] } },
        server: { stop: state.stopBridge }
    })
}));
vi.mock('@/utils/spawnHappyCLI', () => ({
    getHappyCliCommand: (args: string[]) => ({ command: 'hapi', args })
}));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const roots: SharedCodexRoot[] = [];
type McpRootConfig = Record<string, unknown> & {
    mcp_servers: Record<string, Record<string, unknown> & { args: string[] }>
    'mcp_servers.hapi': { command: string; args: string[] }
};
const userServers = {
    packages: { command: 'uvx', args: ['example-mcp'], env_vars: ['EXAMPLE_TOKEN'], env: { PUBLIC_SETTING: 'value' }, tool_timeout_sec: 60 },
    direct: { command: 'node', args: ['server.js'], enabled: false },
    remote: { url: 'https://example.test/mcp', bearer_token_env_var: 'REMOTE_TOKEN' },
    hapi: { command: 'user-hapi-must-not-win' }
};

beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    state.readConfig.mockResolvedValue({ config: { mcp_servers: userServers } });
});
afterEach(async () => {
    try { await Promise.all(roots.splice(0).map(root => root.close(false))); }
    finally { Object.defineProperty(process, 'platform', platform); }
});

function rootFixture(sessionId = 'root-a', external = false): SharedCodexRoot {
    const session = {
        sessionId,
        getMetadata: () => ({ path: '/work' }),
        onUserMessage() {}, onCancelQueuedMessage() {}, onRetryQueuedMessage() {}, onReconnect() {},
        updateAgentState() {}, keepAlive() {}, sendSessionDeath() {}, async flush() {}, close() {},
        rpcHandlerManager: { registerHandler() {} }
    } as unknown as ApiSessionClient;
    const root = new SharedCodexRoot({ session, workingDirectory: '/work' } as SessionBootstrapResult, {
        directory: '/queues', generation: 'test', endpoint: 'mock', external,
        settingsFor: () => undefined,
        create: async () => { throw new Error('Unexpected root creation'); },
        end: async () => { throw new Error('Unexpected archive'); }
    } satisfies RootHost);
    roots.push(root);
    return root;
}

describe('shared root Windows MCP compatibility', () => {
    it('prepares inherited shims for the current root and releases their specs on close', async () => {
        const root = rootFixture();
        await root.prepare();
        expect(state.readConfig).toHaveBeenCalledWith({ cwd: '/work', includeLayers: false });

        const config = root.config({ config: { model_context_window: 1234 } }).config as McpRootConfig;
        const packages = config.mcp_servers.packages;
        expect(packages.args).toContain('mcp-proxy');
        expect(packages).toMatchObject({ env_vars: ['EXAMPLE_TOKEN'], env: { PUBLIC_SETTING: 'value' }, tool_timeout_sec: 60 });
        expect(config.mcp_servers.direct).toEqual(userServers.direct);
        expect(config.mcp_servers.remote).toEqual(userServers.remote);
        expect(config.mcp_servers).not.toHaveProperty('hapi');
        expect(config['mcp_servers.hapi']).toEqual({ command: 'hapi', args: ['mcp', '--session', 'root-a'] });
        expect(config.model_context_window).toBe(1234);
        expect(config['shell_environment_policy.set.HAPI_SESSION_ID']).toBe('root-a');
        const spec = packages.args.at(-1) as string;
        expect(JSON.parse(await readFile(spec, 'utf8'))).toEqual({ command: 'uvx', args: ['example-mcp'] });
        await root.close(false);
        expect(existsSync(spec)).toBe(false);
    });

    it('keeps root identities and proxy lifetimes independent while preserving explicit config', async () => {
        const first = rootFixture();
        const second = rootFixture('root-b');
        await first.prepare(); await second.prepare();
        const firstConfig = first.config({}).config as McpRootConfig;
        const override = { command: 'custom-server', args: ['--explicit'] };
        const secondConfig = second.config({ config: { mcp_servers: { extra: override }, 'mcp_servers.hapi': 'ignored' } }).config as McpRootConfig;
        const firstSpec = firstConfig.mcp_servers.packages.args.at(-1) as string;
        const secondSpec = secondConfig.mcp_servers.packages.args.at(-1) as string;
        expect(firstSpec).not.toBe(secondSpec);
        expect(secondConfig.mcp_servers.extra).toEqual(override);
        expect(secondConfig['mcp_servers.hapi'].args).toContain('root-b');
        await first.close(false);
        expect(existsSync(firstSpec)).toBe(false);
        expect(existsSync(secondSpec)).toBe(true);
    });

    it('keeps native config inheritance if config/read is unavailable', async () => {
        state.readConfig.mockRejectedValueOnce(new Error('config/read unavailable'));
        const root = rootFixture();
        await expect(root.prepare()).resolves.toBeUndefined();
        const config = root.config({ config: { model_context_window: 1234 } }).config as Record<string, unknown>;
        expect(config).not.toHaveProperty('mcp_servers');
        expect(config.model_context_window).toBe(1234);
        expect(config).toHaveProperty('mcp_servers.hapi');
        expect(state.warn).toHaveBeenCalledOnce();
    });

    it('leaves externally owned native sessions untouched', async () => {
        const root = rootFixture('external', true);
        await root.prepare();
        const params = { config: { mcp_servers: { custom: { command: 'uvx' } } } };
        expect(root.config(params)).toBe(params);
        expect(state.readConfig).not.toHaveBeenCalled();
    });

    it('inherits native MCP configuration directly on non-Windows platforms', async () => {
        Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
        const root = rootFixture();
        await root.prepare();
        expect(state.readConfig).not.toHaveBeenCalled();
        expect(root.config({}).config).not.toHaveProperty('mcp_servers');
    });
});
