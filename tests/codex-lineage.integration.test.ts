import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lookupCodexSessionLineage } from '../cli/src/codex/utils/codexLineageLookup';

describe('Codex lineage native metadata integration', () => {
    it('reads real SQLite spawn metadata and legacy header parents while preserving indexed identity and retrying unresolved subagents', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-lineage-index-'));
        const db = new Database(join(home, 'state_1.sqlite'));
        try {
            db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, source TEXT, rollout_path TEXT, thread_source TEXT, agent_nickname TEXT, agent_role TEXT, agent_path TEXT)');
            const add = db.query('INSERT INTO threads (id, cwd, source, rollout_path, thread_source, agent_nickname, agent_role, agent_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
            db.exec('ALTER TABLE threads ADD COLUMN archived INTEGER; ALTER TABLE threads ADD COLUMN updated_at INTEGER');
            add.run('parent', '/project', 'cli', join(home, 'parent.jsonl'), 'user', null, null, null);
            add.run('child', '/project', JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'parent' } } }), join(home, 'child.jsonl'), 'subagent', 'Ada', 'reviewer', '/root/review');
            const file = join(home, 'fallback.jsonl');
            await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: 'fallback', source: 'cli', thread_source: 'subagent', parent_thread_id: 'parent', cwd: '/project' } }) + '\nmalformed-private-body');
            add.run('fallback', '/project', 'cli', file, 'subagent', 'Grace', 'tester', '/root/check');
            add.run('unresolved', '/project', 'subagent', join(home, 'missing.jsonl'), 'subagent', 'Pending', null, null);
            add.run('nested', '/project', JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'child' } } }), join(home, 'nested.jsonl'), 'subagent', 'Nested', 'tester', '/root/nested');
            db.exec("UPDATE threads SET archived = 1, updated_at = 123 WHERE id = 'child'");
            const rows = lookupCodexSessionLineage(['child', 'parent', 'fallback', 'unresolved'], home);
            expect(rows).toHaveLength(3);
            expect(rows.find(row => row.id === 'child')).toMatchObject({ id: 'child', cwd: '/project', codexParentThreadId: 'parent', codexAgentNickname: 'Ada', codexAgentRole: 'reviewer', codexAgentPath: '/root/review' });
            expect(rows.find(row => row.id === 'fallback')).toMatchObject({ id: 'fallback', cwd: '/project', codexParentThreadId: 'parent', codexAgentNickname: 'Grace', codexAgentRole: 'tester', codexAgentPath: '/root/check' });
            expect(rows.find(row => row.id === 'parent')?.codexParentThreadId).toBeUndefined();
            const children = rows.find(row => row.id === 'parent')!.codexSubagents!;
            expect(children.map(child => child.threadId)).toEqual(['child', 'fallback', 'nested']);
            expect(children.find(child => child.threadId === 'nested')?.parentThreadId).toBe('child');
            expect(children.find(child => child.threadId === 'child')).toMatchObject({ status: 'archived', updatedAt: 123000 });
        } finally { db.close(); await rm(home, { recursive: true, force: true }); }
    });
});
