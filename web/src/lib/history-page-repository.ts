import { ApiError, type ApiClient } from '@/api/client'
import type { MessageContextResponse } from '@hapi/protocol/apiTypes'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'

export type HistoryPosition = { at: number; seq: number }
export type HistoryPageRequest =
    | { direction: 'latest' }
    | { direction: 'before'; cursor: HistoryPosition; epoch: number }
    | { direction: 'after'; cursor: HistoryPosition; until: HistoryPosition; epoch: number }

type Coverage = {
    start: HistoryPosition | null // null is the known beginning of history.
    end: HistoryPosition
    startIncluded: boolean
    endIncluded: boolean
}

type MessageEntry = { message: DecryptedMessage; bytes: number; references: number; revision: number }
type PageEntry = {
    sessionId: string
    epoch: number
    ids: string[]
    request: HistoryPageRequest
    page: MessagesResponse['page']
    coverage: Coverage | null
    pins: number
    revision: number
    bytes: number
}

export class HistoryReadInvalidated extends Error {
    constructor() { super('History read was invalidated'); this.name = 'HistoryReadInvalidated' }
}

// Repository inputs are persisted API rows. Optimistic, seq=null drafts remain
// in the existing outbox and do not participate in historical coverage.
const position = (message: DecryptedMessage): HistoryPosition => ({ at: message.invokedAt ?? message.createdAt, seq: message.seq! })
const compare = (a: HistoryPosition, b: HistoryPosition) => a.at - b.at || a.seq - b.seq
const bytes = (message: DecryptedMessage) => new TextEncoder().encode(JSON.stringify(message)).byteLength
const cursor = (at: number | null, seq: number | null): HistoryPosition | null => at !== null && seq !== null ? { at, seq } : null

function coverageFor(request: HistoryPageRequest, page: MessagesResponse['page']): Coverage | null {
    if (request.direction === 'before' && page.direction === 'before') {
        const start = cursor(page.nextBeforeAt, page.nextBeforeSeq)
        if (page.hasMore && !start) return null
        return { start: page.hasMore ? start : null, end: request.cursor, startIncluded: true, endIncluded: false }
    }
    const head = cursor(page.snapshotHeadAt, page.snapshotHeadSeq)
    if (!head) return null
    if (request.direction === 'after' && page.direction === 'after') {
        const end = cursor(page.nextAfterAt, page.nextAfterSeq)
        return end ? { start: request.cursor, end, startIncluded: false, endIncluded: true } : null
    }
    if (page.direction === 'latest') {
        const start = cursor(page.nextBeforeAt, page.nextBeforeSeq)
        if (page.hasMore && !start) return null
        return { start: page.hasMore ? start : null, end: head, startIncluded: true, endIncluded: true }
    }
    return null
}

/** One repository belongs to one authenticated ApiClient/authorization lifetime.
 * invalidate() releases all data and prevents earlier responses from refilling it.
 * Stored bytes estimate serialized payload, not browser heap or decoded media. */
export class HistoryPageRepository {
    private readonly pages = new Map<string, PageEntry>()
    private readonly messages = new Map<string, MessageEntry>()
    private readonly pending = new Map<string, Promise<MessagesResponse>>()
    private readonly reads = new Map<string, { pending: number; acceptedRevision: number; updates: Map<string, DecryptedMessage>; updateBytes: number }>()
    private readonly epochs = new Map<string, number>()
    private readonly sessionSizes = new Map<string, number>()
    private readonly sessionPages = new Map<string, number>()
    private totalBytes = 0
    private readonly sessionGenerations = new Map<string, number>()
    private generation = 0
    private revision = 0

    constructor(
        private readonly api: Pick<ApiClient, 'getMessages'>,
        private readonly limits = { totalBytes: 32 * 1024 * 1024, sessionBytes: 8 * 1024 * 1024, sessions: 8 },
    ) {}

    private key(sessionId: string, request: HistoryPageRequest) {
        return JSON.stringify(request.direction === 'latest'
            ? [sessionId, 'latest']
            : request.direction === 'before'
                ? [sessionId, 'before', request.epoch, request.cursor.at, request.cursor.seq]
                : [sessionId, 'after', request.epoch, request.cursor.at, request.cursor.seq, request.until.at, request.until.seq])
    }

    private messageKey(sessionId: string, id: string) { return JSON.stringify([sessionId, id]) }

    private touch(key: string, page: PageEntry) {
        this.pages.delete(key)
        this.pages.set(key, page)
    }

    private response(page: PageEntry): MessagesResponse {
        return {
            messages: page.ids.map(id => this.messages.get(this.messageKey(page.sessionId, id))!.message),
            page: page.page,
        }
    }

    invalidate(): void {
        this.generation++
        this.pages.clear()
        this.messages.clear()
        this.epochs.clear()
        this.pending.clear()
        for (const reads of this.reads.values()) reads.updates.clear()
        this.reads.clear()
        this.sessionGenerations.clear()
        this.sessionSizes.clear()
        this.sessionPages.clear()
        this.totalBytes = 0
    }

    private remove(key: string): void {
        const page = this.pages.get(key)
        if (!page) return
        this.pages.delete(key)
        this.account(page.sessionId, -page.bytes)
        for (const id of page.ids) {
            const messageKey = this.messageKey(page.sessionId, id)
            const entry = this.messages.get(messageKey)!
            if (--entry.references === 0) {
                this.messages.delete(messageKey)
                this.account(page.sessionId, -entry.bytes)
            }
        }
        const count = this.sessionPages.get(page.sessionId)! - 1
        if (count === 0) {
            this.sessionPages.delete(page.sessionId)
            if ((this.sessionSizes.get(page.sessionId) ?? 0) === 0) this.sessionSizes.delete(page.sessionId)
        } else this.sessionPages.set(page.sessionId, count)
    }

    private clearSession(sessionId: string): void {
        for (const [key, page] of this.pages) if (page.sessionId === sessionId) this.remove(key)
    }

    invalidateSession(sessionId: string): void {
        this.sessionGenerations.set(sessionId, (this.sessionGenerations.get(sessionId) ?? 0) + 1)
        this.releaseUpdates(sessionId)
        this.clearSession(sessionId)
        this.epochs.delete(sessionId)
        this.reads.delete(sessionId)
        for (const key of this.pending.keys()) {
            if (JSON.parse(key)[0] === sessionId) this.pending.delete(key)
        }
    }

    private releaseUpdates(sessionId: string): void {
        const reads = this.reads.get(sessionId)
        if (!reads) return
        this.account(sessionId, -reads.updateBytes)
        reads.updates.clear()
        reads.updateBytes = 0
    }

    /** Reconcile cached rows with authoritative live updates. Moving a row
     * invalidates query coverage; payload-only changes preserve it. */
    observeMessages(sessionId: string, incoming: readonly DecryptedMessage[]): void {
        const revision = ++this.revision
        for (const message of incoming) {
            const entry = this.messages.get(this.messageKey(sessionId, message.id))
            const reads = this.reads.get(sessionId)
            if (reads && message.seq !== null) {
                const previous = reads.updates.get(message.id)
                const change = bytes(message) - (previous ? bytes(previous) : 0)
                reads.updates.set(message.id, message)
                reads.updateBytes += change
                this.account(sessionId, change)
                if (this.totalBytes > this.limits.totalBytes || (this.sessionSizes.get(sessionId) ?? 0) > this.limits.sessionBytes) {
                    this.invalidateSession(sessionId)
                    return
                }
            }
            if (!entry) continue
            if (message.seq === null || compare(position(entry.message), position(message)) !== 0) {
                this.invalidateSession(sessionId)
                return
            }
            const size = bytes(message)
            this.account(sessionId, size - entry.bytes)
            entry.message = message
            entry.bytes = size
            entry.revision = revision
        }
        this.trim()
    }

    /** An authoritative epoch change invalidates coverage and the associated pins. */
    observeEpoch(sessionId: string, epoch: number): void {
        const previous = this.epochs.get(sessionId)
        if (previous !== undefined && previous !== epoch) {
            this.releaseUpdates(sessionId)
            this.clearSession(sessionId)
        }
        this.epochs.set(sessionId, epoch)
    }

    stats() {
        return { totalBytes: this.totalBytes, sessionBytes: new Map(this.sessionSizes), sessions: this.sessionPages.size,
            pages: this.pages.size, messages: this.messages.size }
    }

    private account(sessionId: string, change: number) {
        this.totalBytes += change
        this.sessionSizes.set(sessionId, (this.sessionSizes.get(sessionId) ?? 0) + change)
    }

    private trim(): void {
        let state = this.stats()
        for (const [key, page] of this.pages) {
            const overSession = (state.sessionBytes.get(page.sessionId) ?? 0) > this.limits.sessionBytes
            const overGlobal = state.totalBytes > this.limits.totalBytes || state.sessions > this.limits.sessions
            if (!overGlobal && [...state.sessionBytes.values()].every(size => size <= this.limits.sessionBytes)) break
            if (page.pins || (!overSession && !overGlobal)) continue
            this.remove(key)
            state = this.stats()
        }
    }

    /** Pin the active page before navigation; release when its reading interval exits. */
    pin(sessionId: string, request: HistoryPageRequest): () => void {
        const page = this.pages.get(this.key(sessionId, request))
        if (!page) return () => {}
        page.pins++
        return () => {
            if (page.pins > 0) page.pins--
            this.trim()
        }
    }

    getCached(sessionId: string, request: HistoryPageRequest): MessagesResponse | null {
        const key = this.key(sessionId, request)
        const page = this.pages.get(key)
        if (page) {
            this.touch(key, page)
            return this.response(page)
        }
        if (request.direction === 'latest') return null
        // A direction change has different query keys. Reuse only an interval
        // whose original successful queries prove there are no cache holes.
        const pages = [...this.pages.values()].filter(entry => entry.sessionId === sessionId
            && entry.epoch === request.epoch && entry.coverage)
        const candidates = new Map<string, DecryptedMessage>()
        for (const entry of pages) for (const id of entry.ids) {
            const row = this.messages.get(this.messageKey(sessionId, id))!.message
            const point = position(row)
            if (request.direction === 'before' ? compare(point, request.cursor) < 0
                : compare(point, request.cursor) > 0 && compare(point, request.until) <= 0) candidates.set(id, row)
        }
        const sorted = [...candidates.values()].sort((a, b) => compare(position(a), position(b)))
        const selected = request.direction === 'before' ? sorted.slice(-200) : sorted.slice(0, 200)
        if (!selected.length) return null
        const first = position(selected[0]), last = position(selected[selected.length - 1])
        const covered = this.readCachedRange(sessionId, request.epoch,
            request.direction === 'before' ? first : request.cursor,
            request.direction === 'before' ? request.cursor : last)
        if (!covered) return null
        const head = request.direction === 'after' ? request.until : pages.reduce<HistoryPosition | null>((latest, entry) => {
            const point = cursor(entry.page.snapshotHeadAt, entry.page.snapshotHeadSeq)
            return point && (!latest || compare(point, latest) > 0) ? point : latest
        }, null)
        if (!head) return null
        const beginsHistory = pages.some(entry => {
            const begin = cursor(entry.page.nextBeforeAt, entry.page.nextBeforeSeq)
            return entry.coverage!.start === null && begin !== null && compare(begin, first) === 0
        })
        return { messages: selected, page: {
            direction: request.direction, epoch: request.epoch, reset: false, limit: 200,
            nextBeforeAt: first.at, nextBeforeSeq: first.seq, nextAfterAt: last.at, nextAfterSeq: last.seq,
            snapshotHeadAt: head.at, snapshotHeadSeq: head.seq,
            hasMore: request.direction === 'before' ? !beginsHistory : compare(last, head) < 0,
        } }
    }

    /** Context reads obey the same auth generation boundary as page reads. */
    async readContext(sessionId: string, load: () => Promise<MessageContextResponse>): Promise<MessageContextResponse> {
        const generation = this.generation
        const sessionGeneration = this.sessionGenerations.get(sessionId) ?? 0
        try {
            const response = await load()
            if (generation !== this.generation || sessionGeneration !== (this.sessionGenerations.get(sessionId) ?? 0)) throw new HistoryReadInvalidated()
            return response
        } catch (error) {
            if (generation === this.generation && sessionGeneration === (this.sessionGenerations.get(sessionId) ?? 0)
                && error instanceof ApiError && (error.status === 401 || error.status === 403)) this.invalidate()
            throw error
        }
    }

    async read(sessionId: string, request: HistoryPageRequest, options: { refresh?: boolean } = {}): Promise<MessagesResponse> {
        const key = this.key(sessionId, request)
        if (!options.refresh) {
            const cached = this.getCached(sessionId, request)
            if (cached) return cached
        }
        const inFlight = this.pending.get(key)
        if (inFlight) return inFlight
        const generation = this.generation
        const sessionGeneration = this.sessionGenerations.get(sessionId) ?? 0
        const revision = ++this.revision
        // Acceptance order must survive payload eviction, but is only needed
        // while concurrent reads exist. Release this metadata with the last read.
        const reads = this.reads.get(sessionId) ?? { pending: 0, acceptedRevision: 0, updates: new Map<string, DecryptedMessage>(), updateBytes: 0 }
        reads.pending++
        this.reads.set(sessionId, reads)
        const epochAtStart = this.epochs.get(sessionId)
        const promise = this.api.getMessages(sessionId, request.direction === 'latest'
            ? { limit: 200, bounded: true }
            : request.direction === 'before'
                ? { beforeAt: request.cursor.at, beforeSeq: request.cursor.seq, epoch: request.epoch, limit: 200, bounded: true }
                : { afterAt: request.cursor.at, afterSeq: request.cursor.seq, untilAt: request.until.at, untilSeq: request.until.seq, epoch: request.epoch, limit: 200, bounded: true }
        ).then(response => {
            if (generation !== this.generation || sessionGeneration !== (this.sessionGenerations.get(sessionId) ?? 0)) throw new HistoryReadInvalidated()
            if (revision < reads.acceptedRevision) throw new HistoryReadInvalidated()
            response = { ...response, messages: response.messages.map(message => {
                const live = reads.updates.get(message.id)
                if (!live) return message
                if (compare(position(live), position(message)) !== 0) throw new HistoryReadInvalidated()
                return live
            }) }
            const known = this.epochs.get(sessionId)
            if (known !== undefined && known !== epochAtStart && response.page.epoch !== known) throw new HistoryReadInvalidated()
            this.observeEpoch(sessionId, response.page.epoch)
            // A reset is a latest snapshot, never proof of the original cursor range.
            const storedRequest: HistoryPageRequest = response.page.reset ? { direction: 'latest' } : request
            const storedKey = this.key(sessionId, storedRequest)
            const previousPage = this.pages.get(storedKey)
            // Different cursor requests can overlap or reset into the latest key.
            // Reject an older read rather than exposing a superseded snapshot to callers.
            if (previousPage && previousPage.revision > revision) throw new HistoryReadInvalidated()
            if (response.messages.some(message => {
                const entry = this.messages.get(this.messageKey(sessionId, message.id))
                return entry && entry.revision > revision && entry.message !== reads.updates.get(message.id)
            })) {
                throw new HistoryReadInvalidated()
            }
            this.remove(storedKey)
            const incoming = new Map(response.messages.map(message => [message.id, message]))
            const ids = [...incoming.keys()]
            for (const message of incoming.values()) {
                const messageKey = this.messageKey(sessionId, message.id)
                const existing = this.messages.get(messageKey)
                const size = bytes(message)
                if (existing) {
                    this.account(sessionId, size - existing.bytes)
                    existing.message = message
                    existing.bytes = size
                    existing.references++
                    existing.revision = Math.max(existing.revision, revision)
                } else {
                    this.messages.set(messageKey, { message, bytes: size, references: 1, revision })
                    this.account(sessionId, size)
                }
            }
            const pageBytes = new TextEncoder().encode(JSON.stringify({ sessionId, ids, request: storedRequest, page: response.page })).byteLength
            this.account(sessionId, pageBytes)
            this.sessionPages.set(sessionId, (this.sessionPages.get(sessionId) ?? 0) + 1)
            this.pages.set(storedKey, Object.assign(previousPage ?? { pins: 0 }, {
                sessionId, epoch: response.page.epoch, ids, request: storedRequest, revision, bytes: pageBytes,
                page: response.page, coverage: coverageFor(storedRequest, response.page),
            }))
            this.trim()
            reads.acceptedRevision = revision
            return response
        }).catch(error => {
            if (generation === this.generation && sessionGeneration === (this.sessionGenerations.get(sessionId) ?? 0) && error instanceof ApiError && (error.status === 401 || error.status === 403)) this.invalidate()
            throw error
        }).finally(() => {
            if (this.pending.get(key) === promise) this.pending.delete(key)
            if (--reads.pending === 0 && this.reads.get(sessionId) === reads) {
                this.releaseUpdates(sessionId)
                this.reads.delete(sessionId)
            }
        })
        this.pending.set(key, promise)
        return promise
    }

    /** A directory page can become the reader window without another request. */
    findCachedMessagePage(sessionId: string, epoch: number, messageId: string): MessagesResponse | null {
        for (const [key, page] of this.pages) {
            if (page.sessionId === sessionId && page.epoch === epoch && page.ids.includes(messageId)) {
                this.touch(key, page)
                return this.response(page)
            }
        }
        return null
    }

    /** Return an inclusive interval only if successful query coverage proves it
     * continuous. This also reuses before pages when the user reads downward. */
    readCachedRange(sessionId: string, epoch: number, start: HistoryPosition, end: HistoryPosition): DecryptedMessage[] | null {
        const candidates = [...this.pages.entries()].filter(([, page]) => page.sessionId === sessionId && page.epoch === epoch && page.coverage)
        candidates.sort(([, a], [, b]) => {
            const first = a.coverage!.start, second = b.coverage!.start
            return first === null ? -1 : second === null ? 1 : compare(first, second)
        })
        let frontier = start
        let frontierIncluded = false
        const used: Array<[string, PageEntry]> = []
        for (const candidate of candidates) {
            const range = candidate[1].coverage!
            if (compare(range.end, frontier) < 0) continue
            const join = range.start === null ? -1 : compare(range.start, frontier)
            if (join > 0 || (join === 0 && !range.startIncluded && !frontierIncluded)) continue
            used.push(candidate)
            if (compare(range.end, frontier) > 0) {
                frontier = range.end
                frontierIncluded = range.endIncluded
            } else frontierIncluded ||= range.endIncluded
            if (compare(frontier, end) > 0 || (compare(frontier, end) === 0 && frontierIncluded)) {
                const rows = new Map<string, DecryptedMessage>()
                for (const [key, page] of used) {
                    this.touch(key, page)
                    for (const id of page.ids) {
                        const message = this.messages.get(this.messageKey(sessionId, id))!.message
                        if (compare(position(message), start) >= 0 && compare(position(message), end) <= 0) rows.set(id, message)
                    }
                }
                return [...rows.values()].sort((a, b) => compare(position(a), position(b)))
            }
        }
        return null
    }
}

// Cache ownership follows the authenticated client, not a mounted sidebar.
const repositories = new WeakMap<ApiClient, HistoryPageRepository>()

export function getHistoryPageRepository(api: ApiClient): HistoryPageRepository {
    let repository = repositories.get(api)
    if (!repository) {
        repository = new HistoryPageRepository(api)
        repositories.set(api, repository)
    }
    return repository
}

export function invalidateHistoryPages(api: ApiClient): void {
    repositories.get(api)?.invalidate()
}
