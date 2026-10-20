import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireCodexWriterLock } from './codexWriterLock'

test('the native writer lock is exclusive and reusable after release', () => {
    const home = mkdtempSync(join(tmpdir(), 'hapi-writer-lock-'))
    try {
        const first = acquireCodexWriterLock(home, 'thread-a')
        expect(() => acquireCodexWriterLock(home, 'thread-a')).toThrow('active Codex writer')
        first.release()
        const second = acquireCodexWriterLock(home, 'thread-a')
        second.release()
    } finally {
        rmSync(home, { recursive: true, force: true })
    }
})
