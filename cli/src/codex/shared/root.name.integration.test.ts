import { expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Metadata, AgentState } from '@/api/types';
import type { ApiSessionClient } from '@/api/apiSession';
import type { SessionBootstrapResult } from '@/agent/sessionFactory';
import { CodexAppServerClient } from '../codexAppServerClient';
import { SharedCodexRoot } from './root';
import { record } from './gateway';
import { initializeSharedClient, resolveSharedCodex } from './launch';

it('syncs real native renames, repairs missed events and reconnects without loading messages or calling a model', async () => {
    const directory = await mkdtemp('/mnt/cache/data-cache/hapi-title-integration-');
    const home = join(directory, 'codex');
    await mkdir(home);
    await writeFile(join(home, 'config.toml'), 'model = "mock"\nmodel_provider = "mock"\n[model_providers.mock]\nname = "No model calls"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n');
    const endpoint = `unix://${join(directory, 'native.sock')}`;
    const command = resolveSharedCodex();
    const server = spawn(command.command, [...command.args, 'app-server', '--listen', endpoint], {
        env: { ...process.env, CODEX_HOME: home }, cwd: directory, stdio: 'ignore'
    });
    const exited = new Promise<void>(resolve => server.once('exit', () => resolve()));
    const native = new CodexAppServerClient({ endpoint });
    let metadata: Metadata = { path: directory, host: 'test', flavor: 'codex', name: 'Stale imported name' };
    let state: AgentState = {};
    const session = {
        sessionId: 'test-session', getMetadata: () => metadata,
        updateMetadata: (fn: (metadata: Metadata) => Metadata) => { metadata = fn(metadata); },
        updateAgentState: (fn: (state: AgentState) => AgentState) => { state = fn(state); },
        onUserMessage() {}, onCancelQueuedMessage() {}, onRetryQueuedMessage() {}, onReconnect() {}, on() {},
        rpcHandlerManager: { registerHandler() {} }, keepAlive() {}, emitSessionReady() {}, emitNativeHistoryChanged() {},
        syncNativeQueueSnapshot() {}, emitSteerIndeterminate() {}, emitMessagesConsumed() {}, setSteerDeliveryState() {},
        sendSessionDeath() {}, async flush() {}, close() {}
    } as unknown as ApiSessionClient;
    let root: SharedCodexRoot | undefined;
    const bind = async (threadId: string) => {
        root = new SharedCodexRoot({ session, workingDirectory: directory } as SessionBootstrapResult, {
            directory, generation: 'test', endpoint, external: true, codexHome: home,
            settingsFor: () => undefined, create: async () => { throw new Error('Unexpected creation'); }, end: async () => {}
        });
        await root.prepare();
        await root.bind(threadId, {}, true);
        await root.activate();
        return root;
    };
    try {
        await vi.waitFor(async () => { await access(join(directory, 'native.sock')); }, { timeout: 10_000 });
        await initializeSharedClient(native);
        const created = await native.request('thread/start', { cwd: directory });
        const threadId = String(record(record(created).thread).id);
        await native.request('thread/name/set', { threadId, name: 'Native project' });
        const first = await bind(threadId);
        expect(metadata.name).toBe('Native project');
        await native.request('thread/name/set', { threadId, name: 'Native renamed project' });
        await vi.waitFor(() => expect(metadata.name).toBe('Native renamed project'));
        first.client.setNotificationHandler(() => {});
        await native.request('thread/name/set', { threadId, name: 'Changed without event delivery' });
        expect(metadata.name).toBe('Native renamed project');
        const requests = vi.spyOn(first.client, 'request');
        await (first as unknown as { refreshNativeName(): Promise<void> }).refreshNativeName();
        expect(metadata.name).toBe('Changed without event delivery');
        expect(requests.mock.calls).toEqual([['thread/read', { threadId, includeTurns: false }]]);
        await first.close(false);
        await native.request('thread/name/set', { threadId, name: 'Changed while HAPI was offline' });
        await bind(threadId);
        expect(metadata.name).toBe('Changed while HAPI was offline');
        metadata = { ...metadata, name: 'My local HAPI alias' };
        await root!.close(false);
        await bind(threadId);
        expect(metadata.name).toBe('My local HAPI alias');
        const thread = await native.request('thread/read', { threadId, includeTurns: true });
        expect(record(record(thread).thread).turns).toEqual([]);
    } finally {
        await root?.close(false);
        await native.disconnect();
        server.kill('SIGTERM');
        await exited;
        await rm(directory, { recursive: true, force: true });
    }
}, 30_000);
