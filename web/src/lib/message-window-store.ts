import type { ReadingAnchor } from '@/lib/reading-anchor'
import { getHistoryPageRepository, HistoryReadInvalidated, type HistoryPageRequest } from '@/lib/history-page-repository'
import { getReasoningStreamId } from '@hapi/protocol/messages'
import { ApiError, type ApiClient } from '@/api/client'
import { reduceChatBlocks } from '@/chat/reducer'
import { buildVisibleChatBlocks } from '@/chat/toolGroups'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import type { DecryptedMessage, MessageStatus, MessagesResponse } from '@/types/api'
import { isQueuedForInvocation, mergeMessages } from '@/lib/messages'

export type MessageViewMode = 'tail' | 'history'

export type OlderLoadOutcome =
    | {
        kind: 'applied'
        historyVersion: number
        hasMore: boolean
        addedRenderableCount: number
    }
    | {
        kind: 'stopped'
        reason: 'unavailable' | 'busy' | 'invalidated' | 'epoch-reset' | 'exhausted'
    }
    | {
        kind: 'failed'
        error: Error
    }

export type MessageWindowState = {
    sessionId: string
    messages: DecryptedMessage[]
    hasMore: boolean
    hasMoreAfter: boolean
    readingNotice: 'neighbor-restored' | null
    oldestSeq: number | null
    newestSeq: number | null
    epoch: number | null
    isSyncingTail: boolean
    isLoadingMore: boolean
    warning: string | null
    viewMode: MessageViewMode
    messagesVersion: number
    historyVersion: number
    tailRevision: number
}

export const VISIBLE_WINDOW_SIZE = 400
export const HISTORY_WINDOW_SIZE = 600
export const INITIAL_PAGE_SIZE = 20
const AGENT_RUN_WINDOW_SIZE = 800
const OLDER_LOAD_WINDOW_SIZE = 800
const PAGE_SIZE = 200
const CACHED_REENTRY_PAGE_SIZE = 20

type SavedReadingAnchor = ReadingAnchor & { sourceMessageId?: string; position?: MessagePosition }

type MessagePosition = {
    at: number
    seq: number
}

type InternalState = MessageWindowState & {
    readingBookmark: SavedReadingAnchor | null
    readerAfter: MessagePosition | null
    tailSyncError: Error | null
    oldestPositionAt: number | null
    oldestPositionSeq: number | null
    newestPositionAt: number | null
    newestPositionSeq: number | null
    requiresLatestReset: boolean
    preferLatestOnActivation: boolean
    syncGeneration: number
    olderGeneration: number
}

type PersistedMessageWindowState = {
    readingBookmark?: SavedReadingAnchor | null
    viewMode?: MessageViewMode
    readerAfter?: MessagePosition | null
    hasMoreAfter?: boolean
    messages: DecryptedMessage[]
    hasMore: boolean
    oldestPositionAt: number | null
    oldestPositionSeq: number | null
    newestPositionAt: number | null
    newestPositionSeq: number | null
    epoch: number | null
}

type TailSyncController = {
    api: ApiClient
    running: Promise<void> | null
    trailingRequested: boolean
    runningPrefersLatest: boolean
}

const states = new Map<string, InternalState>()
const listeners = new Map<string, Set<() => void>>()
const tailSyncControllers = new Map<string, TailSyncController>()
const appliedRewindLocalIds = new Map<string, Set<string>>()

const NOTIFY_THROTTLE_MS = 150
const PERSIST_THROTTLE_MS = 200
const STORAGE_KEY_PREFIX = 'hapi:message-window:v2:'
const READER_STORAGE_KEY_PREFIX = 'hapi:message-reader:v1:'
// Optional server bodies share 2 MiB of UTF-16 storage across sessions.
const MESSAGE_CACHE_STORAGE_BYTES = 2 * 1024 * 1024
const pendingNotifySessionIds = new Set<string>()
const pendingPersistSessionIds = new Set<string>()
let notifyRafId: ReturnType<typeof requestAnimationFrame> | null = null
let notifyTimerId: ReturnType<typeof setTimeout> | null = null
let persistTimerId: ReturnType<typeof setTimeout> | null = null
let lastNotifyAt = 0

function requestNotifyFrame(): void {
    if (notifyRafId !== null) {
        return
    }
    if (typeof requestAnimationFrame === 'function') {
        notifyRafId = requestAnimationFrame(flushNotifications)
        return
    }
    notifyRafId = setTimeout(flushNotifications, 0) as unknown as ReturnType<typeof requestAnimationFrame>
}

function scheduleNotify(sessionId: string): void {
    pendingNotifySessionIds.add(sessionId)
    if (notifyRafId !== null || notifyTimerId !== null) {
        return
    }
    const remaining = NOTIFY_THROTTLE_MS - (Date.now() - lastNotifyAt)
    if (remaining <= 0) {
        requestNotifyFrame()
        return
    }
    notifyTimerId = setTimeout(() => {
        notifyTimerId = null
        requestNotifyFrame()
    }, remaining)
}

function flushNotifications(): void {
    notifyRafId = null
    lastNotifyAt = Date.now()
    const sessionIds = [...pendingNotifySessionIds]
    pendingNotifySessionIds.clear()
    for (const sessionId of sessionIds) {
        const subscribers = listeners.get(sessionId)
        if (!subscribers) continue
        for (const listener of subscribers) {
            listener()
        }
    }
}

function getStorageKey(sessionId: string): string {
    return `${STORAGE_KEY_PREFIX}${sessionId}`
}

function isSessionStorageAvailable(): boolean {
    try {
        return typeof sessionStorage?.getItem === 'function'
    } catch {
        return false
    }
}

function toNullableNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readPosition(at: unknown, seq: unknown): MessagePosition | null {
    const positionAt = toNullableNumber(at)
    const positionSeq = toNullableNumber(seq)
    return positionAt !== null && positionSeq !== null
        ? { at: positionAt, seq: positionSeq }
        : null
}

function shouldPersistState(state: InternalState): boolean {
    return state.messages.length > 0
        || state.hasMore
        || state.epoch !== null
        || state.readingBookmark !== null
        || state.oldestPositionAt !== null
        || state.newestPositionAt !== null
}

function discardOptionalMessageCaches(): void {
    const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
    for (const key of keys) {
        if (!key?.startsWith(STORAGE_KEY_PREFIX)) continue
        const id = key.slice(STORAGE_KEY_PREFIX.length)
        if (sessionStorage.getItem(`${READER_STORAGE_KEY_PREFIX}${id}`)) {
            sessionStorage.removeItem(key)
        } else {
            // A previous-version window can be another session's only copy
            // of local rows. Shrink it in place, retaining its reader intent.
            const legacy = JSON.parse(sessionStorage.getItem(key)!) as PersistedMessageWindowState
            sessionStorage.setItem(key, JSON.stringify({ ...legacy,
                messages: legacy.messages.filter(row => row.seq === null || isQueuedForInvocation(row)),
                oldestPositionAt: null, oldestPositionSeq: null,
                newestPositionAt: null, newestPositionSeq: null, epoch: null
            }))
        }
    }
}

function persistMessageCache(sessionId: string, persisted: PersistedMessageWindowState): void {
    const key = getStorageKey(sessionId)
    const encodedRows: string[] = []
    let bytes = 0
    let rawStringBytes = 0
    const overBudget = new Error('Optional message cache exceeds storage budget')
    try {
        for (const row of persisted.messages) {
            if (row.seq === null || isQueuedForInvocation(row)) continue
            const encoded = JSON.stringify(row, (_key, value) => {
                if (typeof value === 'string') {
                    rawStringBytes += value.length * 2
                    if (rawStringBytes > MESSAGE_CACHE_STORAGE_BYTES) throw overBudget
                }
                return value
            })
            bytes += (encoded.length + 1) * 2
            if (bytes > MESSAGE_CACHE_STORAGE_BYTES) throw overBudget
            encodedRows.push(encoded)
        }
        const header = JSON.stringify({ ...persisted, messages: [] })
        const encoded = header.replace('"messages":[]', () => `"messages":[${encodedRows.join(',')}]`)
        bytes = encoded.length * 2
        if (bytes > MESSAGE_CACHE_STORAGE_BYTES) throw overBudget
        // Replace bodies as a cache transaction, not as reader persistence.
        sessionStorage.removeItem(key)
        const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
        let storedBytes = keys.reduce((total, cacheKey) => total + (cacheKey?.startsWith(STORAGE_KEY_PREFIX)
            ? (sessionStorage.getItem(cacheKey)?.length ?? 0) * 2 : 0), 0)
        for (const cacheKey of keys) {
            if (storedBytes + bytes <= MESSAGE_CACHE_STORAGE_BYTES) break
            if (!cacheKey?.startsWith(STORAGE_KEY_PREFIX)) continue
            const id = cacheKey.slice(STORAGE_KEY_PREFIX.length)
            if (!sessionStorage.getItem(`${READER_STORAGE_KEY_PREFIX}${id}`)) continue
            storedBytes -= (sessionStorage.getItem(cacheKey)?.length ?? 0) * 2
            sessionStorage.removeItem(cacheKey)
        }
        if (storedBytes + bytes <= MESSAGE_CACHE_STORAGE_BYTES) sessionStorage.setItem(key, encoded)
    } catch {
        // An oversized or unavailable body cache never leaves a stale window.
        sessionStorage.removeItem(key)
    }
}

function persistState(sessionId: string, state: InternalState, cacheMessages = true): void {
    if (!isSessionStorageAvailable()) {
        return
    }
    try {
        if (!shouldPersistState(state)) {
            clearPersistedState(sessionId)
            return
        }
        const persisted: PersistedMessageWindowState = {
            messages: state.messages,
            readingBookmark: state.readingBookmark,
            viewMode: state.viewMode,
            readerAfter: state.readerAfter,
            hasMoreAfter: state.hasMoreAfter,
            hasMore: state.hasMore,
            oldestPositionAt: state.oldestPositionAt,
            oldestPositionSeq: state.oldestPositionSeq,
            newestPositionAt: state.newestPositionAt,
            newestPositionSeq: state.newestPositionSeq,
            epoch: state.epoch
        }
        // Persist an explicit latest intent immediately, without certifying the
        // historical server window as a valid tail while its GET is pending.
        if (state.requiresLatestReset && state.viewMode === 'tail') {
            persisted.messages = state.messages.filter(row => row.seq === null || isQueuedForInvocation(row))
            persisted.hasMore = false
            persisted.hasMoreAfter = false
            persisted.readingBookmark = null
            persisted.readerAfter = null
            persisted.epoch = null
            persisted.oldestPositionAt = persisted.oldestPositionSeq = null
            persisted.newestPositionAt = persisted.newestPositionSeq = null
        }
        const localRows = persisted.messages.filter(row => row.seq === null || isQueuedForInvocation(row))
        // Reader intent and local/queued rows own the durable entry. Server
        // bodies are an optional cache and are stored only once, separately.
        const readerKey = `${READER_STORAGE_KEY_PREFIX}${sessionId}`
        const encodedReader = JSON.stringify({ ...persisted, messages: localRows })
        try {
            sessionStorage.setItem(readerKey, encodedReader)
        } catch (error) {
            if (!error || typeof error !== 'object' || !('name' in error) || error.name !== 'QuotaExceededError') throw error
            // Known cache pressure has a specific capacity remedy. No other
            // session's intent/local rows, or unrelated storage, is removed.
            discardOptionalMessageCaches()
            sessionStorage.setItem(readerKey, encodedReader)
        }
        if (cacheMessages) persistMessageCache(sessionId, persisted)
    } catch {
    }
}

function clearPersistedState(sessionId: string): void {
    pendingPersistSessionIds.delete(sessionId)
    if (!isSessionStorageAvailable()) {
        return
    }
    try {
        sessionStorage.removeItem(getStorageKey(sessionId))
        sessionStorage.removeItem(`${READER_STORAGE_KEY_PREFIX}${sessionId}`)
    } catch {
    }
}

function flushPersistedStates(): void {
    persistTimerId = null
    const sessionIds = [...pendingPersistSessionIds]
    pendingPersistSessionIds.clear()
    for (const sessionId of sessionIds) {
        const state = states.get(sessionId)
        if (state) {
            persistState(sessionId, state)
        } else {
            clearPersistedState(sessionId)
        }
    }
}

function schedulePersist(sessionId: string): void {
    if (!isSessionStorageAvailable()) {
        return
    }
    pendingPersistSessionIds.add(sessionId)
    if (persistTimerId === null) {
        persistTimerId = setTimeout(flushPersistedStates, PERSIST_THROTTLE_MS)
    }
}

function createState(sessionId: string): InternalState {
    return {
        sessionId,
        messages: [],
        hasMore: false,
        hasMoreAfter: false,
        readingNotice: null,
        readerAfter: null,
        readingBookmark: null,
        oldestSeq: null,
        newestSeq: null,
        epoch: null,
        isSyncingTail: false,
        isLoadingMore: false,
        warning: null,
        viewMode: 'tail',
        messagesVersion: 0,
        historyVersion: 0,
        tailRevision: 0,
        oldestPositionAt: null,
        oldestPositionSeq: null,
        newestPositionAt: null,
        newestPositionSeq: null,
        tailSyncError: null,
        requiresLatestReset: false,
        preferLatestOnActivation: false,
        syncGeneration: 0,
        olderGeneration: 0
    }
}

function hydrateState(sessionId: string): InternalState | null {
    if (!isSessionStorageAvailable()) {
        return null
    }
    try {
        const raw = sessionStorage.getItem(getStorageKey(sessionId))
        const readerRaw = sessionStorage.getItem(`${READER_STORAGE_KEY_PREFIX}${sessionId}`)
        if (!raw && !readerRaw) return null
        const cache = raw ? JSON.parse(raw) as Partial<PersistedMessageWindowState> : null
        const reader = readerRaw ? JSON.parse(readerRaw) as Partial<PersistedMessageWindowState> : null
        let parsed = reader ?? cache
        if (!parsed || !Array.isArray(parsed.messages)) {
            clearPersistedState(sessionId)
            return null
        }
        if (reader) {
            // Native epoch/cursors identify the cached window. Never combine
            // current reader intent with a body cache whose replacement failed.
            const matches = cache && Array.isArray(cache.messages)
                && cache.epoch === reader.epoch
                && cache.oldestPositionAt === reader.oldestPositionAt && cache.oldestPositionSeq === reader.oldestPositionSeq
                && cache.newestPositionAt === reader.newestPositionAt && cache.newestPositionSeq === reader.newestPositionSeq
                && (!reader.readingBookmark?.sourceMessageId || cache.messages.some(row => row.id === reader.readingBookmark!.sourceMessageId)
                    || reader.messages!.some(row => row.id === reader.readingBookmark!.sourceMessageId))
            parsed = { ...reader, messages: mergeMessages(matches ? cache!.messages! : [], reader.messages!),
                ...(!matches ? { oldestPositionAt: null, oldestPositionSeq: null,
                    newestPositionAt: null, newestPositionSeq: null, epoch: null } : {}) }
        }
        const restoreMessage = (message: DecryptedMessage): DecryptedMessage => {
            if (message.status !== 'sending') {
                return message
            }
            return {
                ...message,
                // A browser restart cannot establish server acceptance. Keep the
                // payload actionable locally while queued-state lookup resolves it.
                status: message.invokedAt === null && optimisticMessage(message) ? 'failed'
                    : message.invokedAt === null ? 'queued' : 'sent'
            }
        }
        const oldest = readPosition(parsed.oldestPositionAt, parsed.oldestPositionSeq)
        const newest = readPosition(parsed.newestPositionAt, parsed.newestPositionSeq)
        const epoch = typeof parsed.epoch === 'number' && Number.isInteger(parsed.epoch) && parsed.epoch >= 0
            ? parsed.epoch
            : null
        const restoredMessages = parsed.messages!.map(restoreMessage)
        return buildState(createState(sessionId), {
            messages: mergeMessages([], restoredMessages),
            hasMore: parsed.hasMore === true,
            hasMoreAfter: parsed.hasMoreAfter === true,
            readingBookmark: parsed.readingBookmark ?? null,
            viewMode: parsed.viewMode === 'history' ? 'history' : 'tail',
            readerAfter: readPosition(parsed.readerAfter?.at, parsed.readerAfter?.seq),
            oldestPositionAt: oldest?.at ?? null,
            oldestPositionSeq: oldest?.seq ?? null,
            newestPositionAt: newest?.at ?? null,
            newestPositionSeq: newest?.seq ?? null,
            epoch,
            requiresLatestReset: (restoredMessages.length > 0 || parsed.readingBookmark != null) && (newest === null || epoch === null)
        })
    } catch {
        clearPersistedState(sessionId)
        return null
    }
}

function getState(sessionId: string): InternalState {
    const existing = states.get(sessionId)
    if (existing) {
        return existing
    }
    const created = hydrateState(sessionId) ?? createState(sessionId)
    states.set(sessionId, created)
    return created
}

function notifyImmediate(sessionId: string): void {
    const subscribers = listeners.get(sessionId)
    if (!subscribers) return
    for (const listener of subscribers) {
        listener()
    }
}

function setState(sessionId: string, next: InternalState, immediate = false): void {
    states.set(sessionId, next)
    // A latest-reset state still contains the previous server snapshot. Do not
    // persist that stale window while the authoritative replacement is in
    // flight; a reload during the reset must not resurrect removed messages.
    if (next.requiresLatestReset) {
        pendingPersistSessionIds.delete(sessionId)
        if (next.viewMode === 'tail') persistState(sessionId, next)
    } else {
        schedulePersist(sessionId)
    }
    if (immediate) {
        notifyImmediate(sessionId)
    } else {
        scheduleNotify(sessionId)
    }
}

function updateState(
    sessionId: string,
    updater: (previous: InternalState) => InternalState,
    immediate = false
): void {
    const previous = getState(sessionId)
    const next = updater(previous)
    if (next !== previous) {
        setState(sessionId, next, immediate)
    }
}

function deriveSeqBounds(messages: DecryptedMessage[]): { oldestSeq: number | null; newestSeq: number | null } {
    let oldestSeq: number | null = null
    let newestSeq: number | null = null
    for (const message of messages) {
        if (typeof message.seq !== 'number') continue
        oldestSeq = oldestSeq === null ? message.seq : Math.min(oldestSeq, message.seq)
        newestSeq = newestSeq === null ? message.seq : Math.max(newestSeq, message.seq)
    }
    return { oldestSeq, newestSeq }
}

function messagePosition(message: DecryptedMessage): MessagePosition | null {
    return typeof message.seq === 'number'
        ? { at: message.invokedAt ?? message.createdAt, seq: message.seq }
        : null
}

function comparePosition(left: MessagePosition, right: MessagePosition): number {
    return left.at !== right.at ? left.at - right.at : left.seq - right.seq
}

function derivePosition(
    messages: DecryptedMessage[],
    direction: 'oldest' | 'newest'
): MessagePosition | null {
    let selected: MessagePosition | null = null
    for (const message of messages) {
        const candidate = messagePosition(message)
        if (!candidate) continue
        if (!selected) {
            selected = candidate
            continue
        }
        const comparison = comparePosition(candidate, selected)
        if ((direction === 'oldest' && comparison < 0) || (direction === 'newest' && comparison > 0)) {
            selected = candidate
        }
    }
    return selected
}

function getNewestCursor(state: InternalState): MessagePosition | null {
    return readPosition(state.newestPositionAt, state.newestPositionSeq)
}

function buildState(
    previous: InternalState,
    updates: Partial<Pick<InternalState,
        | 'messages'
        | 'hasMore'
        | 'hasMoreAfter'
        | 'readerAfter'
        | 'readingBookmark'
        | 'readingNotice'
        | 'epoch'
        | 'isSyncingTail'
        | 'isLoadingMore'
        | 'warning'
        | 'tailSyncError'
        | 'viewMode'
        | 'oldestPositionAt'
        | 'oldestPositionSeq'
        | 'newestPositionAt'
        | 'newestPositionSeq'
        | 'requiresLatestReset'
        | 'preferLatestOnActivation'
        | 'syncGeneration'
        | 'olderGeneration'
        | 'historyVersion'
        | 'tailRevision'
    >>
): InternalState {
    const messages = updates.messages ?? previous.messages
    const bounds = deriveSeqBounds(messages)
    return {
        ...previous,
        ...updates,
        messages,
        oldestSeq: bounds.oldestSeq,
        newestSeq: bounds.newestSeq,
        messagesVersion: messages === previous.messages
            ? previous.messagesVersion
            : previous.messagesVersion + 1
    }
}

function sliceForTrim<T>(
    items: T[],
    limit: number,
    mode: 'append' | 'prepend'
): { kept: T[]; dropped: T[] } {
    if (items.length <= limit) {
        return { kept: items, dropped: [] }
    }
    if (limit <= 0) {
        return { kept: [], dropped: items }
    }
    return mode === 'prepend'
        ? { kept: items.slice(0, limit), dropped: items.slice(limit) }
        : { kept: items.slice(items.length - limit), dropped: items.slice(0, items.length - limit) }
}

function isCodexAgentRunMessage(message: DecryptedMessage): boolean {
    const outer = message.content
    if (!outer || typeof outer !== 'object' || (outer as { role?: unknown }).role !== 'agent') {
        return false
    }
    const content = (outer as { content?: unknown }).content
    if (!content || typeof content !== 'object') return false
    const payload = content as { type?: unknown; data?: unknown }
    if (payload.type !== 'codex' || !payload.data || typeof payload.data !== 'object') {
        return false
    }
    const type = (payload.data as { type?: unknown }).type
    return type === 'agent-run-start' || type === 'agent-run-update' || type === 'agent-run-trace'
}

/** Collapse a reasoning stream down to the one snapshot that still says
 *  something.
 *
 *  The CLI re-sends a growing reasoning buffer under a stable stream id every
 *  few hundred milliseconds, and the timeline already folds those snapshots
 *  into a single block by that id. Sessions recorded before the hub started
 *  retiring them still carry every intermediate, and spending window budget on
 *  rows that render as one block is what pushes the surrounding conversation
 *  out of reach. Messages with no stream id are left alone. */
function dropSupersededReasoningSnapshots(messages: DecryptedMessage[]): DecryptedMessage[] {
    const newestByStream = new Map<string, DecryptedMessage>()
    for (const message of messages) {
        const streamId = getReasoningStreamId(message.content)
        if (streamId === null) continue
        const incumbent = newestByStream.get(streamId)
        if (!incumbent) {
            newestByStream.set(streamId, message)
            continue
        }
        // Fall back to arrival order when either row predates seq numbering:
        // `messages` is kept in display order, so later still means newer.
        const challengerAt = messagePosition(message)
        const incumbentAt = messagePosition(incumbent)
        const newer = challengerAt && incumbentAt
            ? comparePosition(challengerAt, incumbentAt) >= 0
            : true
        if (newer) newestByStream.set(streamId, message)
    }
    if (newestByStream.size === 0) return messages

    const survivors = new Set<string>()
    for (const message of newestByStream.values()) survivors.add(message.id)
    return messages.filter((message) =>
        getReasoningStreamId(message.content) === null || survivors.has(message.id))
}

function trimPreservingQueued(
    incoming: DecryptedMessage[],
    regularLimit: number,
    mode: 'append' | 'prepend'
): { kept: DecryptedMessage[]; dropped: DecryptedMessage[] } {
    const messages = dropSupersededReasoningSnapshots(incoming)
    const queued = messages.filter(isQueuedForInvocation)
    const queuedIds = new Set(queued.map((message) => message.id))
    const nonQueued = messages.filter((message) => !queuedIds.has(message.id))
    const agentRuns = nonQueued.filter(isCodexAgentRunMessage)
    const regular = nonQueued.filter((message) => !isCodexAgentRunMessage(message))
    const regularTrim = sliceForTrim(regular, Math.max(0, regularLimit - queued.length), mode)
    const agentRunTrim = sliceForTrim(agentRuns, AGENT_RUN_WINDOW_SIZE, mode)
    return {
        kept: mergeMessages([...regularTrim.kept, ...agentRunTrim.kept], queued),
        dropped: [...regularTrim.dropped, ...agentRunTrim.dropped]
    }
}

function optimisticMessage(message: DecryptedMessage): boolean {
    return Boolean(message.localId && message.id === message.localId)
}

function shouldRetainWindowMessage(message: DecryptedMessage): boolean {
    return isQueuedForInvocation(message) || normalizeDecryptedMessage(message) !== null
}

function countNewRenderableMessages(
    previous: InternalState,
    incoming: DecryptedMessage[]
): number {
    const representedIds = new Set(previous.messages.map((message) => message.id))
    const representedLocalIds = new Set(
        previous.messages.flatMap((message) => message.localId ? [message.localId] : [])
    )
    let count = 0
    for (const message of incoming) {
        if (!shouldRetainWindowMessage(message)) continue
        if (representedIds.has(message.id)) continue
        if (message.localId && representedLocalIds.has(message.localId)) continue
        count += 1
        representedIds.add(message.id)
        if (message.localId) representedLocalIds.add(message.localId)
    }
    return count
}

function mergeIntoWindow(
    previous: InternalState,
    incoming: DecryptedMessage[],
    options: {
        mode?: 'append' | 'prepend'
        regularLimit?: number
        advanceTailRevision?: boolean
    } = {}
): InternalState {
    const retainedIncoming = incoming.filter(shouldRetainWindowMessage)
    if (retainedIncoming.length === 0) {
        return previous
    }
    const mode = options.mode ?? (previous.viewMode === 'history' ? 'prepend' : 'append')
    const regularLimit = options.regularLimit
        ?? (previous.viewMode === 'history' ? HISTORY_WINDOW_SIZE : VISIBLE_WINDOW_SIZE)
    const merged = mergeMessages(previous.messages, retainedIncoming)
    const { kept, dropped } = trimPreservingQueued(merged, regularLimit, mode)
    let next = buildState(previous, {
        messages: kept,
        ...(options.advanceTailRevision
            ? { tailRevision: previous.tailRevision + 1 }
            : {})
    })
    if (dropped.length === 0) {
        return next
    }
    if (mode === 'append') {
        const oldest = derivePosition(kept, 'oldest')
        return buildState(next, {
            hasMore: true,
            oldestPositionAt: oldest?.at ?? next.oldestPositionAt,
            oldestPositionSeq: oldest?.seq ?? next.oldestPositionSeq
        })
    }
    const newest = derivePosition(kept, 'newest')
    if (previous.viewMode === 'history' && previous.epoch !== null) {
        return buildState(next, { hasMoreAfter: true, readerAfter: newest })
    }
    next = buildState(next, {
        requiresLatestReset: true,
        newestPositionAt: newest?.at ?? null,
        newestPositionSeq: newest?.seq ?? null
    })
    return next
}

function pagePosition(at: number | null, seq: number | null): MessagePosition | null {
    return at !== null && seq !== null ? { at, seq } : null
}

function applyLatestResponse(
    previous: InternalState,
    response: MessagesResponse,
    options: {
        replaceServerRows: boolean
        requestBaseline: Map<string, DecryptedMessage>
    }
): InternalState {
    const dismissedIds = new Set(
        previous.messages
            .filter((message) => message.queueDismissed)
            .map((message) => message.id)
    )
    const retainedResponseMessages = response.messages
        .filter(shouldRetainWindowMessage)
        .map((message) => (
            dismissedIds.has(message.id)
            && message.invokedAt === null
            && message.deliveryState === 'indeterminate'
                ? { ...message, queueDismissed: true }
                : message
        ))
    const concurrentServerRows = previous.messages.filter((message) => (
        !optimisticMessage(message)
        && options.requestBaseline.get(message.id) !== message
    ))
    const preserved = options.replaceServerRows
        ? previous.messages.filter((message) => (
            optimisticMessage(message)
            || options.requestBaseline.get(message.id) !== message
        ))
        : previous.messages
    const authoritative = mergeMessages(preserved, retainedResponseMessages)
    const incoming = mergeMessages(authoritative, concurrentServerRows)
    const { kept, dropped } = trimPreservingQueued(incoming, VISIBLE_WINDOW_SIZE, 'append')
    const snapshotHead = pagePosition(response.page.snapshotHeadAt, response.page.snapshotHeadSeq)
        ?? derivePosition(response.messages, 'newest')
    const newestKept = derivePosition(kept, 'newest')
    const newest = snapshotHead && newestKept
        ? (comparePosition(snapshotHead, newestKept) >= 0 ? snapshotHead : newestKept)
        : snapshotHead ?? newestKept
    const responseOldest = pagePosition(response.page.nextBeforeAt, response.page.nextBeforeSeq)
    const previousOldest = readPosition(previous.oldestPositionAt, previous.oldestPositionSeq)
    const oldest = dropped.length > 0
        ? derivePosition(kept, 'oldest')
        : options.replaceServerRows
            ? responseOldest
            : responseOldest ?? previousOldest
    return buildState(previous, {
        messages: kept,
        hasMore: response.page.hasMore || (!options.replaceServerRows && previous.hasMore) || dropped.length > 0,
        epoch: response.page.epoch,
        oldestPositionAt: oldest?.at ?? null,
        oldestPositionSeq: oldest?.seq ?? null,
        newestPositionAt: newest?.at ?? null,
        newestPositionSeq: newest?.seq ?? null,
        tailRevision: previous.tailRevision + 1,
        requiresLatestReset: false,
        ...(options.replaceServerRows && previous.readingBookmark ? { readingBookmark: null, viewMode: 'tail' as const } : {}),
        hasMoreAfter: false,
        readerAfter: null,
        isLoadingMore: options.replaceServerRows ? false : previous.isLoadingMore,
        olderGeneration: options.replaceServerRows
            ? previous.olderGeneration + 1
            : previous.olderGeneration,
        warning: null
    })
}

async function recoverReadingAfterReset(api: ApiClient, sessionId: string, response: MessagesResponse, generation: number): Promise<boolean> {
    const initial = getState(sessionId)
    const saved = initial.readingBookmark
    if (initial.viewMode !== 'history' || !saved?.sourceMessageId) return false
    let context
    let moved = false
    try {
        context = await api.getMessageContext(sessionId, saved.sourceMessageId, { radius: 99, epoch: response.page.epoch })
    } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404 || !saved.position) throw error
        moved = true
        const head = pagePosition(response.page.snapshotHeadAt, response.page.snapshotHeadSeq)
        const nearest = await api.getMessages(sessionId, {
            afterAt: saved.position.at, afterSeq: saved.position.seq,
            untilAt: head?.at, untilSeq: head?.seq, epoch: response.page.epoch, limit: PAGE_SIZE, bounded: true
        })
        const rows = nearest.messages.length ? nearest.messages : response.messages
        const first = derivePosition(rows, 'oldest'), last = derivePosition(rows, 'newest')
        if (!first || !last || !head) return false
        context = { messages: rows, page: { epoch: nearest.page.epoch, reset: false,
            beforeCursor: first, afterCursor: last, hasMoreBefore: nearest.page.direction === 'after' || nearest.page.hasMore,
            hasMoreAfter: comparePosition(last, head) < 0, snapshotHead: head } }
    }
    if (!isCurrentTailSync(sessionId, generation)) return true
    const current = getState(sessionId)
    if (current.viewMode !== 'history') return false
    const reading = current.readingBookmark
    const readerMoved = reading?.id !== saved.id
    if (!reading?.sourceMessageId || (readerMoved && !context.messages.some(row => row.id === reading.sourceMessageId))) {
        // This recovery no longer covers the user's reader. Discard it without
        // giving the caller permission to replace history with the latest page.
        // A changed epoch still requires a fresh authoritative recovery.
        updateState(sessionId, previous => buildState(previous, {
            preferLatestOnActivation: false,
            requiresLatestReset: previous.requiresLatestReset || previous.epoch !== context.page.epoch
        }))
        return true
    }
    let bookmark = reading
    if (moved && !readerMoved) {
        const normalized = context.messages.map(normalizeDecryptedMessage).filter(message => message !== null)
        const blocks = buildVisibleChatBlocks(reduceChatBlocks(normalized, null, {}).blocks, { hasMoreMessages: context.page.hasMoreBefore })
        // After a rewind the nearest surviving position can be the new head;
        // otherwise the first visible row after the removed identity is next.
        const afterHead = comparePosition(saved.position!, context.page.snapshotHead) >= 0
        const block = afterHead ? blocks.at(-1) : blocks[0]
        if (!block) return false
        const id = `hapi-message-${block.kind}:${block.id}`
        const source = findMessageSource(context.messages, id)
        bookmark = { id, topOffset: saved.topOffset, sourceMessageId: source?.id,
            position: source?.seq != null ? { at: source.invokedAt ?? source.createdAt, seq: source.seq } : undefined }
    }
    const baseline = new Map(initial.messages.map(row => [row.id, row]))
    const currentRows = new Map(current.messages.map(row => [row.id, row]))
    const rows = context.messages.map(row => {
        const live = currentRows.get(row.id)
        return live && live !== baseline.get(row.id) ? live : row
    })
    getHistoryPageRepository(api).observeEpoch(sessionId, context.page.epoch)
    updateState(sessionId, previous => {
        if (previous.syncGeneration !== generation) return previous
        return buildState(previous, {
            messages: mergeMessages(rows, previous.messages.filter(row => row.seq === null || isQueuedForInvocation(row))),
            epoch: context.page.epoch, viewMode: 'history', readingBookmark: bookmark,
            hasMore: context.page.hasMoreBefore, hasMoreAfter: context.page.hasMoreAfter,
            oldestPositionAt: context.page.beforeCursor.at, oldestPositionSeq: context.page.beforeCursor.seq,
            readerAfter: context.page.afterCursor, newestPositionAt: context.page.snapshotHead.at,
            newestPositionSeq: context.page.snapshotHead.seq, requiresLatestReset: false,
            preferLatestOnActivation: false, isLoadingMore: false, historyVersion: previous.historyVersion + 1,
            readingNotice: moved && !readerMoved ? 'neighbor-restored' : null, warning: null
        })
    }, true)
    return true
}

function beginTailSync(sessionId: string): number {
    let generation = 0
    updateState(sessionId, (previous) => {
        generation = previous.syncGeneration + 1
        return buildState(previous, {
            syncGeneration: generation,
            // Tail reconciliation owns the authoritative epoch. An older-page
            // response captured before this point must not commit while the tail
            // request is in flight, or a reset can mistake it for concurrent SSE.
            olderGeneration: previous.olderGeneration + 1,
            isSyncingTail: true,
            isLoadingMore: false,
            warning: null
        })
    })
    return generation
}

function isCurrentTailSync(sessionId: string, generation: number): boolean {
    return getState(sessionId).syncGeneration === generation
}

function finishTailSync(sessionId: string, generation: number, error: Error | null): void {
    updateState(sessionId, (previous) => {
        if (previous.syncGeneration !== generation) {
            return previous
        }
        return buildState(previous, { isSyncingTail: false, warning: error?.message ?? null, tailSyncError: error })
    })
}

async function runTailSync(api: ApiClient, sessionId: string): Promise<void> {
    const generation = beginTailSync(sessionId)
    try {
        const initial = getState(sessionId)
        const initialCursor = getNewestCursor(initial)
        const preferLatestOnActivation = initial.preferLatestOnActivation
        const canIncrement = initialCursor !== null
            && initial.epoch !== null
            && !initial.requiresLatestReset
            && !preferLatestOnActivation

        if (!canIncrement) {
            const requestBaseline = new Map(getState(sessionId).messages.map((message) => [message.id, message]))
            // Cold windows and cached re-entry prioritize the newest usable
            // messages for first paint. Structural resets and cursor-backed
            // non-activation synchronization use the full page so their
            // authoritative replacement remains unchanged.
            const latestPageSize = initial.requiresLatestReset
                ? PAGE_SIZE
                : preferLatestOnActivation
                    ? CACHED_REENTRY_PAGE_SIZE
                    : initialCursor === null
                        ? INITIAL_PAGE_SIZE
                        : PAGE_SIZE
            const response = await api.getMessages(sessionId, { limit: latestPageSize })
            if (!isCurrentTailSync(sessionId, generation)) return
            getHistoryPageRepository(api).observeEpoch(sessionId, response.page.epoch)
            if (await recoverReadingAfterReset(api, sessionId, response, generation)) {
                finishTailSync(sessionId, generation, null)
                return
            }
            updateState(sessionId, (previous) => {
                if (previous.syncGeneration !== generation) return previous
                const next = applyLatestResponse(previous, response, {
                    replaceServerRows: initial.requiresLatestReset
                        || preferLatestOnActivation
                        || response.page.reset,
                    requestBaseline
                })
                return buildState(next, { preferLatestOnActivation: false })
            })
            getHistoryPageRepository(api).observeMessages(sessionId, getState(sessionId).messages.filter(row => row.seq !== null))
            finishTailSync(sessionId, generation, null)
            return
        }

        let after = initialCursor
        let until: MessagePosition | null = null
        while (true) {
            const requestBaseline = new Map(getState(sessionId).messages.map((message) => [message.id, message]))
            const response = await api.getMessages(sessionId, {
                afterAt: after.at,
                afterSeq: after.seq,
                untilAt: until?.at ?? null,
                untilSeq: until?.seq ?? null,
                epoch: initial.epoch,
                limit: PAGE_SIZE
            })
            if (!isCurrentTailSync(sessionId, generation)) return
            getHistoryPageRepository(api).observeEpoch(sessionId, response.page.epoch)

            if (response.page.reset || response.page.direction === 'latest') {
                if (await recoverReadingAfterReset(api, sessionId, response, generation)) break
                updateState(sessionId, (previous) => {
                    if (previous.syncGeneration !== generation) return previous
                    return applyLatestResponse(previous, response, {
                        replaceServerRows: true,
                        requestBaseline
                    })
                })
                break
            }

            const nextAfter = pagePosition(response.page.nextAfterAt, response.page.nextAfterSeq)
            const snapshotHead = pagePosition(response.page.snapshotHeadAt, response.page.snapshotHeadSeq)
            if (until === null) {
                until = snapshotHead
            }

            updateState(sessionId, (previous) => {
                if (previous.syncGeneration !== generation) return previous
                const currentRows = new Map(previous.messages.map(row => [row.id, row]))
                const freshRows = response.messages.map(row => {
                    const current = currentRows.get(row.id)
                    return current && current !== requestBaseline.get(row.id) ? current : row
                })
                const visibleIncoming = previous.hasMoreAfter
                    ? freshRows.filter(message => currentRows.has(message.id))
                    : freshRows
                const merged = mergeIntoWindow(previous, visibleIncoming, {
                    advanceTailRevision: true
                })
                if (merged.requiresLatestReset) {
                    return buildState(merged, {
                        epoch: response.page.epoch,
                        warning: null
                    })
                }
                const currentNewest = getNewestCursor(merged)
                const newest = nextAfter && currentNewest
                    ? (comparePosition(nextAfter, currentNewest) >= 0 ? nextAfter : currentNewest)
                    : nextAfter ?? currentNewest
                return buildState(merged, {
                    epoch: response.page.epoch,
                    newestPositionAt: newest?.at ?? null,
                    newestPositionSeq: newest?.seq ?? null,
                    warning: null
                })
            })

            const current = getState(sessionId)
            getHistoryPageRepository(api).observeMessages(sessionId, current.messages.filter(row => row.seq !== null))
            if (
                current.requiresLatestReset
                || current.preferLatestOnActivation
                || !response.page.hasMore
                || !nextAfter
            ) {
                break
            }
            if (comparePosition(nextAfter, after) <= 0) {
                throw new Error('Message tail cursor did not advance')
            }
            after = nextAfter
        }

        finishTailSync(sessionId, generation, null)
    } catch (error) {
        if (!isCurrentTailSync(sessionId, generation)) return
        finishTailSync(
            sessionId,
            generation,
            error instanceof Error ? error : new Error('Failed to synchronize messages')
        )
    }
}

function startTailSync(sessionId: string, controller: TailSyncController): Promise<void> {
    const runningPrefersLatest = getState(sessionId).preferLatestOnActivation
    const running = runTailSync(controller.api, sessionId)
    controller.running = running
    controller.runningPrefersLatest = runningPrefersLatest
    const finish = () => {
        if (tailSyncControllers.get(sessionId) !== controller || controller.running !== running) {
            return
        }
        controller.running = null
        controller.runningPrefersLatest = false
        if (!controller.trailingRequested) {
            return
        }
        controller.trailingRequested = false
        startTailSync(sessionId, controller)
    }
    void running.then(finish, finish)
    return running
}

async function waitForTailSyncDrain(
    sessionId: string,
    controller: TailSyncController,
    observed: Promise<void>
): Promise<void> {
    await observed
    if (tailSyncControllers.get(sessionId) !== controller) {
        return
    }
    const current = controller.running
    if (current && current !== observed) {
        await waitForTailSyncDrain(sessionId, controller, current)
    }
}

function enterTailMode(previous: InternalState): InternalState {
    const { kept, dropped } = trimPreservingQueued(previous.messages, VISIBLE_WINDOW_SIZE, 'append')
    const forceLatest = previous.requiresLatestReset || previous.hasMoreAfter
    const oldest = dropped.length > 0
        ? derivePosition(kept, 'oldest')
        : readPosition(previous.oldestPositionAt, previous.oldestPositionSeq)
    return buildState(previous, {
        messages: kept,
        hasMore: previous.hasMore || dropped.length > 0,
        viewMode: 'tail',
        readingNotice: null,
        readingBookmark: null,
        hasMoreAfter: false,
        readerAfter: null,
        requiresLatestReset: forceLatest,
        epoch: forceLatest ? null : previous.epoch,
        oldestPositionAt: oldest?.at ?? null,
        oldestPositionSeq: oldest?.seq ?? null,
        newestPositionAt: forceLatest ? null : previous.newestPositionAt,
        newestPositionSeq: forceLatest ? null : previous.newestPositionSeq
    })
}

export function activateMessageWindow(sessionId: string): void {
    let requestedLatest = false
    updateState(sessionId, (previous) => {
        // A saved reading position owns re-entry; tail refresh must not evict it.
        if (previous.viewMode === 'history' && previous.readingBookmark
            && ((previous.epoch !== null && !previous.requiresLatestReset) || previous.readingBookmark.sourceMessageId)) {
            return previous.preferLatestOnActivation
                ? buildState(previous, { preferLatestOnActivation: false })
                : previous
        }
        const { kept } = trimPreservingQueued(previous.messages, VISIBLE_WINDOW_SIZE, 'append')
        const forceLatest = previous.requiresLatestReset || previous.hasMoreAfter
        const hasUsableCursor = getNewestCursor(previous) !== null
            && previous.epoch !== null
            && !forceLatest
        const preferLatestOnActivation = hasUsableCursor && kept.length > 0
        requestedLatest = preferLatestOnActivation && !previous.preferLatestOnActivation
        const invalidateRunningSync = requestedLatest && previous.isSyncingTail
        const activationUpdates = preferLatestOnActivation
            ? {
                preferLatestOnActivation: true,
                ...(invalidateRunningSync
                    ? {
                        syncGeneration: previous.syncGeneration + 1,
                        olderGeneration: previous.olderGeneration + 1
                    }
                    : {})
            }
            : {}
        // A persisted cursor may be many pages behind after another client
        // has added messages. Fetch the current tail first on re-entry;
        // `runTailSync` will reconcile the response through the same
        // optimistic/concurrent-row preservation path as a reset response.
        if (
            previous.viewMode === 'tail'
            && kept.length === previous.messages.length
            && !forceLatest
        ) {
            return preferLatestOnActivation
                ? buildState(previous, activationUpdates)
                : previous
        }
        const next = enterTailMode(previous)
        return preferLatestOnActivation
            ? buildState(next, activationUpdates)
            : next
    }, true)
    if (requestedLatest) {
        const controller = tailSyncControllers.get(sessionId)
        if (controller?.running) {
            controller.trailingRequested = true
        }
    }
}

export function findMessageSource(messages: readonly DecryptedMessage[], anchorId: string): DecryptedMessage | undefined {
    const id = anchorId.replace(/^hapi-(?:message|reading)-/, '').replace(/~\d+$/, '')
    const blockId = id.slice(id.indexOf(':') + 1).replace(/^tool-group:/, '')
    for (let index = messages.length - 1; index >= 0; index--) {
        const row = messages[index]
        if (blockId === row.id || blockId.startsWith(`${row.id}:`)) return row
    }
    for (let index = messages.length - 1; index >= 0; index--) {
        const row = messages[index]
        const message = normalizeDecryptedMessage(row)
        if (message?.role === 'agent' && message.content.some(part =>
            ('streamId' in part && part.streamId === blockId) || (part.type === 'tool-call' && part.id === blockId)
        )) return row
    }
    return undefined
}

export function getMessageReadingAnchor(sessionId: string): ReadingAnchor | null {
    return getState(sessionId).readingBookmark
}

/** Scrolling changes the bookmark, not the message projection. */
export function saveMessageReadingAnchor(sessionId: string, anchor: ReadingAnchor | null, immediate = false): void {
    const state = getState(sessionId)
    let readingBookmark: SavedReadingAnchor | null = anchor
    if (anchor) {
        const source = findMessageSource(state.messages, anchor.id)
        const previous = state.readingBookmark?.id === anchor.id ? state.readingBookmark : null
        readingBookmark = { ...anchor,
            sourceMessageId: source?.id ?? previous?.sourceMessageId,
            position: source?.seq != null ? { at: source.invokedAt ?? source.createdAt, seq: source.seq } : previous?.position }
    }
    const next = { ...state, readingBookmark }
    states.set(sessionId, next)
    if (!next.requiresLatestReset || next.viewMode === 'tail') {
        // Scrolling only changes reader metadata; do not serialize all bodies.
        persistState(sessionId, next, false)
    }
}

/** Pagination starts at covered history, which can differ from the oldest
 * retained row (for example an earlier live reasoning snapshot). */
export function getMessageHistoryCursor(sessionId: string): MessagePosition | null {
    const state = getState(sessionId)
    return readPosition(state.oldestPositionAt, state.oldestPositionSeq)
}

/** Preserve the original API status for consumers recovering from a failed refresh. */
export function getMessageTailSyncError(sessionId: string): Error | null {
    return getState(sessionId).tailSyncError
}

export function syncTailMessages(
    api: ApiClient,
    sessionId: string,
    options: { ensureAfterCurrent?: boolean } = {}
): Promise<void> {
    let controller = tailSyncControllers.get(sessionId)
    if (!controller) {
        controller = {
            api,
            running: null,
            trailingRequested: false,
            runningPrefersLatest: false
        }
        tailSyncControllers.set(sessionId, controller)
    }
    controller.api = api
    if (!controller.running) {
        return startTailSync(sessionId, controller)
    }
    if (getState(sessionId).preferLatestOnActivation) {
        if (controller.runningPrefersLatest) {
            return controller.running
        }
        controller.trailingRequested = false
        return startTailSync(sessionId, controller)
    }
    const observed = controller.running
    if (!options.ensureAfterCurrent) {
        return observed
    }
    controller.trailingRequested = true
    return waitForTailSyncDrain(sessionId, controller, observed)
}

export async function fetchOlderMessages(
    api: ApiClient,
    sessionId: string,
    options: {
        onBeforeApply?: (historyVersion: number) => boolean
    } = {}
): Promise<OlderLoadOutcome> {
    const initial = getState(sessionId)
    const before = readPosition(initial.oldestPositionAt, initial.oldestPositionSeq)
    if (initial.isSyncingTail || initial.isLoadingMore) {
        return { kind: 'stopped', reason: 'busy' }
    }
    if (!initial.hasMore) {
        return { kind: 'stopped', reason: 'exhausted' }
    }
    if (!before || initial.epoch === null) {
        return { kind: 'stopped', reason: 'unavailable' }
    }
    const generation = initial.olderGeneration + 1
    updateState(sessionId, (previous) => buildState(previous, {
        olderGeneration: generation,
        isLoadingMore: true,
        warning: null
    }))

    try {
        const repository = getHistoryPageRepository(api)
        repository.observeEpoch(sessionId, initial.epoch)
        const request = { direction: 'before' as const, cursor: before, epoch: initial.epoch }
        let response
        try {
            response = await repository.read(sessionId, request)
        } catch (error) {
            if (!(error instanceof HistoryReadInvalidated) || getState(sessionId).olderGeneration !== generation) throw error
            response = await repository.read(sessionId, request, { refresh: true })
        }
        if (getState(sessionId).olderGeneration !== generation) {
            return { kind: 'stopped', reason: 'invalidated' }
        }

        if (response.page.reset || response.page.epoch !== initial.epoch) {
            updateState(sessionId, (previous) => {
                if (previous.olderGeneration !== generation) return previous
                return buildState(previous, {
                    isLoadingMore: false,
                    epoch: null,
                    newestPositionAt: null,
                    newestPositionSeq: null,
                    requiresLatestReset: true
                })
            })
            await syncTailMessages(api, sessionId, { ensureAfterCurrent: true })
            return { kind: 'stopped', reason: 'epoch-reset' }
        }

        let historyVersion = 0
        let addedRenderableCount = 0
        let applyRejected = false
        // Prepend trimming and its prepared scroll restore must reach the UI
        // in one publication; the normal 150ms notification throttle would
        // expose rows that this state has already evicted.
        updateState(sessionId, (previous) => {
            if (previous.olderGeneration !== generation) return previous
            addedRenderableCount = countNewRenderableMessages(previous, response.messages)
            const nextHistoryVersion = previous.historyVersion + 1
            if (options.onBeforeApply && !options.onBeforeApply(nextHistoryVersion)) {
                applyRejected = true
                return buildState(previous, {
                    olderGeneration: previous.olderGeneration + 1,
                    isLoadingMore: false,
                    warning: null
                })
            }
            const merged = mergeIntoWindow(previous, response.messages, {
                mode: 'prepend',
                regularLimit: OLDER_LOAD_WINDOW_SIZE
            })
            historyVersion = nextHistoryVersion
            return buildState(merged, {
                hasMore: response.page.hasMore,
                epoch: response.page.epoch,
                oldestPositionAt: response.page.nextBeforeAt,
                oldestPositionSeq: response.page.nextBeforeSeq,
                isLoadingMore: false,
                historyVersion,
                warning: null
            })
        }, true)
        if (applyRejected || historyVersion === 0) {
            return { kind: 'stopped', reason: 'invalidated' }
        }
        return {
            kind: 'applied',
            historyVersion,
            hasMore: response.page.hasMore,
            addedRenderableCount
        }
    } catch (error) {
        if (getState(sessionId).olderGeneration !== generation) {
            return { kind: 'stopped', reason: 'invalidated' }
        }
        const loadError = error instanceof Error
            ? error
            : new Error('Failed to load older messages')
        updateState(sessionId, (previous) => {
            if (previous.olderGeneration !== generation) return previous
            return buildState(previous, {
                isLoadingMore: false,
                warning: loadError.message
            })
        })
        return { kind: 'failed', error: loadError }
    }
}

/** Select an archived identity directly, without walking every intervening page. */
export async function openMessageContext(api: ApiClient, sessionId: string, messageId: string, isCurrent: () => boolean): Promise<boolean> {
    const initial = getState(sessionId)
    const generation = initial.olderGeneration + 1
    updateState(sessionId, previous => buildState(previous, {
        olderGeneration: generation, syncGeneration: previous.syncGeneration + 1,
        isLoadingMore: true, isSyncingTail: false, warning: null
    }), true)
    try {
        const repository = getHistoryPageRepository(api)
        const cached = initial.epoch === null ? null : repository.findCachedMessagePage(sessionId, initial.epoch, messageId)
        const context = cached ? null : await api.getMessageContext(sessionId, messageId, {
            radius: 99, ...(initial.epoch === null ? {} : { epoch: initial.epoch })
        })
        if (!isCurrent() || getState(sessionId).olderGeneration !== generation) return false
        const currentRows = new Map(getState(sessionId).messages.map(row => [row.id, row]))
        const baseline = new Map(initial.messages.map(row => [row.id, row]))
        const rows = (cached?.messages ?? context!.messages).map(row => {
            const current = currentRows.get(row.id)
            return current && current !== baseline.get(row.id) ? current : row
        })
        const first = derivePosition(rows, 'oldest')
        const last = derivePosition(rows, 'newest')
        const responseHead = context?.page.snapshotHead ?? getNewestCursor(initial)
        const currentHead = getNewestCursor(getState(sessionId))
        const head = responseHead && currentHead
            ? (comparePosition(responseHead, currentHead) >= 0 ? responseHead : currentHead)
            : responseHead ?? currentHead
        const epoch = context?.page.epoch ?? initial.epoch!
        if (context?.page.reset || epoch !== initial.epoch) repository.observeEpoch(sessionId, epoch)
        updateState(sessionId, previous => buildState(previous, {
            messages: mergeMessages(rows, previous.messages.filter(message => message.seq === null || isQueuedForInvocation(message))),
            epoch, viewMode: 'history', readingNotice: null, readingBookmark: null,
            hasMore: context?.page.hasMoreBefore ?? (cached!.page.direction === 'after' ? true : cached!.page.hasMore),
            hasMoreAfter: Boolean(context?.page.hasMoreAfter) || Boolean(last && head && comparePosition(last, head) < 0),
            oldestPositionAt: context?.page.beforeCursor.at ?? cached?.page.nextBeforeAt ?? first?.at ?? null,
            oldestPositionSeq: context?.page.beforeCursor.seq ?? cached?.page.nextBeforeSeq ?? first?.seq ?? null,
            readerAfter: context?.page.afterCursor ?? last,
            newestPositionAt: head?.at ?? null, newestPositionSeq: head?.seq ?? null,
            isLoadingMore: false, requiresLatestReset: false,
            historyVersion: previous.historyVersion + 1
        }), true)
        return true
    } catch (error) {
        if (isCurrent() && getState(sessionId).olderGeneration === generation) updateState(sessionId, previous => buildState(previous, {
            isLoadingMore: false, warning: error instanceof Error ? error.message : String(error)
        }), true)
        return false
    } finally {
        if (!isCurrent() && getState(sessionId).olderGeneration === generation) cancelOlderMessageLoad(sessionId)
    }
}

/** Continue toward the latest snapshot while retaining the reader's current window. */
export async function fetchNewerHistory(api: ApiClient, sessionId: string, onBeforeApply?: () => void | Promise<void>): Promise<boolean> {
    const initial = getState(sessionId)
    const until = getNewestCursor(initial)
    if (!initial.hasMoreAfter || !initial.readerAfter || !until || initial.epoch === null || initial.isLoadingMore || initial.isSyncingTail) return false
    const generation = initial.olderGeneration + 1
    updateState(sessionId, previous => buildState(previous, { olderGeneration: generation, isLoadingMore: true }))
    try {
        const response = await getHistoryPageRepository(api).read(sessionId, {
            direction: 'after', cursor: initial.readerAfter, until, epoch: initial.epoch
        })
        if (getState(sessionId).olderGeneration !== generation) return false
        if (response.page.reset || response.page.epoch !== initial.epoch) {
            markMessageWindowForLatestReset(sessionId, getState(sessionId).messages)
            await syncTailMessages(api, sessionId)
            return false
        }
        await onBeforeApply?.()
        if (getState(sessionId).olderGeneration !== generation) return false
        updateState(sessionId, previous => {
            const merged = mergeIntoWindow(previous, response.messages, { mode: 'append', regularLimit: OLDER_LOAD_WINDOW_SIZE })
            const readerAfter = pagePosition(response.page.nextAfterAt, response.page.nextAfterSeq) ?? derivePosition(response.messages, 'newest') ?? initial.readerAfter
            const currentHead = getNewestCursor(previous)
            return buildState(merged, {
                readerAfter,
                hasMoreAfter: response.page.hasMore || Boolean(readerAfter && currentHead && comparePosition(readerAfter, currentHead) < 0), isLoadingMore: false,
                historyVersion: previous.historyVersion + 1, warning: null
            })
        }, true)
        return true
    } catch (error) {
        if (getState(sessionId).olderGeneration === generation) updateState(sessionId, previous => buildState(previous, {
            isLoadingMore: false, warning: error instanceof Error ? error.message : String(error)
        }))
        return false
    }
}

export function cancelOlderMessageLoad(sessionId: string): void {
    updateState(sessionId, (previous) => {
        if (!previous.isLoadingMore) {
            return previous
        }
        return buildState(previous, {
            olderGeneration: previous.olderGeneration + 1,
            isLoadingMore: false,
            warning: null
        })
    }, true)
}

export function setMessageViewMode(sessionId: string, mode: MessageViewMode): void {
    updateState(sessionId, (previous) => {
        if (previous.viewMode === mode) {
            return previous
        }
        if (mode === 'history') {
            return buildState(previous, { viewMode: 'history' })
        }
        return enterTailMode(previous)
    }, true)
}

export function ingestIncomingMessages(sessionId: string, incoming: DecryptedMessage[]): void {
    if (incoming.length === 0) return
    const api = tailSyncControllers.get(sessionId)?.api
    if (api) getHistoryPageRepository(api).observeMessages(sessionId, incoming)
    updateState(sessionId, (previous) => {
        const visibleIncoming = previous.hasMoreAfter
            ? incoming.filter(message => message.seq === null || previous.messages.some(row => row.id === message.id))
            : incoming
        let merged = mergeIntoWindow(previous, visibleIncoming, {
            advanceTailRevision: true
        })
        if (merged.epoch === null || merged.requiresLatestReset) {
            return merged
        }
        const incomingNewest = derivePosition(incoming, 'newest')
        const currentNewest = getNewestCursor(merged)
        const newest = incomingNewest && (!currentNewest || comparePosition(incomingNewest, currentNewest) > 0)
            ? incomingNewest
            : currentNewest
        merged = buildState(merged, {
            newestPositionAt: newest?.at ?? null,
            newestPositionSeq: newest?.seq ?? null
        })
        return merged
    })
}

/** The store owns cursor selection; warm-up cannot infer coverage from DOM. */
export function getHistoryPreloadRequest(sessionId: string, direction: 'before' | 'after'): HistoryPageRequest | null {
    const state = getState(sessionId)
    if (state.epoch === null || state.requiresLatestReset || state.isSyncingTail) return null
    if (direction === 'before') {
        const cursor = readPosition(state.oldestPositionAt, state.oldestPositionSeq)
        return state.hasMore && cursor ? { direction, epoch: state.epoch, cursor } : null
    }
    const until = getNewestCursor(state)
    return state.hasMoreAfter && state.readerAfter && until
        ? { direction, epoch: state.epoch, cursor: state.readerAfter, until } : null
}

export function getMessageWindowState(sessionId: string): MessageWindowState {
    return getState(sessionId)
}

export function subscribeMessageWindow(sessionId: string, listener: () => void): () => void {
    const subscribers = listeners.get(sessionId) ?? new Set()
    subscribers.add(listener)
    listeners.set(sessionId, subscribers)
    return () => {
        const current = listeners.get(sessionId)
        if (!current) return
        current.delete(listener)
        if (current.size === 0) {
            listeners.delete(sessionId)
        }
    }
}

export function clearMessageWindow(sessionId: string): void {
    const api = tailSyncControllers.get(sessionId)?.api
    if (api) getHistoryPageRepository(api).invalidateSession(sessionId)
    tailSyncControllers.delete(sessionId)
    clearPersistedState(sessionId)
    const previous = states.get(sessionId)
    if (!previous) return
    setState(sessionId, {
        ...createState(sessionId),
        syncGeneration: previous.syncGeneration + 1,
        olderGeneration: previous.olderGeneration + 1
    }, true)
}

function markMessageWindowForLatestReset(sessionId: string, messages: DecryptedMessage[]): void {
    const previous = states.get(sessionId)
    if (!previous) return

    const api = tailSyncControllers.get(sessionId)?.api
    if (api) getHistoryPageRepository(api).invalidateSession(sessionId)
    tailSyncControllers.delete(sessionId)
    clearPersistedState(sessionId)
    setState(sessionId, buildState(previous, {
        messages,
        epoch: null,
        oldestPositionAt: null,
        oldestPositionSeq: null,
        newestPositionAt: null,
        newestPositionSeq: null,
        requiresLatestReset: true,
        preferLatestOnActivation: false,
        isSyncingTail: true,
        isLoadingMore: false,
        warning: null,
        syncGeneration: previous.syncGeneration + 1,
        olderGeneration: previous.olderGeneration + 1
    }), true)
}

/**
 * Mark the current window stale without exposing an empty transcript while a
 * latest snapshot is fetched. The next tail sync sees `requiresLatestReset`
 * and replaces server rows atomically with the authoritative response.
 */
export function invalidateMessageWindow(sessionId: string): void {
    const previous = states.get(sessionId)
    if (!previous) return

    markMessageWindowForLatestReset(sessionId, previous.messages)
}

/**
 * Apply the known local effect of a successful Rewind before the server
 * snapshot arrives. Rewind removes the boundary message and every later row;
 * retaining the earlier prefix keeps the chat usable and lets the current
 * bottom position clamp directly to the new tail.
 */
export function rewindMessageWindow(sessionId: string, messageLocalId: string): void {
    const previous = states.get(sessionId)
    if (!previous) return

    const applied = appliedRewindLocalIds.get(sessionId) ?? new Set<string>()
    if (applied.has(messageLocalId)) return
    applied.add(messageLocalId)
    appliedRewindLocalIds.set(sessionId, applied)

    const boundaryIndex = previous.messages.findIndex((message) => message.localId === messageLocalId)
    if (boundaryIndex < 0) {
        // The boundary may be outside the current latest window. Without a
        // local boundary, retaining rows could show messages removed by the
        // rewind until the authoritative tail sync completes.
        clearMessageWindow(sessionId)
        return
    }

    const messages = previous.messages.slice(0, boundaryIndex)

    markMessageWindowForLatestReset(sessionId, messages)
}

export function seedMessageWindowFromSession(fromSessionId: string, toSessionId: string): void {
    if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return
    const source = getState(fromSessionId)
    const target = getState(toSessionId)
    const seeded = buildState(createState(toSessionId), {
        messages: [...source.messages],
        hasMore: source.hasMore,
        tailRevision: source.tailRevision,
        oldestPositionAt: source.oldestPositionAt,
        oldestPositionSeq: source.oldestPositionSeq,
        requiresLatestReset: true,
        syncGeneration: target.syncGeneration + 1,
        olderGeneration: target.olderGeneration + 1
    })
    tailSyncControllers.delete(toSessionId)
    setState(toSessionId, seeded, true)
}

function isQueuedReconcileCandidate(message: DecryptedMessage): boolean {
    if (!message.localId) return false
    // Interrupted local attempts still need authority lookup: their POST may
    // have been accepted even if its response and tail echo never arrived.
    if (optimisticMessage(message) && message.invokedAt === null && message.status === 'failed') return true
    if (!isQueuedForInvocation(message)) return false
    if (!optimisticMessage(message)) return true
    return message.status === 'queued' || message.status === 'sent'
}

export function getQueuedReconcileCandidateLocalIds(sessionId: string): string[] {
    const localIds = new Set<string>()
    for (const message of getState(sessionId).messages) {
        if (isQueuedReconcileCandidate(message)) {
            localIds.add(message.localId!)
        }
    }
    return [...localIds]
}

export function reconcileQueuedLocalIds(
    sessionId: string,
    candidateLocalIds: string[],
    queuedLocalIds: string[]
): void {
    if (candidateLocalIds.length === 0) return
    const candidates = new Set(candidateLocalIds)
    const queued = new Set(queuedLocalIds)
    updateState(sessionId, (previous) => {
        const messages = previous.messages.filter((message) => {
            if (!message.localId || !candidates.has(message.localId)) return true
            return queued.has(message.localId) || !isQueuedReconcileCandidate(message)
                || (optimisticMessage(message) && message.status === 'failed')
        })
        return messages.length === previous.messages.length
            ? previous
            : buildState(previous, { messages })
    }, true)
}

export function appendOptimisticMessage(sessionId: string, message: DecryptedMessage): void {
    updateState(sessionId, (previous) => {
        return mergeIntoWindow(previous, [message], {
            mode: previous.viewMode === 'history' ? 'prepend' : 'append',
            advanceTailRevision: true
        })
    }, true)
}

export function updateMessageStatus(sessionId: string, localId: string, status: MessageStatus): void {
    if (!localId) return
    updateState(sessionId, (previous) => {
        let changed = false
        const messages = previous.messages.map((message) => {
            if (message.localId !== localId || message.status === status) return message
            changed = true
            return { ...message, status }
        })
        return changed ? buildState(previous, { messages }) : previous
    })
}

export function removeOptimisticMessage(sessionId: string, localId: string): void {
    if (!localId) return
    updateState(sessionId, (previous) => {
        const messages = previous.messages.filter(
            (message) => message.localId !== localId && message.id !== localId
        )
        return messages.length === previous.messages.length
            ? previous
            : buildState(previous, { messages })
    }, true)
}

export function markMessagesIndeterminate(sessionId: string, localIds: string[]): void {
    if (localIds.length === 0) return
    const idSet = new Set(localIds)
    updateState(sessionId, (previous) => {
        let changed = false
        const messages = previous.messages.map((message) => {
            if (!message.localId || !idSet.has(message.localId)
                || (message.deliveryState === 'indeterminate' && message.status !== 'failed')) {
                return message
            }
            changed = true
            return {
                ...message,
                ...(optimisticMessage(message) && message.status === 'failed' ? { status: 'queued' as const } : {}),
                deliveryState: 'indeterminate' as const
            }
        })
        return changed ? buildState(previous, { messages }) : previous
    }, true)
}

export function markMessagesRequeued(sessionId: string, localIds: string[]): void {
    if (localIds.length === 0) return
    const idSet = new Set(localIds)
    updateState(sessionId, (previous) => {
        let changed = false
        const messages = previous.messages.map((message) => {
            if (
                !message.localId
                || !idSet.has(message.localId)
                || (message.deliveryState === undefined && message.queueDismissed !== true
                    && !(optimisticMessage(message) && message.status === 'failed'))
            ) {
                return message
            }
            changed = true
            const {
                deliveryState: _deliveryState,
                queueDismissed: _queueDismissed,
                ...requeued
            } = message
            return optimisticMessage(message) && message.status === 'failed' ? { ...requeued, status: 'queued' as const } : requeued
        })
        return changed ? buildState(previous, { messages }) : previous
    }, true)
}

export function markMessagesConsumed(
    sessionId: string,
    localIds: string[],
    invokedAt: number,
    steered?: boolean
): void {
    if (localIds.length === 0) return
    const idSet = new Set(localIds)
    updateState(sessionId, (previous) => {
        let changed = false
        const updated = previous.messages.map((message) => {
            if (!message.localId || !idSet.has(message.localId)
                || (message.status === 'failed' && !optimisticMessage(message))) {
                return message
            }
            const needsStatus = message.status !== 'sent'
            const needsInvokedAt = message.invokedAt === null
            const needsSteered = steered === true && message.steered !== true
            const needsClearDismiss = message.queueDismissed === true
            if (!needsStatus && !needsInvokedAt && !needsSteered && !needsClearDismiss) return message
            changed = true
            const { deliveryState: _deliveryState, queueDismissed: _queueDismissed, ...withoutClientHold } = message
            return {
                ...withoutClientHold,
                ...(needsStatus ? { status: 'sent' as MessageStatus } : {}),
                ...(needsInvokedAt ? { invokedAt } : {}),
                ...(needsSteered ? { steered: true } : {})
            }
        })
        if (!changed) return previous
        return buildState(previous, {
            messages: mergeMessages([], updated),
            tailRevision: previous.tailRevision + 1
        })
    })
}
