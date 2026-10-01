import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readCodexSubagentMessages } from '../cli/src/codex/utils/codexSubagentHistory'

describe('bounded native subagent transcript reader', () => {
    let home: string
    let database: Database
    const threadId = randomUUID()
    beforeEach(() => {
        home = mkdtempSync('/mnt/cache/data-cache/hapi-runtime/subagent-reader-')
        mkdirSync(join(home, 'sessions'))
        database = new Database(join(home, 'state_5.sqlite'))
        database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)')
    })
    afterEach(() => { database.close(); rmSync(home, { recursive: true, force: true }) })
    function rollout(lines: unknown[]) {
        const file = join(home, 'sessions', `rollout-${threadId}.jsonl`)
        writeFileSync(file, lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n')
        database.query('INSERT INTO threads VALUES (?, ?)').run(threadId, file)
        return file
    }
    const message = (text: string, role = 'assistant') => ({ timestamp: '2026-10-01T00:00:00Z', type: 'response_item', payload: { type: 'message', role, content: [{ type: 'output_text', text }] } })
    test('pages backwards without duplicating the exclusive boundary', () => {
        rollout([message('first', 'user'), message('second'), message('third'), message('fourth')])
        const latest = readCodexSubagentMessages(threadId, 2, undefined, home)
        expect(latest.messages.map(item => item.text)).toEqual(['third', 'fourth'])
        const older = readCodexSubagentMessages(threadId, 2, latest.before!, home)
        expect(older.messages.map(item => item.text)).toEqual(['first', 'second'])
        expect(older.before).toBeNull(); expect(older.hasMore).toBe(false)
    })
    test('preserves role and tool output, and ignores malformed/incomplete records', () => {
        rollout([message('request', 'user'), 'not-json', { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'printf hello' } },
            { type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'hello' } }, message('reply'), '{"unfinished"'])
        const page = readCodexSubagentMessages(threadId, 20, undefined, home)
        expect(page.messages.map(item => item.role)).toEqual(['user', 'tool', 'tool', 'assistant'])
        expect(page.messages[2]?.text).toBe('hello')
    })
    test('retains byte-exact cursors when a bounded tail starts inside UTF-8', () => {
        rollout([message('😀'.repeat(600000)), message('早期'), message('最新')])
        const latest = readCodexSubagentMessages(threadId, 1, undefined, home)
        expect(latest.messages[0]?.text).toBe('最新')
        const older = readCodexSubagentMessages(threadId, 1, latest.before!, home)
        expect(older.messages[0]?.text).toBe('早期')
        expect(new Set([...latest.messages, ...older.messages].map(item => item.id)).size).toBe(2)
    })
    test('rejects unknown threads and transcripts escaping the native store through symlinks', () => {
        expect(() => readCodexSubagentMessages(randomUUID(), 10, undefined, home)).toThrow('unavailable')
        const secret = join(home, 'outside.jsonl'); writeFileSync(secret, JSON.stringify(message('private')) + '\n')
        const link = join(home, 'sessions', 'escape.jsonl'); symlinkSync(secret, link)
        database.query('INSERT INTO threads VALUES (?, ?)').run(threadId, link)
        expect(() => readCodexSubagentMessages(threadId, 10, undefined, home)).toThrow('outside')
    })
})
