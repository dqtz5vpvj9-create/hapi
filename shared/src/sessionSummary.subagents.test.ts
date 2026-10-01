import { describe, expect, it } from 'bun:test';
import { MetadataSchema } from './schemas';
import { toSessionSummaryMetadata } from './sessionSummary';
describe('subagent metadata transport', () => {
    it('retains lineage and identity through runtime validation and list projection', () => {
        const metadata = MetadataSchema.parse({ path: '/project', host: 'host', flavor: 'codex', codexSessionId: 'child',
            codexParentThreadId: 'parent', codexAgentNickname: 'Ada', codexAgentRole: 'reviewer', codexAgentPath: '/root/review',
            codexSubagents: [{ threadId: 'nested', parentThreadId: 'child', nickname: 'Grace', status: 'unknown' }] });
        expect(toSessionSummaryMetadata(metadata)).toMatchObject({ agentSessionId: 'child',
            codexParentThreadId: 'parent', codexAgentNickname: 'Ada', codexAgentRole: 'reviewer', codexAgentPath: '/root/review',
            codexSubagents: [{ threadId: 'nested', parentThreadId: 'child', nickname: 'Grace', status: 'unknown' }] });
    });
});
