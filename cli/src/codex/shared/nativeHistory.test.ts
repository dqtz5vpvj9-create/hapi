import { describe, expect, it } from 'vitest';
import { NativeCodexHistory } from './nativeHistory';
import { NativeHistoryFixture } from '@/test/nativeHistoryFixture';
import type { MessagesResponse, MessageOutlineResponse, MessageContextResponse, MessageDependenciesResponse } from '@hapi/protocol/apiTypes';

describe('native Codex history adapter', () => {
    it('reads five older boundaries and forward pages using bounded native item requests without duplicates', async () => {
        const source = new NativeHistoryFixture('/fixture');
        const history = new NativeCodexHistory('thread-a', source);
        const latest = await history.read({ limit: 32, bounded: true }) as MessagesResponse;
        const ids = new Set(latest.messages.map(m => m.id));
        let page = latest;
        for (let i = 0; i < 5; i++) {
            const beforeCalls = source.calls.length;
            page = await history.read({ limit: 32, beforeAt: page.page.nextBeforeAt, beforeSeq: page.page.nextBeforeSeq, epoch: page.page.epoch }) as MessagesResponse;
            expect(source.calls.length - beforeCalls).toBeLessThanOrEqual(1);
            for (const message of page.messages) { expect(ids.has(message.id)).toBe(false); ids.add(message.id); }
        }
        const forward = await history.read({ limit: 32, afterAt: page.page.nextAfterAt, afterSeq: page.page.nextAfterSeq, epoch: page.page.epoch }) as MessagesResponse;
        expect(forward.messages.length).toBeGreaterThan(0);
        expect(new Set(forward.messages.map(m => m.id)).size).toBe(forward.messages.length);
        expect(source.calls.every(c => c.method === 'thread/items/list' && Number(c.params.limit) <= 32)).toBe(true);
        expect(ids.size).toBe(192);
    });
    it('uses the same identities for directory selection, context and tool relations, with no Hub source', async () => {
        const source = new NativeHistoryFixture('/fixture'); const history = new NativeCodexHistory('thread-a', source);
        const latest = await history.read({ limit: 50 }) as MessagesResponse;
        const outline = await history.read({ operation: 'outline', limit: 12 }) as MessageOutlineResponse;
        const entry = outline.entries[0];
        const context = await history.read({ operation: 'context', messageId: entry.messageId, radius: 8, epoch: latest.page.epoch }) as MessageContextResponse;
        expect(context.messages.some(m => m.id === entry.messageId)).toBe(true);
        const toolResult = latest.messages.find(m => JSON.stringify(m.content).includes('tool-call-result'))!;
        const deps = await history.read({ operation: 'dependencies', seeds: toolResult.id, epoch: latest.page.epoch }) as MessageDependenciesResponse;
        expect(deps.complete).toBe(true);
        expect(deps.messages.some(m => JSON.stringify(m.content).includes('CodexBash'))).toBe(true);
        expect(source.calls.every(c => c.method === 'thread/items/list')).toBe(true);
    });
    it('recovers parallel and nested child tools from native history and reports unavailable children', async () => {
        const source = new NativeHistoryFixture('/fixture', 4);
        const collab = (id: string, targets: string[]) => ({ turnId: `turn-${id}`, startedAtMs: 1700000000000,
            item: { id, type: 'collabAgentToolCall', tool: 'spawn_agent', status: 'completed', receiverThreadIds: targets,
                agentsStates: Object.fromEntries(targets.map(agent => [agent, { status: 'completed', message: agent }])) } });
        source.threads.get('thread-a')!.items = [collab('spawn', ['child-1', 'child-2'])];
        for (const child of ['child-1', 'child-2', 'grandchild']) source.threads.set(child, { ...source.threads.get('thread-b')!, id: child,
            items: [{ turnId: `turn-${child}`, startedAtMs: 1700000000001, item: { id: `tool-${child}`, type: 'commandExecution', command: `echo ${child}`, status: 'completed', aggregatedOutput: `OUTPUT ${child}`, exitCode: 0 } }] });
        source.threads.get('child-1')!.items.push(collab('nested-spawn', ['grandchild']));
        const history = new NativeCodexHistory('thread-a', source);
        const page = await history.read({ limit: 50 }) as MessagesResponse;
        const seeds = page.messages.map(m => m.id).join(',');
        const dependencies = await history.read({ operation: 'dependencies', seeds, epoch: page.page.epoch }) as MessageDependenciesResponse;
        expect(dependencies.complete).toBe(true);
        for (const child of ['child-1', 'child-2', 'grandchild']) expect(JSON.stringify(dependencies.messages)).toContain(`OUTPUT ${child}`);
        expect(source.calls.filter(c => c.method === 'thread/items/list').every(c => Number(c.params.limit) <= 32)).toBe(true);
        source.threads.delete('child-2'); history.invalidate(false);
        const missing = await history.read({ operation: 'dependencies', seeds, epoch: dependencies.epoch }) as MessageDependenciesResponse;
        expect(missing.complete).toBe(false);
        expect(missing.issues.some(issue => issue.reason === 'unreadable')).toBe(true);
    });

    it('makes fair progress beyond eight parallel children instead of charging completed children again', async () => {
        const source = new NativeHistoryFixture('/fixture', 1);
        const targets = Array.from({ length: 9 }, (_, i) => `child-${i}`);
        source.threads.get('thread-a')!.items = [{ turnId: 'spawn-turn', startedAtMs: 1700000000000,
            item: { id: 'spawn', type: 'collabAgentToolCall', tool: 'spawn_agent', status: 'completed', receiverThreadIds: targets,
                agentsStates: Object.fromEntries(targets.map(agent => [agent, { status: 'completed', message: agent }])) } }];
        for (const child of targets) source.threads.set(child, { ...source.threads.get('thread-b')!, id: child,
            items: [{ turnId: `turn-${child}`, startedAtMs: 1700000000001, item: { id: `answer-${child}`, type: 'agentMessage', text: `ANSWER ${child}` } }] });
        const history = new NativeCodexHistory('thread-a', source);
        const page = await history.read({ limit: 100 }) as MessagesResponse;
        const seeds = page.messages.map(m => m.id).join(',');
        const first = await history.read({ operation: 'dependencies', seeds, epoch: page.page.epoch }) as MessageDependenciesResponse;
        expect(first.complete).toBe(false);
        const second = await history.read({ operation: 'dependencies', seeds, epoch: first.epoch }) as MessageDependenciesResponse;
        expect(second.complete).toBe(true);
        for (const child of targets) expect(JSON.stringify(second.messages)).toContain(`ANSWER ${child}`);
        expect(source.calls.filter(call => call.params.threadId === 'child-8').length).toBe(1);
    });

    it('removes retracted native messages and labels and rejects old epoch positions', async () => {
        const source = new NativeHistoryFixture('/fixture', 12); const history = new NativeCodexHistory('thread-a', source);
        const initial = await history.read({ limit: 50 }) as MessagesResponse;
        source.threads.get('thread-a')!.items.splice(8); history.invalidate();
        const latest = await history.read({ limit: 50 }) as MessagesResponse;
        expect(JSON.stringify(latest.messages)).not.toContain('QUESTION 8');
        expect(latest.page.epoch).not.toBe(initial.page.epoch);
        const old = await history.read({ beforeAt: initial.page.nextBeforeAt, beforeSeq: initial.page.nextBeforeSeq, epoch: initial.page.epoch }) as MessagesResponse;
        expect(old.page.reset).toBe(true);
        const outline = await history.read({ operation: 'outline', limit: 50 }) as MessageOutlineResponse;
        expect(outline.entries.some(entry => entry.label.includes('QUESTION 8'))).toBe(false);
    });

    it('crosses turns and an evicted body window when reading forward to the true native head', async () => {
        const source = new NativeHistoryFixture('/fixture', 1400);
        source.threads.get('thread-a')!.items = Array.from({ length: 1400 }, (_, i) => ({ turnId: `turn-${i}`, startedAtMs: 1700000000000 + i,
            item: { id: `item-${i}`, type: 'userMessage', content: [{ type: 'text', text: `Question ${i}` }] } }));
        const history = new NativeCodexHistory('thread-a', source);
        let page = await history.read({ limit: 32 }) as MessagesResponse;
        for (let i = 0; i < 40; i++) page = await history.read({ limit: 32, beforeAt: page.page.nextBeforeAt, beforeSeq: page.page.nextBeforeSeq, epoch: page.page.epoch }) as MessagesResponse;
        let previous = Number((page.messages.at(-1)!.content as any).content.text.split(' ')[1]);
        for (let i = 0; i < 100; i++) {
            page = await history.read({ limit: 32, afterAt: page.page.nextAfterAt, afterSeq: page.page.nextAfterSeq, epoch: page.page.epoch }) as MessagesResponse;
            for (const message of page.messages) {
                const current = Number((message.content as any).content.text.split(' ')[1]); expect(current).toBe(previous + 1); previous = current;
            }
            if (!page.page.hasMore) break;
        }
        expect(previous).toBe(1399);
        expect(page.page.snapshotHeadAt).toBe(1700000001399);
        expect(source.calls.every(call => call.method === 'thread/items/list' && !call.params.turnId)).toBe(true);
    });

    it('advances bounded reading and outline cursors over native items without display records', async () => {
        const source = new NativeHistoryFixture('/fixture', 96);
        source.threads.get('thread-a')!.items.forEach(entry => { entry.item = { id: entry.item.id, type: 'unknownNonDisplayItem' }; });
        const history = new NativeCodexHistory('thread-a', source);
        let page = await history.read({ limit: 32 }) as MessagesResponse;
        expect(page.messages).toHaveLength(0);
        const firstCursor = page.page.nextBeforeAt;
        page = await history.read({ limit: 32, beforeAt: page.page.nextBeforeAt, beforeSeq: page.page.nextBeforeSeq, epoch: page.page.epoch }) as MessagesResponse;
        expect(page.page.nextBeforeAt).toBeLessThan(firstCursor!);
        const outline = await history.read({ operation: 'outline', limit: 32 }) as MessageOutlineResponse;
        expect(outline.page.beforeCursor).not.toBeNull();
        expect(outline.page.hasMore).toBe(false);
        expect(source.calls).toHaveLength(3);
    });

    it('does not reset an unchanged page when native items share a timestamp', async () => {
        const source = new NativeHistoryFixture('/fixture', 800);
        source.threads.get('thread-a')!.items.forEach((entry, i) => { entry.startedAtMs = 1700000000000 + Math.floor(i / 100); });
        const history = new NativeCodexHistory('thread-a', source);
        const latest = await history.read({ limit: 32 }) as MessagesResponse;
        let outline = await history.read({ operation: 'outline', limit: 100 }) as MessageOutlineResponse;
        for (let i = 0; i < 30 && outline.page.hasMore; i++) outline = await history.read({ operation: 'outline', limit: 100,
            beforeAt: outline.page.beforeCursor!.at, beforeSeq: outline.page.beforeCursor!.seq, epoch: outline.page.epoch }) as MessageOutlineResponse;
        const restored = await history.read({ limit: 32 }) as MessagesResponse;
        expect(restored.page.epoch).toBe(latest.page.epoch);
        expect(restored.messages.at(-1)?.id).toBe(latest.messages.at(-1)?.id);
    });

    it('restores a persisted first-in-turn identity in a cold reader without scanning the thread', async () => {
        const source = new NativeHistoryFixture('/fixture', 800);
        source.threads.get('thread-a')!.items.forEach((entry, i) => {
            entry.turnId = `turn-${i}`;
            entry.item = { id: `item-${i}`, type: 'userMessage', content: [{ type: 'text', text: `Question ${i}` }] };
        });
        const warm = new NativeCodexHistory('thread-a', source);
        let page = await warm.read({ limit: 32 }) as MessagesResponse;
        for (let i = 0; i < 10; i++) page = await warm.read({ limit: 32, beforeAt: page.page.nextBeforeAt, beforeSeq: page.page.nextBeforeSeq, epoch: page.page.epoch }) as MessagesResponse;
        const anchor = page.messages[10];
        const count = source.calls.length;
        const context = await new NativeCodexHistory('thread-a', source).read({ operation: 'context', messageId: anchor.id, radius: 10 }) as MessageContextResponse;
        expect(context.messages.find(m => m.id === anchor.id)?.content).toEqual(anchor.content);
        expect(context.messages.map(m => (m.content as any).content.text)).toEqual(Array.from({ length: 21 }, (_, i) => `Question ${458 - 10 + i}`));
        expect(source.calls.length - count).toBeLessThanOrEqual(5);
    });

    it('restores the bounded native head after the outline or deep context evicts its bodies', async () => {
        const source = new NativeHistoryFixture('/fixture', 1400);
        source.threads.get('thread-a')!.items.forEach((entry, i) => {
            entry.item = { id: `item-${i}`, type: 'userMessage', content: [{ type: 'text', text: `Question ${i}` }] };
        });
        const history = new NativeCodexHistory('thread-a', source);
        const latest = await history.read({ limit: 32 }) as MessagesResponse;
        let cursor: { at: number; seq: number } | null = null; let epoch = latest.page.epoch;
        let firstId = ''; const seen = new Set<string>();
        for (let i = 0; i < 100; i++) {
            const outline = await history.read({ operation: 'outline', limit: 100, ...(cursor ? { beforeAt: cursor.at, beforeSeq: cursor.seq, epoch } : {}) }) as MessageOutlineResponse;
            for (const entry of outline.entries) seen.add(entry.messageId);
            firstId = outline.entries[0]?.messageId ?? firstId;
            expect(outline.page.headSeq).toBe(latest.page.snapshotHeadSeq);
            epoch = outline.page.epoch; cursor = outline.page.beforeCursor;
            if (!outline.page.hasMore) break;
        }
        expect(seen.size).toBe(1400);
        const count = source.calls.length;
        const restored = await history.read({ limit: 32 }) as MessagesResponse;
        expect(restored.messages.at(-1)?.id).toBe(latest.messages.at(-1)?.id);
        expect(source.calls.length - count).toBe(1);
        await history.read({ operation: 'context', messageId: firstId, radius: 8 });
        const again = await history.read({ limit: 32 }) as MessagesResponse;
        expect(again.messages.at(-1)?.id).toBe(latest.messages.at(-1)?.id);
    });

    it('refreshes a native snapshot in place and resets cursors on bridge reconstruction', async () => {
        const source = new NativeHistoryFixture('/fixture'); const history = new NativeCodexHistory('thread-a', source);
        const first = await history.read({ limit: 50 }) as MessagesResponse;
        const native = source.threads.get('thread-a')!.items.find(e => e.item.id === 'item-1197');
        native.item.text = 'UPDATED NATIVE SNAPSHOT'; history.invalidate(false);
        const second = await history.read({ limit: 50 }) as MessagesResponse;
        expect(second.messages.map(m => m.id)).toEqual(first.messages.map(m => m.id));
        expect(JSON.stringify(second.messages)).toContain('UPDATED NATIVE SNAPSHOT');
        expect(second.page.epoch).not.toBe(first.page.epoch);
        const reconcile = await history.read({ afterAt: first.page.nextAfterAt, afterSeq: first.page.nextAfterSeq, epoch: first.page.epoch }) as MessagesResponse;
        expect(reconcile.page.reset).toBe(true);
        expect(JSON.stringify(reconcile.messages)).toContain('UPDATED NATIVE SNAPSHOT');
        await new Promise(resolve => setTimeout(resolve, 2));
        const reconnect = await new NativeCodexHistory('thread-a', source).read({ limit: 50, beforeAt: first.page.nextBeforeAt, beforeSeq: first.page.nextBeforeSeq, epoch: first.page.epoch }) as MessagesResponse;
        expect(reconnect.page.reset).toBe(true);
    });
});
