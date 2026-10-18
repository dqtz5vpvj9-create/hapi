import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { FileManagementRequest, FileManagementResponse } from '@hapi/protocol/fileManagement'
import type { ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { useFileManagement, type FileManagementOptions } from './useFileManagement'
import type { FileManagerMutation, FileManagerTarget } from './file-manager-types'

const revision = 'a'.repeat(64)
const source: FileManagerTarget = { path: 'src/readme.md', name: 'readme.md', kind: 'file' }
function entry(path: string, type: 'file' | 'directory' | 'symlink' = 'file'): FileManagementResponse {
    return { success: true, entry: { path: `/project/${path}`, name: path.split('/').at(-1)!, type, size: 12, modified: 100, revision, entryCount: type === 'directory' ? 4 : 1 } }
}
function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
}
function setup(overrides: Partial<FileManagementOptions> = {}) {
    const api = {
        inspectSessionPath: vi.fn(async (_id: string, path: string) => entry(path)),
        manageSessionFiles: vi.fn(async (_id: string, _request: FileManagementRequest) => ({ success: true } as FileManagementResponse)),
        uploadSessionFile: vi.fn(async (_id: string, _request: { path: string; content: string }) => ({ success: true } as FileManagementResponse)),
        downloadSessionFile: vi.fn(async () => new Blob(['bytes'])),
    }
    const callbacks = { beforeFileMutation: vi.fn(async () => true), onFileMutation: vi.fn(async (_mutation: FileManagerMutation) => undefined), onFileMutationSettled: vi.fn(), onOpenFile: vi.fn(), onRevealDirectory: vi.fn() }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const options: FileManagementOptions = { api: api as unknown as ApiClient, sessionId: 'session-a', ...callbacks, ...overrides }
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}><I18nProvider>{children}</I18nProvider></QueryClientProvider>
    return { ...renderHook((props: FileManagementOptions) => useFileManagement(props), { initialProps: options, wrapper }), api, callbacks, options, invalidate }
}
afterEach(cleanup)

describe('file management snapshot and document ownership', () => {
    it.each([
        { root: '/project/src', deleted: ['/project/src/a\\b.txt', '/project/src\\outside.txt'], expected: ['src/a\\b.txt'] },
        { root: 'C:\\Project\\src', deleted: ['c:\\project\\SRC\\a\\b.txt', 'C:\\Project\\src-other\\wrong.txt'], expected: ['src/a/b.txt'] }
    ])('uses the remote path dialect for partial delete receipts: $root', async ({ root, deleted, expected }) => {
        const view = setup()
        view.api.inspectSessionPath.mockResolvedValue({ ...entry('src', 'directory'), entry: { ...entry('src', 'directory').entry!, path: root } })
        view.api.manageSessionFiles.mockResolvedValue({ success: false, error: 'Partial deletion', deletedPaths: deleted })
        await act(() => view.result.current.arm('delete', [{ path: 'src', name: 'src', kind: 'directory' }]))
        await act(() => view.result.current.submit(''))
        expect(view.callbacks.onFileMutation.mock.calls.map(([mutation]) => mutation.paths[0])).toEqual(expected)
    })

    it('reconciles verified partial deletions before reporting a later conflict and releasing guards', async () => {
        const view = setup()
        view.api.inspectSessionPath.mockImplementation(async (_id, path) => entry(path, 'directory'))
        view.api.manageSessionFiles.mockResolvedValue({ success: false, code: 'conflict', error: 'A remaining file changed.', deletedPaths: ['/project/src/removed.txt', '/project/src/removed-dir', '/project/src/removed-dir/child', '/project/sibling/untouched'] })
        await act(() => view.result.current.arm('delete', [{ path: 'src', name: 'src', kind: 'directory' }]))
        await act(() => view.result.current.submit(''))
        expect(view.callbacks.onFileMutation.mock.calls.map(([mutation]) => mutation)).toEqual([
            expect.objectContaining({ operation: 'delete', paths: ['src/removed-dir'] }),
            expect.objectContaining({ operation: 'delete', paths: ['src/removed.txt'] })
        ])
        expect(view.callbacks.onFileMutationSettled).toHaveBeenCalledTimes(1)
        expect(view.callbacks.onFileMutationSettled.mock.invocationCallOrder[0]).toBeGreaterThan(view.callbacks.onFileMutation.mock.invocationCallOrder.at(-1)!)
        expect(view.invalidate).toHaveBeenCalled()
        expect(view.result.current.error).toContain('A remaining file changed.')
        expect(view.result.current.dialog).toBeNull()
    })

    it('retargets a committed move exactly once even if its metadata refresh failed', async () => {
        const view = setup()
        view.api.manageSessionFiles.mockResolvedValue({ success: false, error: 'Refresh failed.', commit: { action: 'move', path: '/project/src/readme.md', destination: '/project/docs/readme.md' } })
        await act(() => view.result.current.arm('move', [source]))
        await act(() => view.result.current.submit('docs/readme.md'))
        expect(view.callbacks.onFileMutation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation: 'move', paths: [source.path], destination: 'docs/readme.md' }))
        expect(view.callbacks.onFileMutationSettled).toHaveBeenCalledTimes(1)
        expect(view.result.current.error).toContain('Refresh failed.')
    })

    it('does not double-notify when successful deletion includes its commit receipt', async () => {
        const view = setup()
        view.api.manageSessionFiles.mockResolvedValue({ success: true, deletedPaths: ['/project/src/readme.md'] })
        await act(() => view.result.current.arm('delete', [source]))
        await act(() => view.result.current.submit(''))
        expect(view.callbacks.onFileMutation).toHaveBeenCalledTimes(1)
    })

    it('inspects before confirmation and holds a document guard through server success and reconciliation', async () => {
        const trace: string[] = []
        const completion = deferred<void>()
        const beforeFileMutation = vi.fn(async () => { trace.push('guard'); return true })
        const onFileMutation = vi.fn(async () => { trace.push('reconcile'); await completion.promise })
        const onFileMutationSettled = vi.fn(() => { trace.push('settled') })
        const view = setup({ beforeFileMutation, onFileMutation, onFileMutationSettled })
        view.api.manageSessionFiles.mockImplementation(async () => { trace.push('request'); return { success: true } })
        await act(() => view.result.current.arm('rename', [source]))
        expect(view.api.manageSessionFiles).not.toHaveBeenCalled()
        expect(view.result.current.dialog?.sources[0].entry.path).toBe('/project/src/readme.md')
        let submitting!: Promise<void>
        await act(async () => { submitting = view.result.current.submit('renamed.md') })
        expect(view.api.manageSessionFiles).toHaveBeenCalledWith('session-a', { action: 'rename', path: source.path, destination: 'src/renamed.md', expectedRevision: revision })
        expect(trace).toEqual(['guard', 'request', 'reconcile'])
        expect(onFileMutationSettled).not.toHaveBeenCalled()
        await act(async () => { completion.resolve(); await submitting })
        expect(trace).toEqual(['guard', 'request', 'reconcile', 'settled'])
        expect(onFileMutation).toHaveBeenCalledWith({ sessionId: 'session-a', pathScope: 'relative', operation: 'rename', paths: [source.path], destination: 'src/renamed.md', kind: 'file' })
        expect(view.result.current.dialog).toBeNull()
    })

    it('releases a guard on conflict without retargeting the document or retrying stale revisions', async () => {
        const view = setup()
        view.api.manageSessionFiles.mockResolvedValue({ success: false, code: 'conflict', error: 'Source changed.' })
        await act(() => view.result.current.arm('delete', [source]))
        await act(() => view.result.current.submit(''))
        expect(view.api.manageSessionFiles).toHaveBeenCalledTimes(1)
        expect(view.callbacks.onFileMutation).not.toHaveBeenCalled()
        expect(view.callbacks.onFileMutationSettled).toHaveBeenCalledTimes(1)
        expect(view.result.current.error).toBe('Source changed.')
        expect(view.result.current.dialog?.sources[0].entry.revision).toBe(revision)
    })

    it('cancels before touching the filesystem when an unsaved-document guard declines', async () => {
        const view = setup({ beforeFileMutation: vi.fn(async () => false) })
        await act(() => view.result.current.arm('move', [source]))
        await act(() => view.result.current.submit('docs/readme.md'))
        expect(view.api.manageSessionFiles).not.toHaveBeenCalled()
        expect(view.callbacks.onFileMutation).not.toHaveBeenCalled()
        expect(view.callbacks.onFileMutationSettled).not.toHaveBeenCalled()
    })

    it('ignores a stale inspection after switching sessions', async () => {
        const response = deferred<FileManagementResponse>()
        const view = setup()
        view.api.inspectSessionPath.mockReturnValue(response.promise)
        let inspecting!: Promise<void>
        act(() => { inspecting = view.result.current.arm('delete', [source]) })
        view.rerender({ ...view.options, sessionId: 'session-b' })
        await act(async () => { response.resolve(entry(source.path)); await inspecting })
        expect(view.result.current.dialog).toBeNull()
        expect(view.api.manageSessionFiles).not.toHaveBeenCalled()
    })

    it('settles an admitted mutation against its original session after a switch', async () => {
        const response = deferred<FileManagementResponse>()
        const view = setup()
        view.api.manageSessionFiles.mockReturnValue(response.promise)
        await act(() => view.result.current.arm('rename', [source]))
        let submitting!: Promise<void>
        await act(async () => { submitting = view.result.current.submit('renamed.md') })
        await waitFor(() => expect(view.api.manageSessionFiles).toHaveBeenCalledTimes(1))
        view.rerender({ ...view.options, sessionId: 'session-b' })
        await act(async () => { response.resolve({ success: true }); await submitting })
        expect(view.callbacks.onFileMutation).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-a' }))
        expect(view.callbacks.onFileMutationSettled).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-a' }))
        expect(view.callbacks.onRevealDirectory).not.toHaveBeenCalled()
        expect(view.result.current.dialog).toBeNull()
    })

    it('reduces selected descendants and reports only the successful part of a failed batch', async () => {
        const view = setup()
        view.api.inspectSessionPath.mockImplementation(async (_id, path) => entry(path, path === 'src' ? 'directory' : 'file'))
        view.api.manageSessionFiles.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false, error: 'Read-only directory.' })
        await act(() => view.result.current.arm('delete', [source, { path: 'src', name: 'src', kind: 'directory' }, { path: 'notes.md', name: 'notes.md', kind: 'file' }]))
        expect(view.api.inspectSessionPath.mock.calls.map(call => call[1])).toEqual(['src', 'notes.md'])
        await act(() => view.result.current.submit(''))
        expect(view.callbacks.onFileMutation).toHaveBeenCalledTimes(1)
        expect(view.callbacks.onFileMutation).toHaveBeenCalledWith(expect.objectContaining({ paths: ['src'], kind: 'directory' }))
        expect(view.callbacks.onFileMutationSettled).toHaveBeenCalledTimes(2)
        expect(view.result.current.error).toContain('1 item(s) completed')
    })

    it('rejects invalid names and nested move destinations locally', async () => {
        const view = setup()
        await act(() => view.result.current.arm('create-file', []))
        await act(() => view.result.current.submit('../outside.txt'))
        expect(view.result.current.error).toContain('one file or folder name')
        expect(view.api.manageSessionFiles).not.toHaveBeenCalled()
        view.api.inspectSessionPath.mockImplementation(async (_id, path) => entry(path, 'directory'))
        await act(() => view.result.current.arm('move', [{ path: 'src', name: 'src', kind: 'directory' }]))
        await act(() => view.result.current.submit('src/nested'))
        expect(view.result.current.error).toContain('outside its contents')
        expect(view.api.manageSessionFiles).not.toHaveBeenCalled()
    })
})

describe('workspace file uploads', () => {
    it('preserves a picked folder hierarchy and does not overwrite an existing file', async () => {
        const view = setup()
        const file = new File(['hello'], 'note.txt')
        Object.defineProperty(file, 'webkitRelativePath', { value: 'picked/sub/note.txt' })
        await act(() => view.result.current.uploadFiles([file], 'docs'))
        expect(view.api.manageSessionFiles.mock.calls).toEqual([
            ['session-a', { action: 'create-directory', path: 'docs/picked' }],
            ['session-a', { action: 'create-directory', path: 'docs/picked/sub' }],
        ])
        expect(view.api.uploadSessionFile).toHaveBeenCalledWith('session-a', { path: 'docs/picked/sub/note.txt', content: btoa('hello') })
        expect(view.result.current.status).toBe('Uploaded 1 file(s).')
        view.api.uploadSessionFile.mockResolvedValue({ success: false, code: 'conflict', error: 'Destination exists.' })
        await act(() => view.result.current.uploadFiles([new File(['changed'], 'note.txt')]))
        expect(view.result.current.error).toBe('Destination exists.')
        expect(view.api.uploadSessionFile.mock.calls.at(-1)?.[1]).not.toHaveProperty('overwrite')
    })

    it('does not traverse a conflicting symlink folder', async () => {
        const view = setup()
        view.api.manageSessionFiles.mockResolvedValue({ success: false, code: 'conflict', error: 'Destination exists.' })
        view.api.inspectSessionPath.mockImplementation(async (_id, path) => entry(path, 'symlink'))
        const file = new File(['secret'], 'note.txt')
        Object.defineProperty(file, 'webkitRelativePath', { value: 'link/note.txt' })
        await act(() => view.result.current.uploadFiles([file]))
        expect(view.api.uploadSessionFile).not.toHaveBeenCalled()
        expect(view.result.current.error).toBe('Destination exists.')
    })

    it('cancels remaining uploads after the admitted file settles', async () => {
        const response = deferred<FileManagementResponse>()
        const view = setup()
        view.api.uploadSessionFile.mockReturnValue(response.promise)
        let uploading!: Promise<void>
        act(() => { uploading = view.result.current.uploadFiles([new File(['one'], 'one.txt'), new File(['two'], 'two.txt')]) })
        await waitFor(() => expect(view.api.uploadSessionFile).toHaveBeenCalledTimes(1))
        act(() => view.result.current.cancelUpload())
        expect(view.result.current.upload?.cancelled).toBe(true)
        await act(async () => { response.resolve({ success: true }); await uploading })
        expect(view.api.uploadSessionFile).toHaveBeenCalledTimes(1)
        expect(view.callbacks.onFileMutation).toHaveBeenCalledWith(expect.objectContaining({ operation: 'upload', paths: ['one.txt'] }))
        expect(view.result.current.status).toContain('stopped after 1 file(s)')
    })

    it('rejects a forged folder-picker traversal before any request', async () => {
        const view = setup()
        const file = new File(['bytes'], 'outside.txt')
        Object.defineProperty(file, 'webkitRelativePath', { value: '../../outside.txt' })
        await act(() => view.result.current.uploadFiles([file]))
        expect(view.api.manageSessionFiles).not.toHaveBeenCalled()
        expect(view.api.uploadSessionFile).not.toHaveBeenCalled()
        expect(view.result.current.error).toContain('Invalid upload path')
    })
})
