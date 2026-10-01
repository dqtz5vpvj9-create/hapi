import { configuration } from '@/configuration';
import { CodexAppServerClient } from '../codexAppServerClient';
import { initializeSharedClient } from './launch';
import { codexHome, readRuntimes, runtimeAlive, runtimeAuthHash } from './registry';

/** Connect through an existing authenticated bridge. Never launch a Codex process. */
async function nativeBridgeRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const bridges = (await readRuntimes()).filter(runtime => runtime.nativeEndpoint
        && runtime.codexHome === codexHome() && runtime.hub === configuration.apiUrl
        && runtime.authHash === runtimeAuthHash() && runtimeAlive(runtime));
    if (bridges.length !== 1) throw new Error(bridges.length
        ? 'Multiple native Codex bridges are available; select a machine with one configured bridge'
        : 'Native Codex bridge is unavailable. Connect the existing daemon before opening this session.');
    const runtime = bridges[0];
    const client = new CodexAppServerClient({ endpoint: runtime.endpoint, token: runtime.token });
    client.setServerRequestHandler(() => {});
    try {
        await initializeSharedClient(client);
        return await client.request(method, params);
    } finally { await client.disconnect(); }
}

export async function connectNativeCodexThread(threadId: string): Promise<unknown> {
    return await nativeBridgeRequest('hapi/connectThread', { threadId });
}
export async function nativeCodexEligibility(): Promise<{ loaded: Set<string>; error?: string }> {
    try {
        const result = await nativeBridgeRequest('hapi/listThreads', {}) as { loaded: string[] };
        return { loaded: new Set(result.loaded) };
    } catch (error) { return { loaded: new Set(), error: error instanceof Error ? error.message : String(error) }; }
}
