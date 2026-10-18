import { describe, expect, it } from 'vitest';
import { codexSubagentMetadata } from './codexSubagentMetadata';

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
});
