import type { SessionReadState } from '@hapi/protocol/schemas'
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'hapi.sessionLastSeen.v1'
const MANUAL_UNREAD_KEY = 'hapi.sessionManualUnread.v1'
const BASELINE_KEY = 'hapi.sessionLastSeenBaseline.v1'
const OUTBOX_KEY = 'hapi.sessionReadOutbox.v1'
const CHANGE_EVENT = 'hapi.sessionLastSeen.changed'

let changeVersion = 0

type LastSeenStore = Record<string, number>
type ManualUnreadStore = Record<string, number>

function getLocalStorage(): Storage | null {
    if (typeof window === 'undefined') {
        return null
    }
    try {
        return window.localStorage
    } catch {
        return null
    }
}

function readStore(): LastSeenStore {
    const storage = getLocalStorage()
    if (!storage) {
        return {}
    }

    try {
        const raw = storage.getItem(scopedKey(STORAGE_KEY))
        if (!raw) {
            return {}
        }
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') {
            return {}
        }
        return parsed as LastSeenStore
    } catch {
        return {}
    }
}

function readManualUnreadStore(): ManualUnreadStore {
    const storage = getLocalStorage()
    if (!storage) {
        return {}
    }

    try {
        const raw = storage.getItem(scopedKey(MANUAL_UNREAD_KEY))
        if (!raw) {
            return {}
        }
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') {
            return {}
        }
        return parsed as ManualUnreadStore
    } catch {
        return {}
    }
}

function writeStore(store: LastSeenStore): boolean {
    const storage = getLocalStorage()
    if (!storage) {
        return false
    }
    try {
        storage.setItem(scopedKey(STORAGE_KEY), JSON.stringify(store))
        return true
    } catch {
        // Ignore storage errors
        return false
    }
}

function writeManualUnreadStore(store: ManualUnreadStore): boolean {
    const storage = getLocalStorage()
    if (!storage) {
        return false
    }
    try {
        storage.setItem(scopedKey(MANUAL_UNREAD_KEY), JSON.stringify(store))
        return true
    } catch {
        // Ignore storage errors
        return false
    }
}

function notifyStoreChanged(): void {
    changeVersion += 1
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event(CHANGE_EVENT))
    }
}

function subscribeToStoreChanges(listener: () => void): () => void {
    if (typeof window === 'undefined') {
        return () => {}
    }

    const handleStorage = (event: StorageEvent) => {
        if (event.key !== scopedKey(STORAGE_KEY) && event.key !== scopedKey(MANUAL_UNREAD_KEY)) {
            return
        }
        changeVersion += 1
        listener()
    }

    window.addEventListener(CHANGE_EVENT, listener)
    window.addEventListener('storage', handleStorage)
    return () => {
        window.removeEventListener(CHANGE_EVENT, listener)
        window.removeEventListener('storage', handleStorage)
    }
}

function getStoreChangeVersion(): number {
    return changeVersion
}

/** Re-render consumers when same-tab read-state changes. */
export function useSessionLastSeenVersion(): number {
    return useSyncExternalStore(
        subscribeToStoreChanges,
        getStoreChangeVersion,
        () => 0
    )
}

export function getSessionLastSeenAt(sessionId: string): number {
    const seenAt = readStore()[sessionId] ?? 0
    const manual = getSessionManualUnreadAt(sessionId)
    return manual === null ? seenAt : Math.min(seenAt, manual - 1)
}

/** Timestamp of the activity the operator explicitly marked unread, if any. */
export function getSessionManualUnreadAt(sessionId: string): number | null {
    const value = readManualUnreadStore()[sessionId]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** One localStorage read/parse for bulk filters (e.g. unread-only lens). */
export function getSessionLastSeenSnapshot(): Readonly<Record<string, number>> {
    const store = readStore()
    for (const [id, manual] of Object.entries(readManualUnreadStore())) store[id] = Math.min(store[id] ?? 0, manual - 1)
    return store
}

type SessionReadStateInput = {
    id: string
    updatedAt: number
}

function latestSessionUpdates(sessions: Iterable<SessionReadStateInput>): Map<string, number> {
    const latest = new Map<string, number>()
    for (const session of sessions) {
        if (!session.id || !Number.isFinite(session.updatedAt)) {
            continue
        }
        const current = latest.get(session.id)
        if (current === undefined || session.updatedAt > current) {
            latest.set(session.id, session.updatedAt)
        }
    }
    return latest
}

function hasUnreadActivity(
    sessionId: string,
    updatedAt: number,
    store: LastSeenStore,
    manualUnreadStore: ManualUnreadStore
): boolean {
    const lastSeenAt = store[sessionId]
    const manualUnreadAt = manualUnreadStore[sessionId]
    return updatedAt > (typeof lastSeenAt === 'number' && Number.isFinite(lastSeenAt) ? lastSeenAt : 0)
        || manualUnreadAt === updatedAt
}

/** Count unread sessions in the supplied list using one localStorage snapshot. */
export function getUnreadSessionCount(sessions: Iterable<SessionReadStateInput>): number {
    const latest = latestSessionUpdates(sessions)
    const store = readStore()
    const manualUnreadStore = readManualUnreadStore()
    let count = 0
    for (const [sessionId, updatedAt] of latest) {
        if (hasUnreadActivity(sessionId, updatedAt, store, manualUnreadStore)) {
            count += 1
        }
    }
    return count
}

/** Mark all supplied unread sessions as seen and synchronize the user cursor. Returns changed count. */
export function markAllSessionsSeen(sessions: Iterable<SessionReadStateInput>): number {
    const latest = latestSessionUpdates(sessions)
    if (latest.size === 0) {
        return 0
    }

    const store = readStore()
    const manualUnreadStore = readManualUnreadStore()
    let count = 0
    let seenChanged = false
    let manualUnreadChanged = false

    for (const [sessionId, updatedAt] of latest) {
        if (!hasUnreadActivity(sessionId, updatedAt, store, manualUnreadStore)) {
            continue
        }

        count += 1
        const currentSeenAt = store[sessionId]
        const nextSeenAt = Math.max(
            typeof currentSeenAt === 'number' && Number.isFinite(currentSeenAt) ? currentSeenAt : 0,
            updatedAt
        )
        if (store[sessionId] !== nextSeenAt) {
            store[sessionId] = nextSeenAt
            seenChanged = true
        }
        if (Object.prototype.hasOwnProperty.call(manualUnreadStore, sessionId)) {
            delete manualUnreadStore[sessionId]
            manualUnreadChanged = true
        }
    }

    if (count === 0) {
        return 0
    }

    const seenWritten = !seenChanged || writeStore(store)
    const manualUnreadWritten = !manualUnreadChanged || writeManualUnreadStore(manualUnreadStore)
    if (seenWritten || manualUnreadWritten) {
        notifyStoreChanged()
    }
    for (const [sessionId, seenAt] of latest) enqueueReadState(sessionId, { seenAt, manualUnreadAt: null }, 'read')
    return count
}

export function initializeSessionLastSeen(scope: string, sessions: Iterable<{ id: string; updatedAt: number }>): void {
    if (syncReadState) return
    const storage = getLocalStorage()
    if (!storage) {
        return
    }

    try {
        const baselineKey = `${scopedKey(BASELINE_KEY)}:${scope}`
        if (storage.getItem(baselineKey) === '1') {
            return
        }
        const store = readStore()
        for (const session of sessions) {
            store[session.id] ??= session.updatedAt
        }
        storage.setItem(scopedKey(STORAGE_KEY), JSON.stringify(store))
        storage.setItem(baselineKey, '1')
    } catch {
        // Ignore storage errors
    }
}

export function markSessionSeen(sessionId: string, seenAt: number): void {
    if (!sessionId) {
        return
    }
    const store = readStore()
    const manualUnreadStore = readManualUnreadStore()
    const nextSeenAt = Math.max(store[sessionId] ?? 0, seenAt)
    const seenChanged = store[sessionId] !== nextSeenAt
    const manualUnreadAt = manualUnreadStore[sessionId]
    const manualUnreadChanged = typeof manualUnreadAt === 'number'
        && Number.isFinite(manualUnreadAt)
        && nextSeenAt >= manualUnreadAt
    if (!seenChanged && !manualUnreadChanged) {
        return
    }

    if (seenChanged) {
        store[sessionId] = nextSeenAt
    }
    if (manualUnreadChanged) {
        delete manualUnreadStore[sessionId]
    }

    const seenWritten = !seenChanged || writeStore(store)
    const manualUnreadWritten = !manualUnreadChanged || writeManualUnreadStore(manualUnreadStore)
    if (seenWritten || manualUnreadWritten) {
        notifyStoreChanged()
    }
    enqueueReadState(sessionId, { seenAt: nextSeenAt, manualUnreadAt: null }, 'read')
}

/** Move the local watermark just behind the current activity and remember the explicit action. */
export function markSessionUnread(sessionId: string, updatedAt: number): void {
    if (!sessionId || !Number.isFinite(updatedAt)) {
        return
    }

    const store = readStore()
    const manualUnreadStore = readManualUnreadStore()
    const unreadBefore = updatedAt - 1
    const currentSeenAt = store[sessionId]
    const seenChanged = !(typeof currentSeenAt === 'number' && currentSeenAt <= unreadBefore)
    const manualUnreadChanged = manualUnreadStore[sessionId] !== updatedAt
    if (!seenChanged && !manualUnreadChanged) {
        return
    }

    if (seenChanged) {
        store[sessionId] = unreadBefore
    }
    if (manualUnreadChanged) {
        manualUnreadStore[sessionId] = updatedAt
    }

    const seenWritten = !seenChanged || writeStore(store)
    const manualUnreadWritten = !manualUnreadChanged || writeManualUnreadStore(manualUnreadStore)
    if (seenWritten || manualUnreadWritten) {
        notifyStoreChanged()
    }
    enqueueReadState(sessionId, { seenAt: store[sessionId] ?? 0, manualUnreadAt: updatedAt }, 'unread')
}

let storageScope = ''
let syncEpoch = 0
let intentSequence = 0
type ReadInput = { seenAt: number; manualUnreadAt: number | null }
type ReadIntent = ReadInput & { kind: 'read' | 'unread'; sequence: number }
type ReadSync = (sessionId: string, input: ReadInput & { expectedVersion: number }) => Promise<{ applied: boolean; state: SessionReadState }>
let syncReadState: ReadSync | undefined
const serverStates = new Map<string, SessionReadState>()
const pendingReadStates = new Map<string, ReadIntent>()
const inFlight = new Set<string>()
function scopedKey(key: string): string { return storageScope ? `${key}:${storageScope}` : key }

function persistReadIntents(): void {
    try { getLocalStorage()?.setItem(scopedKey(OUTBOX_KEY), JSON.stringify(Object.fromEntries(pendingReadStates))) } catch { /* localStorage may be unavailable */ }
}

export function disconnectSessionReadSync(): void {
    syncEpoch++
    syncReadState = undefined
    serverStates.clear(); pendingReadStates.clear(); inFlight.clear()
}

export function configureSessionReadSync(scope: string, sync: ReadSync): void {
    if (scope !== storageScope || !syncReadState) {
        syncEpoch++; storageScope = scope
        serverStates.clear(); pendingReadStates.clear(); inFlight.clear()
        try {
            const outbox = JSON.parse(getLocalStorage()?.getItem(scopedKey(OUTBOX_KEY)) ?? '{}') as Record<string, ReadIntent>
            for (const [id, intent] of Object.entries(outbox)) pendingReadStates.set(id, { ...intent, sequence: ++intentSequence })
        } catch { /* An unavailable local cache does not block server synchronization. */ }
        queueMicrotask(notifyStoreChanged)
    }
    syncReadState = sync
}

function writeRemoteState(sessionId: string, state: ReadInput): void {
    const seen = readStore(); const manual = readManualUnreadStore()
    seen[sessionId] = state.seenAt
    if (state.manualUnreadAt === null) delete manual[sessionId]
    else manual[sessionId] = state.manualUnreadAt
    writeStore(seen); writeManualUnreadStore(manual); notifyStoreChanged()
}

export function acceptSessionReadState(sessionId: string, state: SessionReadState): void {
    if (state.version <= (serverStates.get(sessionId)?.version ?? -1)) return
    serverStates.set(sessionId, state)
    if (!pendingReadStates.has(sessionId)) writeRemoteState(sessionId, state)
}

export function hydrateSessionReadStates(states: Record<string, SessionReadState>, scope = storageScope): void {
    if (scope !== storageScope || !syncReadState) return
    const seen = readStore(); const manual = readManualUnreadStore()
    let changed = false
    for (const [id, state] of Object.entries(states)) {
        if (state.version <= (serverStates.get(id)?.version ?? -1)) continue
        serverStates.set(id, state)
        if (pendingReadStates.has(id)) continue
        seen[id] = state.seenAt
        if (state.manualUnreadAt === null) delete manual[id]
        else manual[id] = state.manualUnreadAt
        changed = true
    }
    if (changed) { writeStore(seen); writeManualUnreadStore(manual); notifyStoreChanged() }
    // Recover pending optimistic reads after offline/reconnect. No model input is sent.
    for (const id of pendingReadStates.keys()) void flushReadState(id)
}

function enqueueReadState(sessionId: string, input: ReadInput, kind: ReadIntent['kind']): void {
    if (!syncReadState) return
    pendingReadStates.set(sessionId, { ...input, kind, sequence: ++intentSequence })
    persistReadIntents()
    void flushReadState(sessionId)
}

async function flushReadState(sessionId: string): Promise<void> {
    if (!syncReadState || inFlight.has(sessionId)) return
    const epoch = syncEpoch; const sync = syncReadState
    inFlight.add(sessionId)
    try {
        // Serialize local actions. CAS prevents a stale automatic read from
        // clearing an explicit unread action made on another device.
        for (let attempt = 0; epoch === syncEpoch && attempt < 5; attempt++) {
            const intent = pendingReadStates.get(sessionId)
            if (!intent) break
            const expectedVersion = serverStates.get(sessionId)?.version ?? 0
            const result = await sync(sessionId, { expectedVersion, seenAt: intent.seenAt, manualUnreadAt: intent.manualUnreadAt })
            if (epoch !== syncEpoch) return
            acceptSessionReadState(sessionId, result.state)
            const latest = pendingReadStates.get(sessionId)
            if (latest?.sequence !== intent.sequence) continue
            if (!result.applied && intent.kind === 'unread') continue
            if (!result.applied && result.state.manualUnreadAt === null && intent.seenAt > result.state.seenAt) continue
            pendingReadStates.delete(sessionId)
            persistReadIntents()
            writeRemoteState(sessionId, result.state)
        }
    } catch { /* Keep optimistic intent for the next successful reconnect snapshot. */ }
    finally { if (epoch === syncEpoch) inFlight.delete(sessionId) }
}
