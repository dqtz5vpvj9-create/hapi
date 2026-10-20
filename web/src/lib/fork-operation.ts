import {
    ForkOperationIdSchema, ForkOperationReceiptSchema, ForkSourceStateSchema, ForkOperationCloseResponseSchema, FORK_CLOSED_UNADMITTED_CODE,
    isForkOperationUnresolved, mergeForkOperationReceipt,
    type ForkOperationReceipt, type ForkOperationResponse, type ForkSourceState, type ForkOperationCloseResponse,
} from '@hapi/protocol/forkOperations'
import { NativeForkBoundarySchema } from '@hapi/protocol/apiTypes'
import { ApiError } from '@/api/client'
import type { ForkBoundary } from './fork-navigation'

const PREFIX = 'hapi.fork-operation.v1.'
const MAX_RECORDS = 64
const MAX_AGE = 30 * 24 * 60 * 60 * 1000
export type ForkIntent = { operationId: string; expectedForkRevision: number; boundary?: ForkBoundary; duplicateRiskOf?: string }
export type ForkRiskConfirmation = { operationId: string; revision: number }
export type ForkCloseConfirmation = { operationId: string; revision: number }
type SavedRecord = { scope: string; sourceSessionId: string; updatedAt: number; intent?: ForkIntent; operation?: ForkOperationReceipt; headRevision?: number; sourceHeadId?: string }
function parseIntent(value: unknown): ForkIntent {
    if (!value || typeof value !== 'object' || !('operationId' in value) || !('expectedForkRevision' in value)
        || !ForkOperationIdSchema.safeParse(value.operationId).success
        || typeof value.expectedForkRevision !== 'number' || !Number.isSafeInteger(value.expectedForkRevision) || value.expectedForkRevision < 0) {
        throw new Error('Invalid saved fork intent')
    }
    const boundary = 'boundary' in value ? value.boundary : undefined
    if (boundary !== undefined && !(typeof boundary === 'string' && boundary.length > 0)
        && !NativeForkBoundarySchema.safeParse(boundary).success) throw new Error('Invalid saved fork boundary')
    const duplicateRiskOf = 'duplicateRiskOf' in value ? value.duplicateRiskOf : undefined
    if (duplicateRiskOf !== undefined && (!ForkOperationIdSchema.safeParse(duplicateRiskOf).success || boundary !== undefined)) {
        throw new Error('Invalid duplicate-risk fork intent')
    }
    return { operationId: value.operationId as string, expectedForkRevision: value.expectedForkRevision, duplicateRiskOf: duplicateRiskOf as string | undefined,
        boundary: typeof boundary === 'object' && boundary ? NativeForkBoundarySchema.parse(boundary) : boundary as string | undefined }
}
function parseRecord(value: unknown): SavedRecord {
    if (!value || typeof value !== 'object' || !('scope' in value) || typeof value.scope !== 'string'
        || !('sourceSessionId' in value) || typeof value.sourceSessionId !== 'string'
        || !('updatedAt' in value) || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) throw new Error('Invalid saved fork record')
    const headRevision = 'headRevision' in value ? value.headRevision : undefined
    const sourceHeadId = 'sourceHeadId' in value ? value.sourceHeadId : undefined
    if (headRevision !== undefined && (typeof headRevision !== 'number' || !Number.isSafeInteger(headRevision) || headRevision < 0)
        || sourceHeadId !== undefined && !ForkOperationIdSchema.safeParse(sourceHeadId).success) throw new Error('Invalid fork source head')
    return { scope: value.scope, sourceSessionId: value.sourceSessionId, updatedAt: value.updatedAt,
        headRevision: headRevision as number | undefined, sourceHeadId: sourceHeadId as string | undefined,
        intent: 'intent' in value && value.intent !== undefined ? parseIntent(value.intent) : undefined,
        operation: 'operation' in value && value.operation !== undefined ? ForkOperationReceiptSchema.parse(value.operation) : undefined }
}
export type ForkOperationView = {
    revision: number | null
    intent?: ForkIntent
    operation?: ForkOperationReceipt
    busy: boolean
    error?: string
    existingRequest?: boolean
    notObserved?: boolean
    blockingSourceSessionId?: string
    sourceMessage?: string
    headRevision?: number
    sourceHeadId?: string
    sourceStateVerified?: boolean
    closure?: { operationId: string; result: ForkOperationCloseResponse['closure']; message?: string }
}
export type ForkOperationApi = {
    getForkOperationScope: () => string | null
    getForkSourceState: (source: string) => Promise<ForkSourceState>
    startForkOperation: (source: string, operationId: string, revision: number, boundary?: ForkBoundary, duplicateRiskOf?: string) => Promise<ForkOperationResponse>
    getForkOperation: (source: string, operationId: string) => Promise<ForkOperationResponse>
    reconcileForkOperation: (source: string, operationId: string) => Promise<ForkOperationResponse>
    closeUnadmittedForkOperation: (source: string, operationId: string, revision: number) => Promise<ForkOperationCloseResponse>
}

function storageKey(scope: string, source: string) { return PREFIX + JSON.stringify([scope, source]) }
function readRecord(storage: Storage | null, key: string, scope: string, source: string): SavedRecord | undefined {
    try {
        const parsed = parseRecord(JSON.parse(storage?.getItem(key) ?? 'null'))
        if (parsed.scope !== scope || parsed.sourceSessionId !== source
            || parsed.operation && parsed.operation.sourceSessionId !== source
            || parsed.intent && parsed.operation && parsed.intent.operationId !== parsed.operation.operationId) return
        return parsed
    } catch { return }
}
function rank(record: Pick<SavedRecord, 'operation' | 'intent' | 'headRevision'>): number {
    return Math.max(record.headRevision ?? -1, record.operation?.sourceRevision ?? -1, record.intent ? record.intent.expectedForkRevision + 1 : -1)
}
function writeRecord(storage: Storage | null, key: string, record: SavedRecord, authoritative = false, unadmitted?: ForkIntent): boolean {
    if (!storage) throw new Error('Safe fork needs browser storage. Enable local storage before creating a fork.')
    const previous = readRecord(storage, key, record.scope, record.sourceSessionId)
    // A proved admission rejection may retire only its exact still-tentative intent.
    // A different tab's newer intent/receipt/head must survive this older response.
    const canRetire = authoritative && unadmitted && previous?.intent && !previous.operation && !record.intent
        && previous.intent.operationId === unadmitted.operationId
        && previous.intent.expectedForkRevision === unadmitted.expectedForkRevision
        && previous.intent.duplicateRiskOf === unadmitted.duplicateRiskOf
        && JSON.stringify(previous.intent.boundary) === JSON.stringify(unadmitted.boundary)
        && (previous.headRevision ?? 0) <= (record.headRevision ?? 0)
    if (previous && rank(previous) > rank(record) && !canRetire) return false
    if (!authoritative && previous?.sourceHeadId && record.operation && previous.sourceHeadId !== record.operation.operationId
        && (previous.headRevision ?? -1) >= record.operation.sourceRevision) return false
    if (previous?.operation && record.operation?.operationId === previous.operation.operationId) {
        record = { ...record, operation: mergeForkOperationReceipt(previous.operation, record.operation) }
    }
    storage.setItem(key, JSON.stringify(record))
    // Bounded identifier-only cache. Server source state remains authoritative after eviction.
    const entries: { key: string; updatedAt: number }[] = []
    for (let i = 0; i < storage.length; i++) {
        const candidate = storage.key(i)
        if (!candidate?.startsWith(PREFIX) || candidate === key) continue
        try {
            const value = parseRecord(JSON.parse(storage.getItem(candidate) ?? 'null'))
            entries.push({ key: candidate, updatedAt: value.updatedAt })
        } catch { entries.push({ key: candidate, updatedAt: 0 }) }
    }
    entries.sort((a, b) => b.updatedAt - a.updatedAt)
    entries.forEach((entry, i) => {
        if (i >= MAX_RECORDS - 1 || entry.updatedAt < Date.now() - MAX_AGE) storage.removeItem(entry.key)
    })
    return true
}
function defaultStorage(): Storage | null {
    try { return localStorage } catch { return null }
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error) }

/** Durable explicit intents. Observations never automatically submit or change an intent. */
export function createForkOperationController(options: {
    api: ForkOperationApi
    sourceSessionId: string
    navigate: (sessionId: string) => Promise<unknown>
    storage?: Storage | null
    timeoutMs?: number
    uuid?: () => string
}) {
    const { api, sourceSessionId: source } = options
    const scope = api.getForkOperationScope()
    const key = scope ? storageKey(scope, source) : null
    const storage = options.storage === undefined ? defaultStorage() : options.storage
    const saved = key && scope ? readRecord(storage, key, scope, source) : undefined
    let view: ForkOperationView = { revision: null, intent: saved?.intent, operation: saved?.operation, headRevision: saved?.headRevision, sourceHeadId: saved?.sourceHeadId, sourceStateVerified: false, busy: false }
    let navigationEpoch = 0
    let pending: Promise<void> | null = null
    const listeners = new Set<() => void>()
    const publish = (next: Partial<ForkOperationView>) => {
        view = { ...view, ...next }
        listeners.forEach(listener => listener())
    }
    const checkScope = () => {
        if (!scope || api.getForkOperationScope() !== scope) throw new Error('Fork account changed. Reload this conversation before continuing.')
    }
    const persist = (required = false, authoritative = false, unadmitted?: ForkIntent): boolean => {
        try {
            checkScope()
            const written = writeRecord(storage, key!, { scope: scope!, sourceSessionId: source, updatedAt: Date.now(),
                intent: view.intent, operation: view.operation, headRevision: view.headRevision, sourceHeadId: view.sourceHeadId }, authoritative, unadmitted)
            if (required && !written) throw new Error('Fork state changed in another tab. Check the result again.')
            return written
        } catch (error) {
            if (required) throw error
            publish({ error: errorMessage(error) })
            return false
        }
    }
    const accept = (receipt: ForkOperationReceipt, expectedId?: string, save = true) => {
        checkScope()
        const operation = ForkOperationReceiptSchema.parse(receipt)
        if (operation.sourceSessionId !== source || expectedId && operation.operationId !== expectedId) {
            throw new Error('Fork response does not belong to this conversation or request.')
        }
        const current = view.operation
        if (view.sourceHeadId && operation.operationId !== view.sourceHeadId && operation.sourceRevision <= (view.headRevision ?? -1)) return
        if (current && current.operationId !== operation.operationId && current.sourceRevision >= operation.sourceRevision) return
        if (view.intent && view.intent.operationId !== operation.operationId && view.intent.expectedForkRevision >= operation.sourceRevision) return
        const merged = current?.operationId === operation.operationId ? mergeForkOperationReceipt(current, operation) : operation
        publish({ operation: merged, intent: view.intent?.operationId === merged.operationId ? view.intent : undefined, notObserved: false,
            headRevision: Math.max(view.headRevision ?? 0, merged.sourceRevision),
            sourceHeadId: view.sourceHeadId === merged.operationId ? view.sourceHeadId : undefined,
            sourceStateVerified: view.sourceHeadId === merged.operationId ? view.sourceStateVerified : false })
        if (save) persist()
    }
    const bounded = async <T>(work: Promise<T>): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            return await Promise.race([work, new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Fork result unconfirmed. Check the result before taking another action.')), options.timeoutMs ?? 30_000)
            })])
        } finally { clearTimeout(timer) }
    }
    const syncSaved = () => {
        try {
            checkScope()
            if (!key || !scope) return
            const latest = readRecord(storage, key, scope, source)
            if (!latest || rank(latest) < rank(view)) return
            if (latest.headRevision !== undefined && latest.headRevision >= (view.headRevision ?? 0)
                && (latest.sourceHeadId || latest.headRevision > (view.headRevision ?? 0))) {
                publish({ operation: latest.operation, intent: latest.intent, headRevision: latest.headRevision,
                    sourceHeadId: latest.sourceHeadId, sourceStateVerified: false, notObserved: false, closure: undefined })
            } else if (latest.operation) accept(latest.operation, undefined, false)
            else if (latest.intent && (!view.operation || latest.intent.expectedForkRevision >= view.operation.sourceRevision)) {
                publish({ intent: latest.intent, operation: undefined, headRevision: latest.headRevision, sourceHeadId: latest.sourceHeadId, sourceStateVerified: false, notObserved: false, closure: undefined })
            }
        } catch (error) { publish({ error: errorMessage(error) }) }
    }
    const applySourceState = (state: ForkSourceState, unadmitted?: ForkIntent) => {
        checkScope()
        if (state.operation && state.operation.sourceSessionId !== source) throw new Error('Fork response does not belong to this conversation.')
        if (state.revision < (view.headRevision ?? 0)) return
        // A locally saved request may not have reached admission yet. Keep it for exact-ID recovery.
        const awaitingAdmission = view.intent && !view.operation && (!state.operation || state.revision <= view.intent.expectedForkRevision)
            && state.operation?.operationId !== view.intent.operationId
        const operation = awaitingAdmission ? undefined : state.operation
        const merged = operation && view.operation?.operationId === operation.operationId
            ? mergeForkOperationReceipt(view.operation, operation) : operation
        publish({ revision: state.revision, headRevision: state.revision, sourceHeadId: state.operation?.operationId, sourceStateVerified: true,
            ...(awaitingAdmission ? {} : { operation: merged, intent: view.intent?.operationId === merged?.operationId ? view.intent : undefined }),
            blockingSourceSessionId: state.blockingSourceSessionId, sourceMessage: state.message,
            ...(state.blockingSourceSessionId || operation ? { notObserved: false } : {}) })
        if (!persist(false, true, unadmitted)) syncSaved()
    }
    const refreshSource = async () => {
        checkScope()
        const state = ForkSourceStateSchema.parse(await bounded(api.getForkSourceState(source)))
        applySourceState(state)
    }
    const execute = (work: () => Promise<void>): Promise<void> => {
        if (pending) return pending
        publish({ busy: true, error: undefined, existingRequest: false, closure: undefined })
        pending = Promise.resolve().then(work).catch(error => {
            publish({ error: errorMessage(error) })
        }).finally(() => { pending = null; publish({ busy: false }) })
        return pending
    }
    const observe = async (reconcile: boolean) => {
        checkScope()
        publish({ notObserved: false })
        if (view.blockingSourceSessionId) { await refreshSource(); return }
        const id = view.intent?.operationId ?? view.operation?.operationId
        if (id) {
            const work = reconcile ? api.reconcileForkOperation(source, id) : api.getForkOperation(source, id)
            try {
                // A finite wait may expire first. Exact late receipts remain useful, but never navigate.
                await bounded(work.then(result => {
                    accept(result.operation, id)
                    if (view.operation?.operationId === id && view.operation.status === 'rejected'
                        && view.operation.code === FORK_CLOSED_UNADMITTED_CODE && result.operation.status === 'rejected'
                        && result.operation.rejectionProof === 'not_dispatched' && result.operation.code === FORK_CLOSED_UNADMITTED_CODE) {
                        publish({ closure: { operationId: id, result: 'closed', message: result.operation.message } })
                    }
                }))
            } catch (error) {
                let detail: unknown
                if (error instanceof ApiError && error.status === 404 && error.code === 'operation_not_found' && error.body) {
                    try { detail = JSON.parse(error.body) } catch { /* Not an authoritative missing-operation response. */ }
                }
                if (!reconcile && detail && typeof detail === 'object' && 'code' in detail && detail.code === 'operation_not_found'
                    && 'error' in detail && typeof detail.error === 'string' && detail.error.trim()
                    && view.intent?.operationId === id && !view.operation) {
                    // An original POST may still arrive later. This only permits an explicit same-ID resubmission.
                    await refreshSource()
                    if (view.intent?.operationId === id && !view.operation && !view.blockingSourceSessionId) publish({ notObserved: true })
                    return
                }
                throw error
            }
        }
        await refreshSource()
    }
    const submitIntent = async (intent: ForkIntent, epoch: number) => {
        try {
            const work = (intent.duplicateRiskOf
                ? api.startForkOperation(source, intent.operationId, intent.expectedForkRevision, undefined, intent.duplicateRiskOf)
                : api.startForkOperation(source, intent.operationId, intent.expectedForkRevision, intent.boundary))
                .then(result => { accept(result.operation, intent.operationId); return result })
            const result = await bounded(work)
            await refreshSource()
            if (result.operation.status === 'created' && result.operation.binding === 'ready' && epoch === navigationEpoch
                && view.operation?.operationId === intent.operationId) {
                checkScope()
                await options.navigate(result.operation.childSessionId)
            }
        } catch (error) {
            // Admission conflicts are authoritative; never refresh and resubmit a new UUID.
            if (error instanceof ApiError && error.status === 409 && error.body) {
                let parsed: unknown
                try { parsed = JSON.parse(error.body) } catch { /* Keep the original error. */ }
                const conflict = ForkSourceStateSchema.safeParse(parsed)
                if (conflict.success && parsed && typeof parsed === 'object'
                    && 'code' in parsed && typeof parsed.code === 'string'
                    && ['operation_payload_conflict', 'operation_in_progress', 'fork_revision_conflict', 'risk_target_changed', 'risk_target_invalid'].includes(parsed.code)) {
                    if (conflict.data.operation && conflict.data.operation.sourceSessionId !== source) throw error
                    if (view.intent?.operationId !== intent.operationId && view.operation?.operationId !== intent.operationId) throw error
                    if (parsed.code === 'operation_payload_conflict') {
                        await refreshSource()
                        throw error
                    }
                    publish({ intent: undefined, operation: undefined, notObserved: false })
                    applySourceState(conflict.data, intent)
                    if (!conflict.data.operation && parsed.code.startsWith('risk_target_')) await refreshSource()
                }
            }
            throw error
        }
    }
    const cancelNavigation = () => { navigationEpoch++ }
    return {
        getSnapshot: () => view,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
        cancelNavigation,
        restore: () => execute(async () => {
            try { await refreshSource() }
            catch (error) {
                // Opening a conversation is not a fork request. Keep recovery
                // errors visible only when there is an operation to recover.
                if (view.intent || view.operation) throw error
            }
        }),
        check: () => execute(() => observe(false)),
        reconcile: () => execute(() => observe(true)),
        syncStorage: () => syncSaved(),
        open: () => {
            const epoch = navigationEpoch
            return execute(async () => {
                checkScope()
                const op = view.operation
                if (op?.status === 'created' && op.binding === 'ready' && epoch === navigationEpoch) await options.navigate(op.childSessionId)
            })
        },
        openOriginalSource: () => {
            const epoch = navigationEpoch
            return execute(async () => {
                checkScope()
                const originalSource = view.blockingSourceSessionId
                if (originalSource && epoch === navigationEpoch) await options.navigate(originalSource)
            })
        },
        sendOriginal: () => {
            const epoch = navigationEpoch
            return execute(async () => {
                checkScope()
                if (!view.notObserved || !view.intent || view.operation || view.blockingSourceSessionId) throw new Error('Check the original request before sending it again.')
                const intent = parseIntent(view.intent)
                const latest = readRecord(storage, key!, scope!, source)
                if (latest?.operation || latest?.intent && latest.intent.operationId !== intent.operationId) {
                    if (latest.operation) accept(latest.operation)
                    publish({ notObserved: false })
                    throw new Error('Fork state changed in another tab. Check the original result again.')
                }
                if (typeof intent.boundary === 'object') Object.freeze(intent.boundary)
                Object.freeze(intent)
                publish({ intent, notObserved: false })
                persist(true)
                // Never replace the saved revision or boundary with current UI state.
                await submitIntent(intent, epoch)
            })
        },
        createAnother: (confirmation: ForkRiskConfirmation) => {
            const epoch = navigationEpoch
            const captured = { ...confirmation }
            return execute(async () => {
                const validate = () => {
                    checkScope()
                    if (!view.sourceStateVerified || view.blockingSourceSessionId || view.operation?.status !== 'indeterminate'
                        || view.operation.operationId !== captured.operationId || view.sourceHeadId !== captured.operationId
                        || view.revision !== captured.revision) {
                        throw new Error('The original fork state changed. Check the result and review the duplicate-risk confirmation again.')
                    }
                }
                validate()
                await refreshSource()
                validate()
                const latest = readRecord(storage, key!, scope!, source)
                if (latest?.intent && latest.intent.operationId !== captured.operationId && rank(latest) > captured.revision) {
                    throw new Error('Another fork request was saved in another tab. Check the result again.')
                }
                const intent = Object.freeze(parseIntent({ operationId: (options.uuid ?? (() => crypto.randomUUID()))(),
                    expectedForkRevision: captured.revision, duplicateRiskOf: captured.operationId }))
                const previous = view
                publish({ intent, operation: undefined, notObserved: false, sourceHeadId: undefined, sourceStateVerified: false })
                try { persist(true) } catch (error) { publish(previous); throw error }
                await submitIntent(intent, epoch)
            })
        },
        closeUnadmitted: (confirmation: ForkCloseConfirmation) => {
            const captured = { ...confirmation }
            return execute(async () => {
                const validate = () => {
                    checkScope()
                    if (!view.sourceStateVerified || view.blockingSourceSessionId || view.operation?.status !== 'indeterminate'
                        || view.operation.operationId !== captured.operationId || view.sourceHeadId !== captured.operationId
                        || view.revision !== captured.revision) {
                        throw new Error('The fork state changed. Check the result and review the close-request confirmation again.')
                    }
                }
                validate()
                await refreshSource()
                validate()
                const latest = readRecord(storage, key!, scope!, source)
                if (latest?.intent && latest.intent.operationId !== captured.operationId && rank(latest) > captured.revision) {
                    syncSaved()
                    throw new Error('Another fork request was saved in another tab. Check the result again.')
                }
                const target = view.operation!
                try {
                    // No fresh intent, native fork or navigation. A late proof can still update its exact source.
                    const work = api.closeUnadmittedForkOperation(source, captured.operationId, captured.revision).then(raw => {
                        checkScope()
                        const result = ForkOperationCloseResponseSchema.parse(raw)
                        if (result.operation.sourceSessionId !== source || result.operation.operationId !== captured.operationId
                            || result.sourceState.operation && result.sourceState.operation.sourceSessionId !== source) {
                            throw new Error('Fork response does not belong to this conversation or request.')
                        }
                        // Even after another tab moves the head, the proof must retain B's complete immutable identity.
                        mergeForkOperationReceipt(target, result.operation)
                        syncSaved()
                        const relevant = view.operation?.operationId === captured.operationId
                            && view.sourceHeadId === captured.operationId
                            && result.sourceState.revision >= (view.headRevision ?? 0)
                        const state = result.sourceState
                        if (state.operation?.operationId === captured.operationId) {
                            state.operation = mergeForkOperationReceipt(state.operation, result.operation)
                        }
                        // Only sourceState chooses the restored head. B's own rejection cannot select A.
                        applySourceState(state)
                        if (relevant && view.headRevision === state.revision && view.sourceHeadId === state.operation?.operationId
                            && view.operation?.operationId === state.operation?.operationId) {
                            publish({ closure: { operationId: captured.operationId, result: result.closure, message: result.message } })
                        }
                    })
                    await bounded(work)
                } catch (error) {
                    if (error instanceof ApiError && error.status === 409 && error.body) {
                        let parsed: unknown
                        try { parsed = JSON.parse(error.body) } catch { /* Keep the original error. */ }
                        const conflict = ForkSourceStateSchema.safeParse(parsed)
                        if (conflict.success && parsed && typeof parsed === 'object' && 'code' in parsed
                            && ['fork_revision_conflict', 'fork_operation_not_indeterminate'].includes(String(parsed.code))) {
                            syncSaved()
                            applySourceState(conflict.data)
                        }
                    }
                    throw error
                }
            })
        },
        start: (boundary?: ForkBoundary) => {
            const epoch = navigationEpoch
            const capturedBoundary = typeof boundary === 'object' ? { ...boundary } : boundary
            return execute(async () => {
                checkScope()
                if (view.blockingSourceSessionId) { await refreshSource(); return }
                // Another tab may have persisted an intent since this pane read server state.
                const latest = readRecord(storage, key!, scope!, source)
                if (latest && rank(latest) >= rank(view)) {
                    if (latest.operation) accept(latest.operation)
                    else if (latest.intent) publish({ intent: latest.intent, operation: undefined, notObserved: false })
                }
                if (view.intent && !view.operation || view.operation && isForkOperationUnresolved(view.operation)) {
                    // An old confirmation (even at a different boundary) cannot create another child.
                    publish({ existingRequest: true })
                    await observe(false)
                    return
                }
                if (view.revision === null) {
                    await refreshSource()
                    throw new Error('Fork state refreshed. Confirm a new fork when you are ready.')
                }
                const intent = parseIntent({
                    operationId: (options.uuid ?? (() => crypto.randomUUID()))(), expectedForkRevision: view.revision,
                    boundary: capturedBoundary,
                })
                if (typeof intent.boundary === 'object') Object.freeze(intent.boundary)
                Object.freeze(intent)
                const previous = view
                publish({ intent, operation: undefined, notObserved: false, sourceHeadId: undefined, sourceStateVerified: false })
                try { persist(true) } catch (error) { publish({ intent: previous.intent, operation: previous.operation }); throw error }
                await submitIntent(intent, epoch)
            })
        },
    }
}
export type ForkOperationController = ReturnType<typeof createForkOperationController>
