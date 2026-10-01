export class NativeHistoryFixture {
    readonly calls: Array<{ method: string; params: Record<string, unknown>; count: number; bytes: number }> = [];
    readonly threads = new Map<string, { id: string; cwd: string; name: string; historyMode: string; createdAt: number; parentThreadId?: string; items: any[] }>();
    readonly loaded = new Set(['thread-a']);
    constructor(cwd: string, count = 1200) {
        for (const id of ['thread-a', 'thread-b', 'history-1', 'history-2', 'history-3']) {
            const items = Array.from({ length: id === 'thread-a' ? count : 4 }, (_, i) => ({
                turnId: `turn-${Math.floor(i / 4)}`, startedAtMs: 1_700_000_000_000 + i, completedAtMs: 1_700_000_000_000 + i,
                item: i % 4 === 0 ? { id: `item-${i}`, type: 'userMessage', content: [{ type: 'text', text: `${id} QUESTION ${i}` }] }
                    : i % 4 === 1 ? { id: `item-${i}`, type: 'agentMessage', text: `${id} ANSWER ${i} ` + 'Readable native history. '.repeat(40) }
                    : i % 4 === 2 ? { id: `item-${i}`, type: 'commandExecution', command: 'echo native', cwd, status: 'completed', aggregatedOutput: `${id} TOOL ${i}`, exitCode: 0, durationMs: 1 }
                    : { id: `item-${i}`, type: 'reasoning', summary: [`${id} REASON ${i}`], content: [] }
            }));
            this.threads.set(id, { id, cwd, name: id === 'thread-b' ? 'Long native history' : id, historyMode: 'paginated', createdAt: 1_700_000_000, items });
        }
    }
    async request(method: string, params: Record<string, unknown> = {}): Promise<any> {
        let result: any;
        const thread = this.threads.get(String(params.threadId));
        if (method === 'initialize') result = { userAgent: 'native-fixture', platformFamily: 'unix', platformOs: 'linux' };
        else if (method === 'server/capabilities') result = { capabilities: {} };
        else if (method === 'thread/loaded/list') result = { data: [...this.loaded], nextCursor: null };
        else if (method === 'thread/read' || method === 'thread/resume') {
            if (!thread) throw new Error('Thread not found');
            if (method === 'thread/resume' && !this.loaded.has(thread.id)) throw new Error('Forbidden: fixture must not resume an unloaded thread');
            const { items, ...metadata } = thread;
            result = { thread: { ...metadata, status: { type: 'idle' }, turns: [] }, model: 'fixture-model', modelProvider: 'fixture', cwd: thread.cwd,
                approvalPolicy: 'never', sandbox: { type: 'readOnly' }, reasoningEffort: 'medium' };
        } else if (method === 'thread/items/list') {
            if (!thread) throw new Error('Thread not found');
            const visible = params.turnId ? thread.items.filter(entry => entry.turnId === params.turnId) : thread.items;
            const desc = params.sortDirection !== 'asc'; const limit = Number(params.limit ?? 32);
            let all = desc ? [...visible].reverse() : visible;
            if (typeof params.cursor === 'string') {
                const index = Number(params.cursor.slice(2));
                all = all.filter(entry => desc ? thread.items.indexOf(entry) <= index : thread.items.indexOf(entry) >= index);
            } else if (params.cursor && typeof params.cursor === 'object') {
                const index = all.findIndex(entry => entry.item.id === (params.cursor as any).itemId);
                all = index < 0 ? [] : all.slice(index + 1);
            }
            const data = all.slice(0, limit); const remaining = all.slice(limit);
            result = { data, nextCursor: remaining.length ? `i:${thread.items.indexOf(remaining[0])}` : null,
                backwardsCursor: data.length ? `i:${thread.items.indexOf(data[0])}` : null };
        } else if (method === 'thread/turns/list') result = { data: [], nextCursor: null };
        else if (method === 'thread/list') result = { data: [], nextCursor: null };
        else if (method === 'thread/queue/list') result = { data: [] };
        else if (method === 'model/list') result = { data: [], nextCursor: null };
        else throw new Error(`Forbidden or unsupported native method: ${method}`);
        this.calls.push({ method, params, count: result.data?.length ?? 0, bytes: Buffer.byteLength(JSON.stringify(result)) });
        return structuredClone(result);
    }
}
