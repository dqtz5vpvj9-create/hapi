import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { searchLocalCodexSessions } from '../cli/src/modules/common/codexSessions'

describe('incremental Codex session search', () => {
    it('finds old names beyond 200, pages without gaps, and applies literal search and directory filters before pagination', () => {
        const home = mkdtempSync(join(tmpdir(), 'hapi-codex-search-'))
        const previous = process.env.CODEX_HOME
        process.env.CODEX_HOME = home
        const db = new Database(join(home, 'state_5.sqlite'))
        try {
            db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, cwd TEXT, source TEXT, archived INTEGER, rollout_path TEXT, updated_at INTEGER, preview TEXT, first_user_message TEXT, cli_version TEXT)')
            const file = join(home, 'rollout.jsonl')
            writeFileSync(file, '{}\n')
            const insert = db.query('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            for (let index = 0; index < 400; index++) {
                insert.run(`session-${String(index).padStart(3, '0')}`, index === 308 || index === 374 ? 'o-debug' : `Recent ${index}`,
                    'First prompt', index === 374 ? '/android' : '/project', 'cli', 0, file, 400 - index, '', '', 'test')
            }
            insert.run('literal', '100%_complete', '', '/project', 'cli', 0, file, 0, '', '', 'test')
            insert.run('archived', 'o-debug', '', '/project', 'cli', 1, file, 1000, '', '', 'test')
            insert.run('child', 'o-debug', '', '/project', JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'parent' } } }), 0, file, 1001, '', '', 'test')
            writeFileSync(join(home, 'session_index.jsonl'), JSON.stringify({ id: 'session-399', thread_name: 'Legacy named thread', updated_at: '2026-01-01' }) + '\n')
            const first = searchLocalCodexSessions({ limit: 50 })
            expect(first.nextCursor).not.toBeNull()
            expect(first.sessions.some(session => session.title === 'o-debug')).toBe(false)
            const matches = searchLocalCodexSessions({ search: 'O-DEBUG', limit: 1 })
            expect(matches.sessions.map(session => session.id)).toEqual(['session-308'])
            expect(matches.nextCursor).not.toBeNull()
            const next = searchLocalCodexSessions({ search: 'o-debug', limit: 1, cursor: matches.nextCursor! })
            expect(next.sessions.map(session => session.id)).toEqual(['session-374'])
            expect(next.nextCursor).toBeNull()
            expect(searchLocalCodexSessions({ search: 'o-debug', cwd: '/android' }).sessions.map(session => session.id)).toEqual(['session-374'])
            expect(searchLocalCodexSessions({ search: '%_' }).sessions.map(session => session.id)).toEqual(['literal'])
            expect(searchLocalCodexSessions({ search: 'legacy named' }).sessions.map(session => session.id)).toEqual(['session-399'])
            const ids: string[] = []
            let cursor: number | undefined
            do {
                const page = searchLocalCodexSessions({ limit: 50, cursor })
                ids.push(...page.sessions.map(session => session.id))
                cursor = page.nextCursor ?? undefined
            } while (cursor !== undefined)
            expect(ids.length).toBe(401)
            expect(new Set(ids).size).toBe(401)
        } finally {
            db.close()
            if (previous === undefined) delete process.env.CODEX_HOME
            else process.env.CODEX_HOME = previous
            rmSync(home, { recursive: true })
        }
    })
})
