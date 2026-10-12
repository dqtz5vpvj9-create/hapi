import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useForkOperation } from './useForkOperation'
import type { ApiClient } from '@/api/client'
import type { ForkOperationCloseResponse, ForkOperationResponse } from '@hapi/protocol/forkOperations'

const pane = { beforeHide: new Set<() => void>(), focused: true }
vi.mock('@/workspace/PaneContext', () => ({ usePane: () => pane }))
function fixture() {
    let resolve!: (value: ForkOperationResponse) => void
    const pending = new Promise<ForkOperationResponse>(ok => { resolve = ok })
    const api = {
        getForkOperationScope: () => 'hub/account',
        getForkSourceState: vi.fn(async () => ({ revision: 0 })),
        startForkOperation: vi.fn(() => pending),
        getForkOperation: vi.fn(), reconcileForkOperation: vi.fn(),
    }
    const navigate = vi.fn(async () => {})
    return { api: api as unknown as ApiClient, navigate, resolve, start: api.startForkOperation }
}
const ready = { operationId: '00000000-0000-4000-8000-000000000001' as const, sourceSessionId: 'source', childSessionId: 'child', sourceRevision: 1,
    status: 'created' as const, binding: 'ready' as const, nativeThreadId: 'native-child', message: 'ready', updatedAt: 1 }
beforeEach(() => { localStorage.clear(); pane.beforeHide.clear(); pane.focused = true; vi.spyOn(crypto, 'randomUUID').mockReturnValue(ready.operationId) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('mounted fork recovery lifecycle', () => {
    it('restores on mount without posting', async () => {
        const f = fixture()
        renderHook(() => useForkOperation(f.api, 'source', true, f.navigate))
        await waitFor(() => expect(f.api.getForkSourceState).toHaveBeenCalledOnce())
        expect(f.start).not.toHaveBeenCalled()
    })
    it('unmount cancels automatic navigation while retaining a late receipt', async () => {
        const f = fixture()
        const { result, unmount } = renderHook(() => useForkOperation(f.api, 'source', true, f.navigate))
        await waitFor(() => expect(result.current.view.revision).toBe(0))
        let work!: Promise<void>
        act(() => { work = result.current.controller!.start() })
        await waitFor(() => expect(f.start).toHaveBeenCalledOnce())
        unmount()
        await act(async () => { f.resolve({ operation: ready }); await work })
        expect(f.navigate).not.toHaveBeenCalled()
        expect(localStorage.getItem(localStorage.key(0)!)).toContain('native-child')
    })
    it('a newer source context cannot receive an old child redirect', async () => {
        const f = fixture()
        const { result, rerender } = renderHook(({ source }) => useForkOperation(f.api, source, true, f.navigate), { initialProps: { source: 'source' } })
        await waitFor(() => expect(result.current.view.revision).toBe(0))
        let work!: Promise<void>
        act(() => { work = result.current.controller!.start() })
        await waitFor(() => expect(f.start).toHaveBeenCalledOnce())
        rerender({ source: 'new-source' })
        await act(async () => { f.resolve({ operation: ready }); await work })
        expect(f.navigate).not.toHaveBeenCalled()
        expect(result.current.view.operation).toBeUndefined()
    })
    it('hiding a retained pane cancels automatic navigation', async () => {
        const f = fixture()
        const { result } = renderHook(() => useForkOperation(f.api, 'source', true, f.navigate))
        await waitFor(() => expect(result.current.view.revision).toBe(0))
        let work!: Promise<void>
        act(() => { work = result.current.controller!.start() })
        await waitFor(() => expect(f.start).toHaveBeenCalledOnce())
        act(() => pane.beforeHide.forEach(cancel => cancel()))
        await act(async () => { f.resolve({ operation: ready }); await work })
        expect(f.navigate).not.toHaveBeenCalled()
    })
    it('does not initialize operation recovery for legacy/non-shared sessions', () => {
        const f = fixture()
        const { result } = renderHook(() => useForkOperation(f.api, 'source', false, f.navigate))
        expect(result.current.controller).toBeNull()
        expect(f.api.getForkSourceState).not.toHaveBeenCalled()
    })
    it('a late close proof after pane/source change updates only its original scoped cache and never navigates', async () => {
        let resolve!: (value: ForkOperationCloseResponse) => void
        const response = new Promise<ForkOperationCloseResponse>(ok => { resolve = ok })
        const unknown = { ...ready, status: 'indeterminate' as const }
        const api = {
            getForkOperationScope: () => 'hub/account',
            getForkSourceState: vi.fn(async (source: string) => source === 'source' ? { revision: 1, operation: unknown } : { revision: 0 }),
            closeUnadmittedForkOperation: vi.fn(() => response),
            startForkOperation: vi.fn(), getForkOperation: vi.fn(), reconcileForkOperation: vi.fn(),
        }
        const navigate = vi.fn(async () => {})
        const { result, rerender } = renderHook(({ source }) => useForkOperation(api as unknown as ApiClient, source, true, navigate), {
            initialProps: { source: 'source' },
        })
        await waitFor(() => expect(result.current.view.revision).toBe(1))
        let work!: Promise<void>
        act(() => { work = result.current.controller!.closeUnadmitted({ operationId: ready.operationId, revision: 1 }) })
        await waitFor(() => expect(api.closeUnadmittedForkOperation).toHaveBeenCalledOnce())
        act(() => pane.beforeHide.forEach(cancel => cancel()))
        rerender({ source: 'new-source' })
        const closed = { ...unknown, status: 'rejected' as const, rejectionProof: 'not_dispatched' as const, code: 'fork_closed_unadmitted' }
        await act(async () => {
            resolve({ operation: closed, sourceState: { revision: 1, operation: closed }, closure: 'closed' })
            await work
        })
        expect(navigate).not.toHaveBeenCalled()
        expect(api.startForkOperation).not.toHaveBeenCalled()
        expect(result.current.view.operation).toBeUndefined()
        expect(result.current.view.closure).toBeUndefined()
        const saved = Object.keys(localStorage).map(key => JSON.parse(localStorage.getItem(key)!))
        expect(saved.find(value => value.sourceSessionId === 'source').operation).toMatchObject({ code: 'fork_closed_unadmitted' })
    })
})
