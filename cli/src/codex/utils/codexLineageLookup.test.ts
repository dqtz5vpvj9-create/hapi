import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lookupCodexSessionLineage } from './codexLineageLookup';
const cleanups: string[] = [];
afterEach(async () => { for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true }); });
describe('metadata-only Codex lineage lookup', () => {
    it('reads existing archived and active headers without parsing malformed message bodies or returning unrelated sessions', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-lineage-lookup-')); cleanups.push(home);
        const parent = '11111111-1111-1111-1111-111111111111';
        const child = '22222222-2222-2222-2222-222222222222';
        const other = '33333333-3333-3333-3333-333333333333';
        await mkdir(join(home, 'sessions')); await mkdir(join(home, 'archived_sessions'));
        for (const [id, directory, payload] of [
            [parent, 'sessions', { id: parent, cwd: '/project', source: 'cli', forked_from_id: 'fork-parent' }],
            [child, 'archived_sessions', { id: child, cwd: '/project', thread_source: 'subagent', parent_thread_id: parent, agent_nickname: 'Ada', agent_path: '/root/review' }],
            [other, 'sessions', { id: other, cwd: '/private', source: 'cli' }],
        ] as const) await writeFile(join(home, directory, `rollout-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload }) + '\nnot-json-private-body');
        const rows = lookupCodexSessionLineage([parent, child], home);
        expect(rows.map(({ codexSubagents: _children, ...lineage }) => lineage)).toEqual([
            { id: parent, cwd: '/project' },
            { id: child, cwd: '/project', codexParentThreadId: parent, codexAgentNickname: 'Ada', codexAgentRole: undefined, codexAgentPath: '/root/review' },
        ]);
        expect(rows.find(row => row.id === parent)?.codexSubagents).toMatchObject([{ threadId: child, parentThreadId: parent, status: 'archived' }]);
    });
});
