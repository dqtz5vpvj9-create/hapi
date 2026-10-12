import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { ForkOperationCloseResponse, ForkOperationReceipt, ForkOperationResponse } from '@hapi/protocol/forkOperations'
import { ApiError } from '@/api/client'
import { createForkOperationController, type ForkOperationApi } from './fork-operation'

const firstId = '00000000-0000-4000-8000-000000000001'
const secondId = '00000000-0000-4000-8000-000000000002'
const boundary = { threadId: 'native', turnId: 'turn', itemId: 'input' }
function receipt(status: 'running' | 'indeterminate' | 'rejected' = 'indeterminate', id = firstId, revision = 1): ForkOperationReceipt {
    return { operationId: id, sourceSessionId: 'source', childSessionId: 'child', sourceRevision: revision, status, message: status, updatedAt: 1, ...(status === 'rejected' ? { rejectionProof: 'not_dispatched' as const } : {}) } as ForkOperationReceipt
}
function ready(id = firstId, revision = 1): ForkOperationReceipt {
    return { ...receipt('running', id, revision), status: 'created', binding: 'ready', nativeThreadId: 'native-child' }
}
function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
    return { promise, resolve, reject }
}
function fixture() {
    const api = {
        getForkOperationScope: vi.fn(() => 'hub/account'),
        getForkSourceState: vi.fn(async () => ({ revision: 0 } as Awaited<ReturnType<ForkOperationApi['getForkSourceState']>>)),
        startForkOperation: vi.fn<ForkOperationApi['startForkOperation']>(async () => ({ operation: receipt() })),
        getForkOperation: vi.fn<ForkOperationApi['getForkOperation']>(async () => ({ operation: receipt() })),
        reconcileForkOperation: vi.fn<ForkOperationApi['reconcileForkOperation']>(async () => ({ operation: ready() })),
        closeUnadmittedForkOperation: vi.fn<ForkOperationApi['closeUnadmittedForkOperation']>(async () => ({
            operation: receipt(), sourceState: { revision: 1, operation: receipt() }, closure: 'already_admitted',
        })),
    }
    const navigate = vi.fn(async () => {})
    const uuid = vi.fn().mockReturnValueOnce(firstId).mockReturnValueOnce(secondId)
    const create = (source = 'source') => createForkOperationController({ api, sourceSessionId: source, navigate, uuid, timeoutMs: 100 })
    return { api, navigate, create, uuid }
}

beforeEach(() => { localStorage.clear() })
afterEach(() => { vi.useRealTimers() })

describe('explicit close of an unadmitted fork request', () => {
    const thirdId = '00000000-0000-4000-8000-000000000003'
    const unknownA = receipt()
    const unknownB = { ...receipt('indeterminate', secondId, 2), duplicateRiskOf: firstId }
    const captureB = { operationId: secondId, revision: 2 }
    const closedB = { ...unknownB, status: 'rejected' as const, rejectionProof: 'not_dispatched' as const, code: 'fork_closed_unadmitted' }
    const proof: ForkOperationCloseResponse = { operation: closedB, sourceState: { revision: 3, operation: unknownA }, closure: 'closed', message: 'Exact request was absent and is now closed.' }
    async function prepared() {
        const f = fixture()
        f.api.getForkSourceState.mockResolvedValue({ revision: 2, operation: unknownB })
        const controller = f.create()
        await controller.restore()
        return { ...f, controller }
    }

    it('closes only the captured B and restores authoritative A without a new fork or navigation', async () => {
        const f = await prepared()
        const key = localStorage.key(0)!
        const saved = JSON.parse(localStorage.getItem(key)!)
        saved.intent = { operationId: secondId, expectedForkRevision: 1, duplicateRiskOf: firstId }
        localStorage.setItem(key, JSON.stringify(saved))
        f.controller.syncStorage(); await f.controller.restore()
        f.api.closeUnadmittedForkOperation.mockResolvedValue(proof)
        const capture = { ...captureB }
        const work = f.controller.closeUnadmitted(capture)
        capture.operationId = thirdId; capture.revision = 4
        await work
        expect(f.api.closeUnadmittedForkOperation).toHaveBeenCalledExactlyOnceWith('source', secondId, 2)
        expect(f.controller.getSnapshot()).toMatchObject({ revision: 3, headRevision: 3, sourceHeadId: firstId,
            intent: undefined, operation: unknownA, closure: { operationId: secondId, result: 'closed' } })
        expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ headRevision: 3, sourceHeadId: firstId, operation: unknownA })
        expect(JSON.parse(localStorage.getItem(key)!).intent).toBeUndefined()
        expect(f.api.startForkOperation).not.toHaveBeenCalled()
        expect(f.uuid).not.toHaveBeenCalled()
        expect(f.navigate).not.toHaveBeenCalled()
        f.api.getForkSourceState.mockResolvedValue(proof.sourceState)
        const reloaded = f.create(); await reloaded.restore()
        expect(reloaded.getSnapshot()).toMatchObject({ revision: 3, operation: unknownA, intent: undefined })
        expect(f.api.closeUnadmittedForkOperation).toHaveBeenCalledTimes(1)
        // An old duplicate-risk confirmation for B cannot silently become a new request from A.
        await f.controller.createAnother(captureB)
        expect(f.api.startForkOperation).not.toHaveBeenCalled()
        expect(f.controller.getSnapshot().error).toContain('state changed')
    })

    it('requires a new explicit duplicate-risk confirmation for restored A', async () => {
        const f = await prepared()
        f.api.closeUnadmittedForkOperation.mockResolvedValue(proof)
        await f.controller.closeUnadmitted(captureB)
        f.api.getForkSourceState.mockResolvedValue(proof.sourceState)
        f.uuid.mockReset().mockReturnValue(thirdId)
        f.api.startForkOperation.mockImplementation(async () => {
            const operation = { ...receipt('indeterminate', thirdId, 4), duplicateRiskOf: firstId }
            f.api.getForkSourceState.mockResolvedValue({ revision: 4, operation })
            return { operation }
        })
        await f.controller.createAnother({ operationId: firstId, revision: 3 })
        expect(f.api.startForkOperation).toHaveBeenCalledExactlyOnceWith('source', thirdId, 3, undefined, firstId)
        expect(f.navigate).not.toHaveBeenCalled()
    })

    it('does not resurrect B when the original delayed POST returns its closed tombstone after A was restored', async () => {
        vi.useFakeTimers()
        const f = fixture(), original = deferred<ForkOperationResponse>()
        f.uuid.mockReset().mockReturnValue(secondId)
        f.api.getForkSourceState.mockResolvedValue({ revision: 1, operation: unknownA })
        const controller = f.create(); await controller.restore()
        f.api.startForkOperation.mockReturnValueOnce(original.promise)
        const firstPost = controller.createAnother({ operationId: firstId, revision: 1 })
        await vi.advanceTimersByTimeAsync(101); await firstPost
        f.api.getForkSourceState.mockResolvedValue({ revision: 2, operation: unknownB })
        await controller.restore()
        f.api.closeUnadmittedForkOperation.mockResolvedValue(proof)
        await controller.closeUnadmitted(captureB)
        original.resolve({ operation: closedB })
        await vi.advanceTimersByTimeAsync(1)
        expect(controller.getSnapshot()).toMatchObject({ revision: 3, sourceHeadId: firstId, operation: unknownA })
        expect(f.api.startForkOperation).toHaveBeenCalledTimes(1)
        expect(f.api.closeUnadmittedForkOperation).toHaveBeenCalledTimes(1)
        expect(f.uuid).toHaveBeenCalledTimes(1)
        expect(f.navigate).not.toHaveBeenCalled()
    })

    it.each(['running', 'indeterminate'] as const)('does not claim a previously admitted %s request was closed', async status => {
        const f = await prepared(), admitted = { ...unknownB, status }
        f.api.closeUnadmittedForkOperation.mockResolvedValue({ operation: admitted,
            sourceState: { revision: 2, operation: admitted }, closure: 'already_admitted', message: 'The source already accepted B.' })
        await f.controller.closeUnadmitted(captureB)
        expect(f.controller.getSnapshot()).toMatchObject({ operation: { operationId: secondId, status: 'indeterminate' },
            closure: { operationId: secondId, result: 'already_admitted', message: 'The source already accepted B.' } })
        expect(f.api.startForkOperation).not.toHaveBeenCalled()
    })

    it('retains a known creation and opens it only on an explicit action', async () => {
        const f = await prepared(), created = { ...ready(secondId, 2), duplicateRiskOf: firstId }
        f.api.closeUnadmittedForkOperation.mockResolvedValue({ operation: created,
            sourceState: { revision: 2, operation: created }, closure: 'already_admitted' })
        await f.controller.closeUnadmitted(captureB)
        expect(f.controller.getSnapshot().operation).toMatchObject({ status: 'created', binding: 'ready' })
        expect(f.navigate).not.toHaveBeenCalled()
        await f.controller.open()
        expect(f.navigate).toHaveBeenCalledExactlyOnceWith('child')
        expect(f.api.startForkOperation).not.toHaveBeenCalled()
    })

    it('keeps the original receipt and readable unavailable reason without resubmission', async () => {
        const f = await prepared()
        f.api.closeUnadmittedForkOperation.mockResolvedValue({ operation: unknownB, sourceState: { revision: 2, operation: unknownB },
            closure: 'unavailable', message: 'The original canonical store is unavailable.' })
        await f.controller.closeUnadmitted(captureB)
        expect(f.controller.getSnapshot()).toMatchObject({ operation: unknownB,
            closure: { result: 'unavailable', message: 'The original canonical store is unavailable.' } })
        await f.controller.restore()
        expect(f.api.closeUnadmittedForkOperation).toHaveBeenCalledTimes(1)
        expect(f.api.startForkOperation).not.toHaveBeenCalled()
    })

    it.each([new TypeError('offline'), new ApiError('Unauthorized', 401)])('never repeats a failed close after check or reload (%s)', async error => {
        const f = await prepared()
        f.api.closeUnadmittedForkOperation.mockRejectedValueOnce(error)
        await f.controller.closeUnadmitted(captureB)
        expect(f.controller.getSnapshot()).toMatchObject({ operation: unknownB, error: error.message, busy: false })
        f.api.getForkOperation.mockResolvedValue({ operation: unknownB })
        await f.controller.check()
        const reloaded = f.create(); await reloaded.restore()
        expect(f.api.closeUnadmittedForkOperation).toHaveBeenCalledTimes(1)
        expect(f.api.startForkOperation).not.toHaveBeenCalled()
    })

    it('keeps a finite lost-close wait and recovers proof by reading without replay', async () => {
        vi.useFakeTimers()
        const f = await prepared()
        f.api.closeUnadmittedForkOperation.mockReturnValueOnce(new Promise(() => {}))
        const work = f.controller.closeUnadmitted(captureB)
        await vi.advanceTimersByTimeAsync(101); await work
        expect(f.controller.getSnapshot()).toMatchObject({ busy: false, operation: unknownB, error: expect.stringContaining('unconfirmed') })
        f.api.getForkOperation.mockResolvedValue({ operation: closedB })
        f.api.getForkSourceState.mockResolvedValue(proof.sourceState)
        await f.controller.check()
        expect(f.controller.getSnapshot()).toMatchObject({ revision: 3, operation: unknownA,
            closure: { operationId: secondId, result: 'closed' } })
        expect(f.api.closeUnadmittedForkOperation).toHaveBeenCalledTimes(1)
        expect(f.api.startForkOperation).not.toHaveBeenCalled()
    })

    it('does not retarget a confirmation when the source head changes during the fresh read', async () => {
        const f = await prepared()
        f.api.getForkSourceState.mockResolvedValue({ revision: 3, operation: unknownA })
        await f.controller.closeUnadmitted(captureB)
        expect(f.controller.getSnapshot()).toMatchObject({ revision: 3, operation: unknownA, error: expect.stringContaining('state changed') })
        expect(f.api.closeUnadmittedForkOperation).not.toHaveBeenCalled()
    })

    it('applies an exact source CAS conflict without another close or fork', async () => {
        const f = await prepared()
        f.api.closeUnadmittedForkOperation.mockRejectedValue(new ApiError('Source head changed', 409, 'fork_revision_conflict', JSON.stringify({
            error: 'Source head changed', code: 'fork_revision_conflict', ...proof.sourceState, sourceState: proof.sourceState,
        })))
        await f.controller.closeUnadmitted(captureB)
        expect(f.controller.getSnapshot()).toMatchObject({ revision: 3, operation: unknownA, error: 'Source head changed' })
        expect(f.api.closeUnadmittedForkOperation).toHaveBeenCalledTimes(1)
        expect(f.api.startForkOperation).not.toHaveBeenCalled()
    })

    it.each(['intent', 'receipt'] as const)('a late B proof preserves another tab’s newer C %s in storage and live state', async kind => {
        vi.useFakeTimers()
        const f = await prepared(), response = deferred<ForkOperationCloseResponse>()
        f.api.closeUnadmittedForkOperation.mockReturnValueOnce(response.promise)
        const work = f.controller.closeUnadmitted(captureB)
        await vi.advanceTimersByTimeAsync(101); await work
        const key = localStorage.key(0)!, previous = JSON.parse(localStorage.getItem(key)!)
        const third = kind === 'intent'
            ? { ...previous, sourceHeadId: undefined, headRevision: 3, operation: undefined,
                intent: { operationId: thirdId, expectedForkRevision: 3, duplicateRiskOf: firstId } }
            : { ...previous, sourceHeadId: thirdId, headRevision: 4, operation: receipt('indeterminate', thirdId, 4), intent: undefined }
        localStorage.setItem(key, JSON.stringify(third))
        response.resolve(proof)
        await vi.advanceTimersByTimeAsync(1)
        const saved = JSON.parse(localStorage.getItem(key)!)
        if (kind === 'intent') {
            expect(saved.intent).toEqual(third.intent)
            expect(saved.operation).toBeUndefined()
            expect(f.controller.getSnapshot()).toMatchObject({ intent: third.intent, operation: undefined })
        } else {
            expect(saved.operation).toEqual(third.operation)
            expect(f.controller.getSnapshot()).toMatchObject({ operation: third.operation, headRevision: 4 })
        }
        expect(f.controller.getSnapshot().closure).toBeUndefined()
        expect(f.navigate).not.toHaveBeenCalled()
        expect(f.api.startForkOperation).not.toHaveBeenCalled()
    })

    it.each(['operation', 'source', 'source-state', 'proof', 'child', 'admission-revision', 'ancestor'] as const)('refuses an invalid close response (%s)', async field => {
        const f = await prepared()
        const invalid = structuredClone(proof)
        if (field === 'operation') invalid.operation.operationId = thirdId
        if (field === 'source') invalid.operation.sourceSessionId = 'other-source'
        if (field === 'source-state') invalid.sourceState.operation!.sourceSessionId = 'other-source'
        if (field === 'proof') invalid.operation = unknownB
        if (field === 'child') invalid.operation.childSessionId = 'other-child'
        if (field === 'admission-revision') invalid.operation.sourceRevision = 9
        if (field === 'ancestor') invalid.operation.duplicateRiskOf = thirdId
        f.api.closeUnadmittedForkOperation.mockResolvedValue(invalid)
        await f.controller.closeUnadmitted(captureB)
        expect(f.controller.getSnapshot()).toMatchObject({ operation: unknownB, closure: undefined, error: expect.any(String) })
        expect(f.navigate).not.toHaveBeenCalled()
    })

    it('never closes an unverified head or a different account', async () => {
        const f = await prepared()
        f.controller.syncStorage()
        await f.controller.closeUnadmitted(captureB)
        expect(f.api.closeUnadmittedForkOperation).not.toHaveBeenCalled()
        await f.controller.restore()
        f.api.getForkOperationScope.mockReturnValue('other-account')
        await f.controller.closeUnadmitted(captureB)
        expect(f.api.closeUnadmittedForkOperation).not.toHaveBeenCalled()
        expect(f.controller.getSnapshot().error).toContain('account changed')
    })
    it.each(['local-only', 'alias'] as const)('never closes a %s request', async kind => {
        const f = fixture(), controller = f.create()
        await controller.restore()
        if (kind === 'local-only') {
            f.api.startForkOperation.mockRejectedValueOnce(new TypeError('offline'))
            await controller.start()
        } else {
            f.api.getForkSourceState.mockResolvedValue({ revision: 2, blockingSourceSessionId: 'original-source' })
            await controller.restore()
        }
        await controller.closeUnadmitted(captureB)
        expect(f.api.closeUnadmittedForkOperation).not.toHaveBeenCalled()
    })

    it('refuses to submit close B when another tab saved a newer C intent before confirmation', async () => {
        const f = await prepared(), key = localStorage.key(0)!
        const previous = JSON.parse(localStorage.getItem(key)!)
        const third = { ...previous, sourceHeadId: undefined, operation: undefined,
            intent: { operationId: thirdId, expectedForkRevision: 2, duplicateRiskOf: secondId } }
        localStorage.setItem(key, JSON.stringify(third))
        await f.controller.closeUnadmitted(captureB)
        expect(f.controller.getSnapshot()).toMatchObject({ intent: third.intent, operation: undefined })
        expect(JSON.parse(localStorage.getItem(key)!).intent).toEqual(third.intent)
        expect(f.api.closeUnadmittedForkOperation).not.toHaveBeenCalled()
        expect(f.api.startForkOperation).not.toHaveBeenCalled()
    })
})

describe('durable fork operation recovery', () => {
    it.each([undefined, 'managed-boundary', boundary])('persists an immutable intent and captured revision before POST (%j)', async selector => {
        const f = fixture(), controller = f.create()
        await controller.restore()
        f.api.startForkOperation.mockImplementationOnce(async (source, id, revision, captured) => {
            const value = JSON.parse(localStorage.getItem(localStorage.key(0)!)!)
            expect(value).toMatchObject({ sourceSessionId: source, intent: { operationId: id, expectedForkRevision: revision } })
            expect(value.intent.boundary).toEqual(selector)
            expect(captured).toEqual(selector)
            return { operation: receipt() }
        })
        await controller.start(selector)
        expect(f.api.startForkOperation).toHaveBeenCalledExactlyOnceWith('source', firstId, 0, selector)
    })

    it('never auto POSTs after offline failure, remount, check or another confirmation', async () => {
        const f = fixture(), controller = f.create()
        await controller.restore()
        f.api.startForkOperation.mockRejectedValueOnce(new TypeError('offline'))
        await controller.start(boundary)
        expect(controller.getSnapshot().error).toBe('offline')
        const restored = f.create()
        await restored.restore()
        expect(restored.getSnapshot().intent).toMatchObject({ operationId: firstId, boundary })
        await restored.check()
        await restored.start('a-different-boundary')
        expect(f.api.startForkOperation).toHaveBeenCalledTimes(1)
        expect(f.api.getForkOperation).toHaveBeenCalledWith('source', firstId)
        expect(f.navigate).not.toHaveBeenCalled()
    })

    it('restores the server latest operation with no local receipt and never dispatches', async () => {
        const f = fixture()
        f.api.getForkSourceState.mockResolvedValue({ revision: 1, operation: receipt() })
        const controller = f.create()
        await controller.restore()
        await controller.start()
        expect(controller.getSnapshot().operation?.operationId).toBe(firstId)
        expect(f.api.startForkOperation).not.toHaveBeenCalled()
        expect(f.navigate).not.toHaveBeenCalled()
    })

    it('has a finite wait and records a matched late result without navigating', async () => {
        vi.useFakeTimers()
        const f = fixture(), controller = f.create(), response = deferred<ForkOperationResponse>()
        await controller.restore()
        f.api.startForkOperation.mockReturnValueOnce(response.promise)
        const work = controller.start(boundary)
        await vi.advanceTimersByTimeAsync(101)
        await work
        expect(controller.getSnapshot()).toMatchObject({ busy: false, error: expect.stringContaining('unconfirmed') })
        response.resolve({ operation: ready() })
        await Promise.resolve(); await Promise.resolve()
        expect(controller.getSnapshot().operation).toMatchObject({ status: 'created', binding: 'ready' })
        expect(f.navigate).not.toHaveBeenCalled()
        await controller.open()
        expect(f.navigate).toHaveBeenCalledExactlyOnceWith('child')
        expect(f.api.startForkOperation).toHaveBeenCalledTimes(1)
    })

    it('cancellation or a newer pane binding prevents late automatic navigation', async () => {
        const f = fixture(), controller = f.create(), response = deferred<ForkOperationResponse>()
        await controller.restore()
        f.api.startForkOperation.mockReturnValueOnce(response.promise)
        const work = controller.start()
        controller.cancelNavigation()
        response.resolve({ operation: ready() })
        await work
        expect(f.navigate).not.toHaveBeenCalled()
        expect(controller.getSnapshot().operation).toMatchObject({ status: 'created' })
    })

    it('never uses a receipt from another source or auth identity', async () => {
        const f = fixture(), controller = f.create()
        await controller.restore(); await controller.start()
        expect(f.create('other-source').getSnapshot().intent).toBeUndefined()
        f.api.getForkOperationScope.mockReturnValue('different-account')
        expect(f.create().getSnapshot().intent).toBeUndefined()
        await controller.check(); await controller.open()
        expect(f.api.getForkOperation).not.toHaveBeenCalled()
        expect(f.navigate).not.toHaveBeenCalled()
        expect(controller.getSnapshot().error).toContain('account changed')
    })

    it('rejects wrong-source / wrong-operation responses without adopting or navigating', async () => {
        const f = fixture(), controller = f.create()
        await controller.restore()
        f.api.startForkOperation.mockResolvedValue({ operation: { ...ready(), sourceSessionId: 'other' } })
        await controller.start()
        expect(controller.getSnapshot().operation).toBeUndefined()
        expect(controller.getSnapshot().error).toContain('does not belong')
        expect(f.navigate).not.toHaveBeenCalled()
    })

    it('recovers a known binding with the same operation and never forks again', async () => {
        const f = fixture()
        f.api.getForkSourceState.mockResolvedValue({ revision: 1, operation: { ...ready(), binding: 'blocked' } as ForkOperationReceipt })
        const controller = f.create()
        await controller.restore(); await controller.reconcile()
        expect(controller.getSnapshot().operation).toMatchObject({ status: 'created', binding: 'ready' })
        expect(f.api.reconcileForkOperation).toHaveBeenCalledExactlyOnceWith('source', firstId)
        expect(f.api.startForkOperation).not.toHaveBeenCalled()
        expect(f.navigate).not.toHaveBeenCalled()
    })

    it.each(['ready', 'rejected'])('permits only an explicit fresh UUID after %s and a refreshed revision', async state => {
        const f = fixture(), controller = f.create()
        await controller.restore()
        const terminal = state === 'ready' ? ready() : receipt('rejected')
        f.api.startForkOperation.mockResolvedValueOnce({ operation: terminal })
        f.api.getForkSourceState.mockResolvedValue({ revision: 1, operation: terminal })
        await controller.start(boundary)
        expect(f.api.startForkOperation).toHaveBeenCalledTimes(1)
        f.api.startForkOperation.mockResolvedValueOnce({ operation: receipt('indeterminate', secondId, 2) })
        await controller.start('next-boundary')
        expect(controller.getSnapshot().error).toBeUndefined()
        expect(f.api.startForkOperation).toHaveBeenLastCalledWith('source', secondId, 1, 'next-boundary')
    })

    it('handles a stale-tab CAS conflict without refreshing and resubmitting', async () => {
        const f = fixture(), first = f.create(), stale = f.create()
        await first.restore(); await stale.restore()
        f.api.startForkOperation.mockResolvedValueOnce({ operation: ready() })
        f.api.getForkSourceState.mockResolvedValue({ revision: 1, operation: ready() })
        await first.start()
        f.api.startForkOperation.mockRejectedValueOnce(new ApiError('Source changed', 409, 'fork_revision_conflict', JSON.stringify({
            error: 'Source changed', code: 'fork_revision_conflict', revision: 1, operation: ready(),
        })))
        await stale.start()
        expect(f.api.startForkOperation).toHaveBeenCalledTimes(2)
        expect(f.api.startForkOperation).toHaveBeenLastCalledWith('source', secondId, 0, undefined)
        expect(stale.getSnapshot()).toMatchObject({ revision: 1, operation: { operationId: firstId }, error: 'Source changed' })
        expect(f.api.getForkSourceState).toHaveBeenCalledTimes(3)
    })

    it('another tab sees a pending intent and only queries the same UUID', async () => {
        const f = fixture(), first = f.create(), second = f.create(), response = deferred<ForkOperationResponse>()
        await first.restore(); await second.restore()
        f.api.startForkOperation.mockReturnValueOnce(response.promise)
        const work = first.start(boundary)
        await Promise.resolve()
        second.syncStorage()
        await second.start()
        expect(f.api.startForkOperation).toHaveBeenCalledTimes(1)
        expect(f.api.getForkOperation).toHaveBeenCalledWith('source', firstId)
        response.resolve({ operation: receipt() }); await work
    })

    it('refuses to dispatch when durable storage is unavailable', async () => {
        const f = fixture()
        const controller = createForkOperationController({ api: f.api, sourceSessionId: 'source', navigate: f.navigate, storage: null })
        await controller.restore(); await controller.start()
        expect(f.api.startForkOperation).not.toHaveBeenCalled()
        expect(controller.getSnapshot().error).toContain('browser storage')
    })

    it('deduplicates rapid confirmations', async () => {
        const f = fixture(), controller = f.create(), response = deferred<ForkOperationResponse>()
        await controller.restore()
        f.api.startForkOperation.mockReturnValueOnce(response.promise)
        const work = controller.start(boundary)
        expect(controller.start('other')).toBe(work)
        response.resolve({ operation: receipt() }); await work
        expect(f.api.startForkOperation).toHaveBeenCalledTimes(1)
    })

    it('storage events do not write back and ping-pong between tabs', async () => {
        const f = fixture(), first = f.create(), second = f.create()
        await first.restore(); await first.start()
        const write = vi.spyOn(Storage.prototype, 'setItem')
        second.syncStorage(); first.syncStorage(); second.syncStorage()
        expect(write).not.toHaveBeenCalled()
        write.mockRestore()
    })

    it('keeps the original captured boundary even when the caller mutates it', async () => {
        const f = fixture(), controller = f.create(), response = deferred<ForkOperationResponse>()
        await controller.restore()
        f.api.startForkOperation.mockReturnValueOnce(response.promise)
        const selected = { ...boundary }
        const work = controller.start(selected)
        await Promise.resolve()
        selected.itemId = 'different'
        expect(f.api.startForkOperation.mock.calls[0][3]).toEqual(boundary)
        response.resolve({ operation: receipt() }); await work
    })

    it('a payload conflict observes the accepted intent rather than marking its ID unused', async () => {
        const f = fixture(), controller = f.create()
        await controller.restore()
        f.api.startForkOperation.mockRejectedValueOnce(new ApiError('Payload changed', 409, 'operation_payload_conflict', JSON.stringify({
            error: 'Payload changed', code: 'operation_payload_conflict', revision: 1,
        })))
        f.api.getForkSourceState.mockResolvedValue({ revision: 1, operation: receipt() })
        await controller.start(boundary)
        expect(controller.getSnapshot().operation?.operationId).toBe(firstId)
        await controller.start('changed')
        expect(f.api.startForkOperation).toHaveBeenCalledTimes(1)
        expect(f.api.getForkOperation).toHaveBeenCalledWith('source', firstId)
    })

    it('a 409 without admission-conflict proof retains the unresolved UUID', async () => {
        const f = fixture(), controller = f.create()
        await controller.restore()
        f.api.startForkOperation.mockRejectedValueOnce(new ApiError('Source identity changed', 409, 'source_identity_changed', JSON.stringify({
            error: 'Source identity changed', code: 'source_identity_changed', revision: 0,
        })))
        await controller.start()
        expect(controller.getSnapshot().intent?.operationId).toBe(firstId)
        await controller.start()
        expect(f.api.startForkOperation).toHaveBeenCalledTimes(1)
    })

    it('bounds identifier-only local records without deleting unrelated storage', async () => {
        const f = fixture(), controller = f.create()
        const prefix = 'hapi.fork-operation.v1.'
        localStorage.setItem('unrelated', 'keep')
        for (let i = 0; i < 70; i++) localStorage.setItem(prefix + i, JSON.stringify({ scope: 'old', sourceSessionId: 's' + i, updatedAt: Date.now() }))
        await controller.restore(); await controller.start()
        expect(localStorage.length).toBe(65)
        expect(localStorage.getItem('unrelated')).toBe('keep')
    })


    it('ends an offline source-state wait without dispatching or spinning forever', async () => {
        vi.useFakeTimers()
        const f = fixture(), controller = f.create()
        f.api.getForkSourceState.mockReturnValueOnce(new Promise(() => {}))
        const work = controller.restore()
        await vi.advanceTimersByTimeAsync(101); await work
        expect(controller.getSnapshot()).toMatchObject({ revision: null, busy: false, error: expect.any(String) })
        expect(f.api.startForkOperation).not.toHaveBeenCalled()
    })


    it('explicitly sends the original persisted intent only after an exact missing-operation check', async () => {
        const f = fixture(), controller = f.create()
        await controller.restore()
        f.api.startForkOperation.mockRejectedValueOnce(new TypeError('offline before admission'))
        await controller.start(boundary)
        await controller.sendOriginal()
        expect(f.api.startForkOperation).toHaveBeenCalledTimes(1)
        f.api.getForkOperation.mockRejectedValueOnce(new ApiError('Not reported', 404, 'operation_not_found', JSON.stringify({
            error: 'Fork operation not found.', code: 'operation_not_found',
        })))
        await controller.check()
        expect(controller.getSnapshot().notObserved).toBe(true)
        expect(f.api.startForkOperation).toHaveBeenCalledTimes(1)
        let nativeDispatches = 0
        f.api.startForkOperation.mockImplementationOnce(async () => { nativeDispatches++; return { operation: ready() } })
        f.api.getForkSourceState.mockResolvedValue({ revision: 1, operation: ready() })
        await controller.sendOriginal()
        expect(f.api.startForkOperation.mock.calls[1]).toEqual(f.api.startForkOperation.mock.calls[0])
        expect(f.uuid).toHaveBeenCalledTimes(1)
        expect(nativeDispatches).toBe(1)
        expect(controller.getSnapshot().notObserved).toBe(false)
    })

    it('a delayed first POST and explicit original-ID resubmission share one admitted child', async () => {
        vi.useFakeTimers()
        const f = fixture(), controller = f.create(), original = deferred<ForkOperationResponse>()
        await controller.restore()
        let nativeDispatches = 0
        const admitted = new Map<string, ForkOperationResponse>()
        const admit = (id: string) => {
            let result = admitted.get(id)
            if (!result) { nativeDispatches++; result = { operation: ready(id) }; admitted.set(id, result) }
            return result
        }
        f.api.startForkOperation.mockImplementationOnce(async (_source, id) => {
            await original.promise
            return admit(id)
        })
        const first = controller.start(boundary)
        await vi.advanceTimersByTimeAsync(101); await first
        f.api.getForkOperation.mockRejectedValueOnce(new ApiError('Not reported', 404, 'operation_not_found', JSON.stringify({
            error: 'Fork operation not found.', code: 'operation_not_found',
        })))
        await controller.check()
        expect(nativeDispatches).toBe(0)
        f.api.startForkOperation.mockImplementationOnce(async (_source, id) => admit(id))
        f.api.getForkSourceState.mockResolvedValue({ revision: 1, operation: ready() })
        await controller.sendOriginal()
        original.resolve({ operation: ready() })
        await vi.advanceTimersByTimeAsync(1)
        expect(f.api.startForkOperation).toHaveBeenCalledTimes(2)
        expect(f.api.startForkOperation.mock.calls[1]).toEqual(f.api.startForkOperation.mock.calls[0])
        expect(f.uuid).toHaveBeenCalledTimes(1)
        expect(nativeDispatches).toBe(1)
        expect(f.navigate).toHaveBeenCalledTimes(1)
    })

    it.each([
        new TypeError('offline'),
        new ApiError('Missing', 404),
        new ApiError('Unknown source', 404, 'session_not_found', '{"error":"Unknown source","code":"session_not_found"}'),
        new ApiError('Not reported', 404, 'operation_not_found', 'not-json'),
        new ApiError('Expired', 401),
    ])('never treats an inconclusive check as permission to submit (%s)', async error => {
        const f = fixture(), controller = f.create()
        await controller.restore()
        f.api.startForkOperation.mockRejectedValueOnce(new TypeError('offline'))
        await controller.start()
        f.api.getForkOperation.mockRejectedValueOnce(error)
        await controller.check(); await controller.sendOriginal()
        expect(controller.getSnapshot().notObserved).not.toBe(true)
        expect(f.api.startForkOperation).toHaveBeenCalledTimes(1)
    })

    it('retains the original revision and boundary despite a newer source-state read', async () => {
        const f = fixture(), controller = f.create()
        await controller.restore()
        f.api.startForkOperation.mockRejectedValueOnce(new TypeError('offline'))
        await controller.start(boundary)
        f.api.getForkOperation.mockRejectedValueOnce(new ApiError('Not reported', 404, 'operation_not_found', JSON.stringify({
            error: 'Fork operation not found.', code: 'operation_not_found',
        })))
        f.api.getForkSourceState.mockResolvedValue({ revision: 7 })
        await controller.check(); await controller.sendOriginal()
        expect(f.api.startForkOperation).toHaveBeenLastCalledWith('source', firstId, 0, boundary)
        expect(f.uuid).toHaveBeenCalledTimes(1)
    })

    it('requires a new explicit missing-operation check after reload', async () => {
        const f = fixture(), controller = f.create()
        await controller.restore()
        f.api.startForkOperation.mockRejectedValueOnce(new TypeError('offline'))
        await controller.start()
        f.api.getForkOperation.mockRejectedValueOnce(new ApiError('Not reported', 404, 'operation_not_found', JSON.stringify({
            error: 'Fork operation not found.', code: 'operation_not_found',
        })))
        await controller.check()
        const restored = f.create()
        await restored.restore(); await restored.sendOriginal()
        expect(restored.getSnapshot().notObserved).not.toBe(true)
        expect(f.api.startForkOperation).toHaveBeenCalledTimes(1)
    })

    it('does not offer original-request sending if the source context refresh fails or reveals a receipt', async () => {
        const f = fixture(), controller = f.create()
        await controller.restore()
        f.api.startForkOperation.mockRejectedValueOnce(new TypeError('offline'))
        await controller.start()
        const missing = new ApiError('Not reported', 404, 'operation_not_found', JSON.stringify({ error: 'Not found', code: 'operation_not_found' }))
        f.api.getForkOperation.mockRejectedValueOnce(missing)
        f.api.getForkSourceState.mockRejectedValueOnce(new TypeError('source offline'))
        await controller.check(); await controller.sendOriginal()
        expect(f.api.startForkOperation).toHaveBeenCalledTimes(1)
        f.api.getForkOperation.mockRejectedValueOnce(missing)
        f.api.getForkSourceState.mockResolvedValue({ revision: 1, operation: receipt() })
        await controller.check(); await controller.sendOriginal()
        expect(controller.getSnapshot().notObserved).not.toBe(true)
        expect(f.api.startForkOperation).toHaveBeenCalledTimes(1)
    })


    it('keeps a foreign-source fence explicit without querying its operation through this source', async () => {
        const f = fixture(), controller = f.create()
        f.api.getForkSourceState.mockResolvedValue({ revision: 1, blockingSourceSessionId: 'original-source', message: 'Resolve the original fork first.' })
        await controller.restore(); await controller.start(); await controller.check(); await controller.sendOriginal()
        expect(f.api.startForkOperation).not.toHaveBeenCalled()
        expect(f.api.getForkOperation).not.toHaveBeenCalled()
        expect(controller.getSnapshot().blockingSourceSessionId).toBe('original-source')
        await controller.openOriginalSource()
        expect(f.navigate).toHaveBeenCalledExactlyOnceWith('original-source')
        f.api.getForkSourceState.mockResolvedValue({ revision: 1 })
        await controller.start()
        expect(f.api.startForkOperation).not.toHaveBeenCalled()
        await controller.start()
        expect(f.api.startForkOperation).toHaveBeenCalledExactlyOnceWith('source', firstId, 1, undefined)
    })

    it('adopts a public alias admission fence without adopting another source receipt', async () => {
        const f = fixture(), controller = f.create()
        await controller.restore()
        f.api.startForkOperation.mockRejectedValueOnce(new ApiError('Original source is unresolved', 409, 'operation_in_progress', JSON.stringify({
            error: 'Original source is unresolved', code: 'operation_in_progress', revision: 1,
            blockingSourceSessionId: 'original-source', message: 'Check the original source.',
        })))
        await controller.start()
        expect(controller.getSnapshot()).toMatchObject({ blockingSourceSessionId: 'original-source', intent: undefined, operation: undefined })
        f.api.getForkSourceState.mockResolvedValue({ revision: 1, blockingSourceSessionId: 'original-source' })
        await controller.check(); await controller.start()
        expect(f.api.getForkOperation).not.toHaveBeenCalled()
        expect(f.api.startForkOperation).toHaveBeenCalledTimes(1)
    })

})

describe('explicit duplicate-risk fork intents', () => {
    const thirdId = '00000000-0000-4000-8000-000000000003'
    const unknownA = receipt('indeterminate')
    const captureA = { operationId: firstId, revision: 1 }
    async function prepared() {
        const f = fixture()
        f.uuid.mockReset().mockReturnValueOnce(secondId).mockReturnValueOnce(thirdId)
        f.api.getForkSourceState.mockResolvedValue({ revision: 1, operation: unknownA })
        const controller = f.create()
        await controller.restore()
        return { ...f, controller }
    }

    it('persists the captured risk target and revision before the only explicit POST', async () => {
        const f = await prepared()
        const riskB = { ...receipt('indeterminate', secondId, 2), duplicateRiskOf: firstId }
        f.api.startForkOperation.mockImplementationOnce(async (source, id, revision, selected, riskOf) => {
            const saved = JSON.parse(localStorage.getItem(localStorage.key(0)!)!)
            expect(saved.intent).toEqual({ operationId: secondId, expectedForkRevision: 1, duplicateRiskOf: firstId })
            expect([source, id, revision, selected, riskOf]).toEqual(['source', secondId, 1, undefined, firstId])
            f.api.getForkSourceState.mockResolvedValue({ revision: 2, operation: riskB })
            return { operation: riskB }
        })
        expect(f.api.startForkOperation).not.toHaveBeenCalled()
        await f.controller.createAnother(captureA)
        expect(f.api.startForkOperation).toHaveBeenCalledTimes(1)
        expect(f.uuid).toHaveBeenCalledTimes(1)
    })

    it('does not silently retarget a confirmation after source head or revision changes', async () => {
        const f = await prepared()
        f.api.getForkSourceState.mockResolvedValue({ revision: 2, operation: receipt('indeterminate', secondId, 2) })
        await f.controller.createAnother(captureA)
        expect(f.api.startForkOperation).not.toHaveBeenCalled()
        expect(f.uuid).not.toHaveBeenCalled()
        expect(f.controller.getSnapshot().error).toContain('state changed')
    })

    it('does not create from an unverified receipt or a resolved target', async () => {
        const f = await prepared()
        f.api.getForkSourceState.mockResolvedValue({ revision: 1, operation: ready() })
        await f.controller.check()
        await f.controller.createAnother(captureA)
        expect(f.api.startForkOperation).not.toHaveBeenCalled()
    })

    it('a lost risk POST is only resent explicitly with the same risk payload and UUID', async () => {
        const f = await prepared()
        f.api.startForkOperation.mockRejectedValueOnce(new TypeError('offline before risk admission'))
        await f.controller.createAnother(captureA)
        const reloaded = f.create()
        await reloaded.restore()
        expect(reloaded.getSnapshot().intent).toMatchObject({ operationId: secondId, expectedForkRevision: 1, duplicateRiskOf: firstId })
        f.api.getForkOperation.mockRejectedValueOnce(new ApiError('Not reported', 404, 'operation_not_found', JSON.stringify({
            error: 'Fork operation not found.', code: 'operation_not_found',
        })))
        await reloaded.check()
        expect(reloaded.getSnapshot().notObserved).toBe(true)
        expect(f.api.startForkOperation).toHaveBeenCalledTimes(1)
        const riskB = { ...receipt('indeterminate', secondId, 2), duplicateRiskOf: firstId }
        f.api.startForkOperation.mockImplementationOnce(async () => {
            f.api.getForkSourceState.mockResolvedValue({ revision: 2, operation: riskB })
            return { operation: riskB }
        })
        await reloaded.sendOriginal()
        expect(f.api.startForkOperation.mock.calls[1]).toEqual(f.api.startForkOperation.mock.calls[0])
        expect(f.uuid).toHaveBeenCalledTimes(1)
    })

    it('B preflight rejection restores authoritative A at head revision 3 and permits explicit C risk', async () => {
        const f = await prepared()
        f.api.startForkOperation.mockImplementationOnce(async () => {
            f.api.getForkSourceState.mockResolvedValue({ revision: 3, operation: unknownA })
            return { operation: { ...receipt('rejected', secondId, 2), duplicateRiskOf: firstId } }
        })
        await f.controller.createAnother(captureA)
        expect(f.controller.getSnapshot()).toMatchObject({ revision: 3, headRevision: 3, sourceHeadId: firstId,
            operation: { operationId: firstId, sourceRevision: 1 }, intent: undefined })
        const reloaded = f.create()
        await reloaded.restore()
        expect(reloaded.getSnapshot()).toMatchObject({ revision: 3, sourceHeadId: firstId, operation: { operationId: firstId } })
        f.api.startForkOperation.mockImplementationOnce(async () => {
            const riskC = { ...receipt('indeterminate', thirdId, 4), duplicateRiskOf: firstId }
            f.api.getForkSourceState.mockResolvedValue({ revision: 4, operation: riskC })
            return { operation: riskC }
        })
        await reloaded.createAnother({ operationId: firstId, revision: 3 })
        expect(f.api.startForkOperation).toHaveBeenLastCalledWith('source', thirdId, 3, undefined, firstId)
        expect(f.api.startForkOperation).toHaveBeenCalledTimes(2)
    })

    it('a late A result cannot replace B or navigate after explicit risk admission', async () => {
        vi.useFakeTimers()
        const f = await prepared(), oldRead = deferred<ForkOperationResponse>()
        f.api.getForkOperation.mockReturnValueOnce(oldRead.promise)
        const check = f.controller.check()
        await vi.advanceTimersByTimeAsync(101); await check
        const riskB = { ...receipt('indeterminate', secondId, 2), duplicateRiskOf: firstId }
        f.api.startForkOperation.mockImplementationOnce(async () => {
            f.api.getForkSourceState.mockResolvedValue({ revision: 2, operation: riskB })
            return { operation: riskB }
        })
        await f.controller.createAnother(captureA)
        oldRead.resolve({ operation: ready() })
        await vi.advanceTimersByTimeAsync(1)
        expect(f.controller.getSnapshot()).toMatchObject({ operation: { operationId: secondId }, sourceHeadId: secondId })
        expect(f.navigate).not.toHaveBeenCalled()
        const saved = JSON.parse(localStorage.getItem(localStorage.key(0)!)!)
        expect(saved.operation.operationId).toBe(secondId)
    })

    it('an old B storage receipt cannot replace restored A with a newer head revision', async () => {
        const f = await prepared()
        f.api.startForkOperation.mockImplementationOnce(async () => {
            f.api.getForkSourceState.mockResolvedValue({ revision: 3, operation: unknownA })
            return { operation: { ...receipt('rejected', secondId, 2), duplicateRiskOf: firstId } }
        })
        await f.controller.createAnother(captureA)
        const key = localStorage.key(0)!
        const saved = JSON.parse(localStorage.getItem(key)!)
        localStorage.setItem(key, JSON.stringify({ ...saved, headRevision: 2, sourceHeadId: secondId, operation: receipt('indeterminate', secondId, 2) }))
        f.controller.syncStorage()
        expect(f.controller.getSnapshot()).toMatchObject({ revision: 3, operation: { operationId: firstId }, headRevision: 3 })
    })
    it('restores A ready if it completes between the last risk check and B admission', async () => {
        const f = await prepared()
        f.api.startForkOperation.mockRejectedValueOnce(new ApiError('Original fork is already ready', 409, 'risk_target_changed', JSON.stringify({
            error: 'Original fork is already ready', code: 'risk_target_changed', revision: 1, operation: ready(),
        })))
        await f.controller.createAnother(captureA)
        expect(f.controller.getSnapshot()).toMatchObject({ intent: undefined, revision: 1, sourceHeadId: firstId,
            operation: { operationId: firstId, status: 'created', binding: 'ready' } })
        expect(f.api.startForkOperation).toHaveBeenCalledTimes(1)
        expect(f.navigate).not.toHaveBeenCalled()
        const saved = JSON.parse(localStorage.getItem(localStorage.key(0)!)!)
        expect(saved.intent).toBeUndefined()
        expect(saved.operation).toMatchObject({ operationId: firstId, status: 'created', binding: 'ready' })
        f.api.getForkSourceState.mockResolvedValue({ revision: 1, operation: ready() })
        const reloaded = f.create()
        await reloaded.restore()
        expect(reloaded.getSnapshot()).toMatchObject({ intent: undefined, operation: { operationId: firstId, binding: 'ready' } })
        await reloaded.open()
        expect(f.navigate).toHaveBeenCalledExactlyOnceWith('child')
        await reloaded.sendOriginal()
        expect(f.api.startForkOperation).toHaveBeenCalledTimes(1)
    })

    it('a cached A head revision 3 guards against another tab’s late B receipt', async () => {
        vi.useFakeTimers()
        const f = fixture(), oldRead = deferred<ForkOperationResponse>()
        f.api.getForkSourceState.mockResolvedValue({ revision: 2, operation: receipt('indeterminate', secondId, 2) })
        const stale = f.create()
        await stale.restore()
        f.api.getForkOperation.mockReturnValueOnce(oldRead.promise)
        const check = stale.check()
        await vi.advanceTimersByTimeAsync(101); await check
        f.api.getForkSourceState.mockResolvedValue({ revision: 3, operation: unknownA })
        const current = f.create()
        await current.restore()
        stale.syncStorage()
        expect(stale.getSnapshot()).toMatchObject({ operation: { operationId: firstId }, headRevision: 3, sourceHeadId: firstId, sourceStateVerified: false })
        oldRead.resolve({ operation: receipt('indeterminate', secondId, 2) })
        await vi.advanceTimersByTimeAsync(1)
        expect(stale.getSnapshot()).toMatchObject({ operation: { operationId: firstId }, headRevision: 3, sourceHeadId: firstId })
        await stale.start()
        expect(f.api.startForkOperation).not.toHaveBeenCalled()
    })

    it.each(['intent', 'receipt'] as const)('an older B conflict cannot replace another tab’s C %s', async kind => {
        const f = await prepared(), response = deferred<ForkOperationResponse>()
        f.api.startForkOperation.mockReturnValueOnce(response.promise)
        const work = f.controller.createAnother(captureA)
        await vi.waitFor(() => expect(f.api.startForkOperation).toHaveBeenCalledTimes(1))
        const key = localStorage.key(0)!
        const previous = JSON.parse(localStorage.getItem(key)!)
        const third = kind === 'intent'
            ? { ...previous, sourceHeadId: undefined, headRevision: 1, operation: undefined,
                intent: { operationId: thirdId, expectedForkRevision: 1, duplicateRiskOf: firstId } }
            : { ...previous, sourceHeadId: thirdId, headRevision: 3, operation: receipt('indeterminate', thirdId, 2), intent: undefined }
        localStorage.setItem(key, JSON.stringify(third))
        response.reject(new ApiError('Original fork is already ready', 409, 'risk_target_changed', JSON.stringify({
            error: 'Original fork is already ready', code: 'risk_target_changed', revision: 1, operation: ready(),
        })))
        await work
        expect(JSON.parse(localStorage.getItem(key)!)).toEqual(JSON.parse(JSON.stringify(third)))
        if (kind === 'intent') expect(f.controller.getSnapshot()).toMatchObject({ intent: { operationId: thirdId }, operation: undefined })
        else expect(f.controller.getSnapshot()).toMatchObject({ intent: undefined, operation: { operationId: thirdId }, headRevision: 3 })
        expect(f.api.startForkOperation).toHaveBeenCalledTimes(1)
        expect(f.navigate).not.toHaveBeenCalled()
    })

})
