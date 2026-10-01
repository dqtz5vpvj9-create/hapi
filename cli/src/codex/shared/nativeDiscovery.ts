import type { CodexAppServerClient } from '../codexAppServerClient';
import { record, string } from './gateway';

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
