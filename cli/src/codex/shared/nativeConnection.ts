import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { getWindowsProcessStartMarkers } from '@/utils/process';
import { CodexAppServerClient } from '../codexAppServerClient';
import type { ModelListResponse } from '../appServerTypes';
import { initializeSharedClient } from './launch';
import { codexHome, readRuntimes, runtimeAlive, runtimeAuthHash } from './registry';

/** Connect through an existing authenticated bridge. Never launch a Codex process. */
async function nativeBridgeRequest(method: string, params: Record<string, unknown>, allowAbsent = false): Promise<unknown> {
    const began = performance.now();
    const runtimes = allowAbsent ? await readRuntimes({ strict: true }) : await readRuntimes();
    const readMs = performance.now() - began;
    const home = codexHome(), authHash = runtimeAuthHash();
    const candidates = runtimes.filter(runtime => runtime.nativeEndpoint
        && runtime.codexHome === home && runtime.hub === configuration.apiUrl
        && runtime.authHash === authHash);
    const filterMs = performance.now() - began - readMs;
    // Ordinary CLI installations can discover models without a native daemon.
    // A configured but stale, ambiguous, or unverifiable bridge must still fail.
    if (allowAbsent && candidates.length === 0) return null;
    const markers = process.platform === 'win32'
        ? await getWindowsProcessStartMarkers(candidates.map(runtime => runtime.pid))
        : null;
    const markerMs = performance.now() - began - readMs - filterMs;
    const bridges = candidates.filter(runtime => markers
        ? markers.get(runtime.pid) === runtime.marker
        : runtimeAlive(runtime));
    if (performance.now() - began > 50) logger.debug('[NativeCodexBridge] Slow verification', { readMs, filterMs, markerMs, records: runtimes.length, candidates: candidates.length, bridges: bridges.length });
    if (bridges.length !== 1) throw new Error(bridges.length
        ? 'Multiple native Codex bridges are available; select a machine with one configured bridge'
        : 'Native Codex bridge is unavailable. Connect the existing daemon before opening this session.');
    const runtime = bridges[0];
    const client = new CodexAppServerClient({ endpoint: runtime.endpoint, token: runtime.token });
    client.setServerRequestHandler(() => {});
    const connectStarted = performance.now();
    try {
        await initializeSharedClient(client);
        return await client.request(method, params);
    } finally {
        await client.disconnect();
        const ms = performance.now() - connectStarted;
        if (ms > 50) logger.debug('[NativeCodexBridge] Slow transport', { method, ms });
    }
}

export async function connectNativeCodexThread(threadId: string): Promise<unknown> {
    return await nativeBridgeRequest('hapi/connectThread', { threadId });
}
/** Read the account catalog without owning or terminating an app-server process. */
export async function nativeCodexModels(includeHidden: boolean): Promise<ModelListResponse | null> {
    return await nativeBridgeRequest('model/list', { includeHidden }, true) as ModelListResponse | null;
}
export async function nativeCodexEligibility(): Promise<{ loaded: Set<string>; error?: string }> {
    try {
        const result = await nativeBridgeRequest('hapi/listThreads', {}) as { loaded: string[] };
        return { loaded: new Set(result.loaded) };
    } catch (error) { return { loaded: new Set(), error: error instanceof Error ? error.message : String(error) }; }
}
