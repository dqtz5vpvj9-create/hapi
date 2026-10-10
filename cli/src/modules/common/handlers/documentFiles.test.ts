import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readDocumentFile, writeDocumentFile, documentLockPath } from './documentFiles'

describe('document file revisions', () => {
    let root: string
    beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'hapi-document-test-')) })
    afterEach(async () => { await rm(root, { recursive: true, force: true }) })
    it('writes relative paths in the session root and preserves UTF-8/BOM/CRLF bytes', async () => {
        await writeFile(join(root, 'notes.md'), '\ufeff# 标题\r\n内容\r\n')
        const before = await readDocumentFile('notes.md', root)
        const content = Buffer.from('\ufeff# 新标题\r\n新内容\r\n')
        const result = await writeDocumentFile({ path: 'notes.md', content: content.toString('base64'), expectedHash: before.hash }, root)
        expect(result.success).toBe(true)
        expect(await readFile(join(root, 'notes.md'))).toEqual(content)
        expect((await readDocumentFile('notes.md', root)).hash).toBe(result.hash)
    })
    it('rejects an agent edit made after the browser read', async () => {
        await writeFile(join(root, 'notes.txt'), 'original')
        const before = await readDocumentFile('notes.txt', root)
        await writeFile(join(root, 'notes.txt'), 'agent edit')
        const result = await writeDocumentFile({ path: 'notes.txt', content: Buffer.from('browser edit').toString('base64'), expectedHash: before.hash }, root)
        expect(result).toMatchObject({ success: false, code: 'conflict' })
        expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('agent edit')
    })
    it.skipIf(process.platform === 'win32')('retains the original POSIX permission mode across replacement', async () => {
        const path = join(root, 'shared.txt')
        await writeFile(path, 'base')
        await chmod(path, 0o666)
        const { hash } = await readDocumentFile(path, root)
        expect((await writeDocumentFile({ path, expectedHash: hash, content: Buffer.from('updated').toString('base64') }, root)).success).toBe(true)
        expect((await stat(path)).mode & 0o777).toBe(0o666)
        await chmod(path, 0o444)
        const readonly = await readDocumentFile(path, root)
        if (process.getuid?.() !== 0) {
            expect((await writeDocumentFile({ path, expectedHash: readonly.hash, content: Buffer.from('denied').toString('base64') }, root)).code).toBe('denied')
            expect(await readFile(path, 'utf8')).toBe('updated')
        }
    })
    it('serializes HAPI writes across handler registrations and permits only one identical-base writer', async () => {
        await writeFile(join(root, 'notes.txt'), 'base')
        const { hash } = await readDocumentFile('notes.txt', root)
        const contents = ['first', 'second']
        const responses = await Promise.all(contents.map(content => writeDocumentFile({ path: 'notes.txt', expectedHash: hash, content: Buffer.from(content).toString('base64') }, root)))
        // Path resolution is asynchronous; either request can reach the lock first.
        expect(responses.filter(response => response.success)).toHaveLength(1)
        expect(responses.find(response => !response.success)).toMatchObject({ success: false, code: 'conflict' })
        const winner = responses.findIndex(response => response.success)
        expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe(contents[winner])
    })
    it('does not follow an in-root symlink outside the authorized session', async () => {
        await symlink(join(root, '..'), join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
        await expect(writeDocumentFile({ path: 'escape/notes.txt', content: '', expectedHash: null }, root)).rejects.toThrow()
    })
    it('refuses an overlapping save owned by another CLI process, then permits saving after release', async () => {
        const path = join(root, 'shared.txt')
        await writeFile(path, 'base')
        const { hash } = await readDocumentFile(path, root)
        const source = `import { lock } from 'proper-lockfile'; import { once } from 'node:events';
            const release = await lock(${JSON.stringify(path)}, { realpath: false, lockfilePath: ${JSON.stringify(documentLockPath(path))} });
            console.log('locked'); await once(process.stdin, 'data'); await release(); process.exit(0);`
        const child = spawn('bun', ['-e', source], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] })
        const exited = once(child, 'exit')
        const ready = await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw new Error('Lock owner exited before acquiring the lock') })])
        expect(String(ready[0])).toContain('locked')
        const request = { path, expectedHash: hash, content: Buffer.from('saved').toString('base64') }
        try {
            expect(await writeDocumentFile(request, root)).toMatchObject({ success: false, code: 'conflict' })
            expect(await readFile(path, 'utf8')).toBe('base')
        } finally { child.stdin.end('release\n'); await exited }
        expect((await writeDocumentFile(request, root)).success).toBe(true)
    })
})
