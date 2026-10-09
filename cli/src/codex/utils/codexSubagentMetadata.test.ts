import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { codexSubagentMetadata } from './codexSubagentMetadata';
import { createCodexSessionScanner } from './codexSessionScanner';

const source = { subagent: { thread_spawn: {
    parent_thread_id: 'native-parent', agent_path: '/root/review', agent_nickname: 'Ada', agent_role: 'reviewer',
} } };
describe('Codex subagent lineage', () => {
    it('uses native spawn lineage and keeps the agent identity', () => {
        expect(codexSubagentMetadata({ source })).toEqual({
            codexParentThreadId: 'native-parent', codexAgentPath: '/root/review', codexAgentNickname: 'Ada', codexAgentRole: 'reviewer',
        });
    });
    it('accepts indexed source JSON and top-level metadata from native thread reads', () => {
        expect(codexSubagentMetadata({ source: JSON.stringify(source) }).codexParentThreadId).toBe('native-parent');
        expect(codexSubagentMetadata({ source: { subagent: 'review' }, parentThreadId: 'parent', agentNickname: 'Grace' }))
            .toMatchObject({ codexParentThreadId: 'parent', codexAgentNickname: 'Grace' });
        expect(codexSubagentMetadata({ thread_source: 'subagent', parent_thread_id: 'parent' }).codexParentThreadId).toBe('parent');
    });
    it('does not interpret ordinary forks, user threads or missing lineage as subagents', () => {
        for (const value of [null, {}, { forked_from_id: 'parent' }, { source: 'cli', parentThreadId: 'parent' }, { source: { subagent: 'compact' } }]) {
            expect(codexSubagentMetadata(value)).toEqual({});
        }
    });
    it('publishes primed transcript metadata without replaying historical messages', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-lineage-'));
        const observed: unknown[] = [], messages: unknown[] = [];
        const payload = { id: 'child', source };
        await writeFile(join(dir, 'child.jsonl'), JSON.stringify({ type: 'session_meta', payload }) + '\n'
            + JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'old' } }) + '\n');
        const scanner = await createCodexSessionScanner({ transcriptPath: join(dir, 'child.jsonl'),
            onSessionMetadata: metadata => observed.push(metadata), onEvent: event => messages.push(event) });
        try { expect(observed).toContainEqual(payload); expect(messages).toEqual([]); }
        finally { await scanner.cleanup(); await rm(dir, { recursive: true, force: true }); }
    });
});
