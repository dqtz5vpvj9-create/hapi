import { describe, expect, it } from 'vitest'
import { capPatchFiles, codexFileChanges, parseUnifiedPatch, patchHunkRows } from './patchPresentation'

const diff = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -40,2 +40,2 @@ function first\n context\n-old\n+new\n@@ -90 +92 @@ function second\n-before\n+after\n\\ No newline at end of file\n'

describe('native Codex file-change presentation', () => {
    it('retains every file, separated hunk, source offset and no-newline marker', () => {
        const files = parseUnifiedPatch(diff + '--- a/docs/a.ts\n+++ b/docs/a.ts\n@@ -8 +12 @@\n-doc old\n+doc new\n')!
        expect(files.map(file => file.newPath)).toEqual(['b/src/a.ts', 'b/docs/a.ts'])
        expect(files[0].hunks.map(hunk => hunk.header)).toEqual(['@@ -40,2 +40,2 @@ function first', '@@ -90 +92 @@ function second'])
        expect(patchHunkRows(files[0].hunks[0])).toEqual([
            { kind: 'context', old: 40, new: 40, text: 'context' },
            { kind: 'del', old: 41, text: 'old' },
            { kind: 'add', new: 41, text: 'new' }
        ])
        expect(patchHunkRows(files[0].hunks[1])).toEqual([
            { kind: 'del', old: 90, text: 'before' },
            { kind: 'add', new: 92, text: 'after' },
            { kind: 'note', text: '\\ No newline at end of file' }
        ])
        expect(patchHunkRows(files[1].hunks[0])[1]).toMatchObject({ new: 12 })
    })

    it('treats official add/delete diff as literal content, not as a unified diff', () => {
        const content = '@@ -100 +200 @@\n+literal\n'
        const changes = codexFileChanges({ changes: [
            { path: '/src/created', kind: { type: 'add' }, diff: content },
            { path: '/src/deleted', kind: { type: 'delete' }, diff: content }
        ] })!
        expect(patchHunkRows(changes[0].files![0].hunks[0])).toEqual([
            { kind: 'add', new: 1, text: '@@ -100 +200 @@' }, { kind: 'add', new: 2, text: '+literal' }
        ])
        expect(patchHunkRows(changes[1].files![0].hunks[0])[0]).toMatchObject({ kind: 'del', old: 1, text: '@@ -100 +200 @@' })
    })

    it('understands legacy FileChange and only strips the official exact move annotation', () => {
        const moves = `${diff}\n\nMoved to: /new/a.ts`
        const v2 = codexFileChanges({ changes: { '/old/a.ts': { kind: { type: 'update', move_path: '/new/a.ts' }, diff: moves } } })![0]
        expect(v2).toMatchObject({ movePath: '/new/a.ts', raw: moves })
        expect(v2.files![0].hunks).toHaveLength(2)
        expect(codexFileChanges({ changes: { a: { type: 'update', unified_diff: diff, move_path: null } } })![0].files).toEqual(parseUnifiedPatch(diff))
        expect(codexFileChanges({ changes: { a: { kind: { type: 'update', move_path: '/elsewhere' }, diff: moves } } })![0].files).toBeNull()
    })

    it('uses authoritative completed changes, including an empty snapshot', () => {
        const input = { changes: { proposed: { type: 'add', content: 'proposed' } } }
        expect(codexFileChanges(input, { changes: { final: { type: 'add', content: 'final' } } })?.map(change => change.path)).toEqual(['final'])
        expect(codexFileChanges(input, { changes: {} })).toEqual([])
        expect(codexFileChanges(input, { changes: [] })).toEqual([])
    })

    it('keeps malformed, unknown and oversized changes available verbatim', () => {
        for (const raw of ['@@ broken\n+oops', '@@ -4,7 +8 @@\n-old\n+new', 'binary metadata', 'x'.repeat(2_000_001)]) {
            const change = codexFileChanges({ changes: { a: { kind: { type: 'update' }, diff: raw } } })![0]
            expect(change.files).toBeNull()
            expect(change.raw).toBe(raw)
        }
        const unknown = { kind: { type: 'future' }, diff: diff, extra: ['keep me'] }
        const change = codexFileChanges({ changes: { a: unknown } })![0]
        expect(change.kind).toBe('unknown')
        expect(JSON.parse(change.raw)).toEqual(unknown)
    })

    it('caps drawn rows without mutating hunks, ranges or the original patch', () => {
        const files = parseUnifiedPatch(diff)!
        const shown = capPatchFiles(files, 4)
        expect(shown.truncated).toBe(true)
        expect(shown.files[0].hunks.map(hunk => hunk.lines.length)).toEqual([3, 1])
        expect(shown.files[0].hunks[1]).toMatchObject({ oldStart: 90, newStart: 92, oldLines: 1, newLines: 1 })
        expect(files[0].hunks[1].lines).toHaveLength(3)
        expect(capPatchFiles(files, 6).truncated).toBe(false)
    })
})
