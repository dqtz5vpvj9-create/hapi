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

    it('retains DSH child catalogs through runtime validation and list projection', () => {
        const metadata = MetadataSchema.parse({ path: '/project', host: 'host', flavor: 'dsh', dshSessionId: 'root',
            dshSubagents: [
                { sessionId: 'session-ada', name: 'Ada', label: 'review', mode: 'continuable', activity: 'running',
                    teamStatus: 'running', provider: 'spawn', createdAt: 10, settledMs: 1200, openSince: 5000, lastTurnCompleted: false },
                { sessionId: 'session-ops', label: 'one shot', mode: 'one-shot', activity: 'inactive', createdAt: 20 },
                { sessionId: 'session-codex', mode: 'external', activity: 'inactive', createdAt: 30 },
            ] });
        expect(toSessionSummaryMetadata(metadata)?.dshSubagents).toEqual([
            { sessionId: 'session-ada', name: 'Ada', label: 'review', mode: 'continuable', activity: 'running',
                teamStatus: 'running', provider: 'spawn', createdAt: 10, settledMs: 1200, openSince: 5000, lastTurnCompleted: false },
            { sessionId: 'session-ops', label: 'one shot', mode: 'one-shot', activity: 'inactive', createdAt: 20 },
            { sessionId: 'session-codex', mode: 'external', activity: 'inactive', createdAt: 30 },
        ]);
    });
    it('rejects unknown DSH child modes and negative timing', () => {
        const base = { path: '/project', host: 'host' };
        expect(MetadataSchema.safeParse({ ...base, dshSubagents: [{ sessionId: 's', mode: 'teammate', activity: 'running', createdAt: 1 }] }).success).toBe(false);
        expect(MetadataSchema.safeParse({ ...base, dshSubagents: [{ sessionId: 's', mode: 'continuable', activity: 'running', createdAt: 1, settledMs: -1 }] }).success).toBe(false);
    });
});
