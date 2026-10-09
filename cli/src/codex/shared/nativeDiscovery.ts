import type { CodexAppServerClient } from '../codexAppServerClient';
import { record, string } from './gateway';

export async function readResumableNativeRoot(client: Pick<CodexAppServerClient, 'request'>, threadId: string): Promise<Record<string, unknown>> {
    const thread = record(record(await client.request('thread/read', { threadId, includeTurns: false })).thread);
    if (thread.parentThreadId) throw new Error('Connect the root Codex thread instead of a subagent');
    // Loaded threads can lack a persisted rollout. Confirm resume before
    // bootstrap publishes or reactivates a HAPI row on every discovery scan.
    await client.request('thread/resume', { threadId, excludeTurns: true });
    return thread;
}

export async function listLoadedNativeThreads(client: Pick<CodexAppServerClient, 'request'>): Promise<Set<string>> {
    const ids = new Set<string>();
    let cursor: string | undefined;
    do {
        const page = record(await client.request('thread/loaded/list', { cursor }));
        if (!Array.isArray(page.data)) throw new Error('Invalid native loaded-thread response');
        for (const id of page.data) if (typeof id === 'string') ids.add(id);
        cursor = string(page.nextCursor);
    } while (cursor);
    return ids;
}

export async function requireLoadedNativeThread(client: Pick<CodexAppServerClient, 'request'>, threadId: string): Promise<void> {
    if (!(await listLoadedNativeThreads(client)).has(threadId)) {
        throw new Error('Native thread is no longer loaded; refusing to start another execution');
    }
}
