import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLocalCodexSessionSearch, getLocalCodexSessionSummary } from '../../cli/src/modules/common/codexSessions'

const originalHome = process.env.CODEX_HOME
const fixtures: string[] = []
afterEach(() => {
    if (originalHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = originalHome
    for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test('request-scoped index paging preserves full search, cursors, and fresh titles on the next request', () => {
    const home = mkdtempSync('/mnt/cache/data-cache/hapi-catalog-test-')
    fixtures.push(home)
    process.env.CODEX_HOME = home
    const sessions = join(home, 'sessions')
    mkdirSync(sessions)
    const db = new Database(join(home, 'state_5.sqlite'))
    db.run(`CREATE TABLE threads (
        id TEXT PRIMARY KEY, rollout_path TEXT, updated_at INTEGER, cwd TEXT,
        title TEXT, source TEXT, cli_version TEXT, first_user_message TEXT,
        archived INTEGER, name TEXT, preview TEXT, originator TEXT, thread_source TEXT
    )`)
    const insert = db.query('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    for (let i = 0; i < 300; i++) {
        const file = join(sessions, `${i}.jsonl`)
        writeFileSync(file, '{}\n')
        insert.run(String(i), file, 1000 - i, home, i === 299 ? 'old needle [%]' : `session ${i}`, 'cli', '1', '', 0, null, '', null, null)
    }
    db.close()
    const index = join(home, 'session_index.jsonl')
    const name = (title: string) => JSON.stringify({ id: '0', thread_name: title, updated_at: '2026-10-08T00:00:00Z' }) + '\n'
    writeFileSync(index, name('before'))
    const request = createLocalCodexSessionSearch()
    try {
        let cursor: number | null = 0
        const ids: string[] = []
        while (cursor !== null) {
            const page = request.search({ cursor, limit: 17 })
            ids.push(...page.sessions.map(row => row.id))
            cursor = page.nextCursor
        }
        expect(ids).toEqual(Array.from({ length: 300 }, (_, i) => String(i)))
        expect(request.search({ search: 'needle [%]', limit: 50 }).sessions.map(row => row.id)).toEqual(['299'])
        writeFileSync(index, name('after'))
        expect(request.search({ limit: 1 }).sessions[0].title).toBe('before')
    } finally { request.close() }
    const next = createLocalCodexSessionSearch()
    try { expect(next.search({ limit: 1 }).sessions[0].title).toBe('after') }
    finally { next.close() }
    expect(getLocalCodexSessionSummary('299')?.id).toBe('299')
    expect(getLocalCodexSessionSummary('does-not-exist')).toBeUndefined()
    const changed = new Database(join(home, 'state_5.sqlite'))
    changed.run('UPDATE threads SET archived = 1 WHERE id = ?', '299')
    expect(getLocalCodexSessionSummary('299')).toBeUndefined()
    changed.close()
})
