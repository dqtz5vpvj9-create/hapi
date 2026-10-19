import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readCodexSubagentMessages } from '../cli/src/codex/utils/codexSubagentHistory'

describe('bounded native subagent transcript reader', () => {
    let home: string
    let database: Database
    const threadId = randomUUID()
    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'subagent-reader-'))
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
    test('preserves structured tool identities, inputs, outputs and readable reasoning', () => {
        rollout([
            { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Check the failing boundary.' }], encrypted_content: 'private-ciphertext' } },
            { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'native-command', arguments: JSON.stringify({ cmd: 'bun test', workdir: '/project' }) } },
            { type: 'response_item', payload: { type: 'function_call_output', call_id: 'native-command', output: { stdout: 'test failed', exit_code: 1, is_error: true } } },
            { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'never-render-this' } },
        ])
        const page = readCodexSubagentMessages(threadId, 10, undefined, home)
        expect(page.messages).toHaveLength(3)
        expect(page.messages[0]).toMatchObject({ kind: 'reasoning', text: 'Check the failing boundary.' })
        expect(page.messages[1]).toMatchObject({ kind: 'tool-call', callId: 'native-command', toolName: 'exec_command', input: { cmd: 'bun test', workdir: '/project' } })
        expect(page.messages[2]).toMatchObject({ kind: 'tool-result', callId: 'native-command', output: { stdout: 'test failed', exit_code: 1 }, isError: true })
        expect(JSON.stringify(page)).not.toContain('ciphertext')
        expect(JSON.stringify(page)).not.toContain('never-render-this')
    })
    test('reads committed appends once and waits for an incomplete UTF-8 line', () => {
        const file = rollout([message('original')])
        const initial = readCodexSubagentMessages(threadId, 2, undefined, home)
        const partial = Buffer.from(JSON.stringify(message('新增😀记录')) + '\n')
        const split = partial.indexOf(Buffer.from('😀')) + 2
        appendFileSync(file, partial.subarray(0, split))
        const waiting = readCodexSubagentMessages(threadId, 2, undefined, home, { after: initial.after, epoch: initial.epoch })
        expect(waiting.messages).toEqual([])
        expect(waiting.after).toBe(initial.after)
        expect(waiting.hasLater).toBe(false)
        appendFileSync(file, partial.subarray(split))
        appendFileSync(file, JSON.stringify(message('final')) + '\n')
        const first = readCodexSubagentMessages(threadId, 1, undefined, home, { after: waiting.after, epoch: waiting.epoch })
        expect(first.messages.map(row => row.text)).toEqual(['新增😀记录'])
        expect(first.hasLater).toBe(true)
        const second = readCodexSubagentMessages(threadId, 1, undefined, home, { after: first.after, epoch: first.epoch })
        expect(second.messages.map(row => row.text)).toEqual(['final'])
        expect(second.hasLater).toBe(false)
        const empty = readCodexSubagentMessages(threadId, 1, undefined, home, { after: second.after, epoch: second.epoch })
        expect(empty.messages).toEqual([])
        expect(empty.after).toBe(second.after)
    })
    test('does not mix a rewritten native transcript with a previous cursor', () => {
        const file = rollout([message('old task'), message('old result')])
        const before = readCodexSubagentMessages(threadId, 10, undefined, home)
        writeFileSync(file, JSON.stringify(message('new task')) + '\n')
        const current = readCodexSubagentMessages(threadId, 10, undefined, home, { after: before.after, epoch: before.epoch })
        expect(current.reset).toBe(true)
        expect(current.epoch).not.toBe(before.epoch)
        expect(current.messages.map(row => row.text)).toEqual(['new task'])
    })
    test('marks oversized structured fields and advances past an oversized committed line within bounded reads', () => {
        const file = rollout([message('start')])
        const initial = readCodexSubagentMessages(threadId, 10, undefined, home)
        appendFileSync(file, JSON.stringify(message('x'.repeat(3 * 1024 * 1024))) + '\n')
        appendFileSync(file, JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'large', output: { content: 'y'.repeat(100_000) } } }) + '\n')
        let page = readCodexSubagentMessages(threadId, 10, undefined, home, { after: initial.after, epoch: initial.epoch })
        expect(page.truncated).toBe(true)
        expect(page.hasLater).toBe(true)
        expect(page.messages).toEqual([])
        page = readCodexSubagentMessages(threadId, 10, undefined, home, { after: page.after, epoch: page.epoch })
        expect(page.messages).toHaveLength(1)
        expect(page.messages[0]).toMatchObject({ kind: 'tool-result', truncated: true })
        expect(JSON.stringify(page).length).toBeLessThan(140_000)
        expect(page.hasLater).toBe(false)
    })
})
