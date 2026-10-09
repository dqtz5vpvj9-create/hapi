import { NativeChatProjection } from '../src/chat/nativeProjection'
import { NativeCodexThread } from '../src/components/AssistantChat/NativeCodexThread'
import { nativeReplayRows, nativeReplayQuestion, type NativeReplayStatus } from './native-chat-replay'
import { useMemo, useRef, useState, useLayoutEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../src/index.css'
import { ApiError, type ApiClient } from '../src/api/client'
import type { DecryptedMessage, MessagesResponse, Session } from '../src/types/api'
import { I18nProvider } from '../src/lib/i18n-context'
import { useMessages } from '../src/hooks/queries/useMessages'
import { normalizeDecryptedMessage } from '../src/chat/normalize'
import { reduceChatBlocks } from '../src/chat/reducer'
import { reconcileChatBlocks } from '../src/chat/reconcile'
import { buildVisibleChatBlocks } from '../src/chat/toolGroups'
import { isQueuedForInvocation } from '../src/lib/messages'
import { useHappyRuntime } from '../src/lib/assistant-runtime'
import { useViewportHeight } from '../src/hooks/useViewportHeight'
import { HappyThread } from '../src/components/AssistantChat/HappyThread'
import type { ChatBlock } from '../src/chat/types'
import { getMessageWindowState, ingestIncomingMessages } from '../src/lib/message-window-store'
import { getHistoryPageRepository } from '../src/lib/history-page-repository'
import { captureReadingAnchor, type ReadingAnchor } from '../src/lib/reading-anchor'
import { buildConversationOutline } from '../src/chat/outline'
import { extractConversationOutlineLabel } from '@hapi/protocol/conversationOutline'

// Drives the real message-window store + chat pipeline + HappyThread against a
// fake paginated message API, so e2e tests can exercise older-history loading
// without a hub. `window.__probe.requests` records every API call for
// assertions (e.g. "exactly one older page per top-approach").

const SESSION_ID = 'history-load-fixture'
let activeSessionId = SESSION_ID
const TOTAL_MESSAGES = 1200
const BASE_AT = 1_700_000_000_000

type Probe = {
    evictHistoryPayloads: () => void
    holdContext: () => void
    releaseContext: () => void
    holdAfter: (minimumSeq?: number) => void
    releaseAfter: () => void
    appendRemoteMessage: (deliver?: boolean) => void

    holdMedia: () => void
    releaseMedia: () => void
    mediaReads: number
    finishedOutlineRequests: number
    finishedRequests: number
    remoteRewindTo: (seq: number) => Promise<void>
    remoteEditMessage: (seq: number, text: string) => void
    requests: { direction: string; afterSeq?: number | null; beforeSeq: number | null; limit: number | undefined; at: number }[]
    answers: unknown[]
    loadMore: () => Promise<unknown>
    refetch: () => Promise<void>
    releaseLatest: () => void
    holdLatest: () => void
    holdOutline: () => void
    releaseOutline: () => void
    holdBefore: () => void
    releaseBefore: () => void
    windowState: () => {
        messageCount: number
        oldestSeq: number | null
        newestSeq: number | null
        isLoadingMore: boolean
        isSyncingTail: boolean
        viewMode: 'tail' | 'history'
    }
}

declare global {
    interface Window {
        __probe: Probe
        __readingAnchorTasks: {
            capture: () => ReadingAnchor | null
            point: (anchor: ReadingAnchor) => number | null
        }
    }
}

let mediaResponseGate: Promise<void> | null = null
let releaseMediaResponse = () => {}
let releaseLatestResponse = () => {}
let latestResponseGate: Promise<void> | null = null
let contextResponseGate: Promise<void> | null = null
let releaseContextResponse = () => {}
let holdAfterMinimumSeq = 0
let afterResponseGate: Promise<void> | null = null
let releaseAfterResponse = () => {}
let outlineResponseGate: Promise<void> | null = null
let releaseOutlineResponse = () => {}
let beforeResponseGate: Promise<void> | null = null
let releaseBeforeResponse = () => {}

window.__probe = {
    mediaReads: 0,
    holdMedia: () => { mediaResponseGate = new Promise<void>(resolve => { releaseMediaResponse = resolve }) },
    releaseMedia: () => { mediaResponseGate = null; releaseMediaResponse() },
    evictHistoryPayloads: () => getHistoryPageRepository(fakeApi).invalidateSession(SESSION_ID),
    holdContext: () => { contextResponseGate = new Promise<void>(resolve => { releaseContextResponse = resolve }) },
    releaseContext: () => { contextResponseGate = null; releaseContextResponse() },
    holdAfter: (minimumSeq = 0) => { holdAfterMinimumSeq = minimumSeq; afterResponseGate = new Promise<void>(resolve => { releaseAfterResponse = resolve }) },
    releaseAfter: () => { afterResponseGate = null; releaseAfterResponse() },
    appendRemoteMessage: (deliver = true) => {
        const last = allMessages[allMessages.length - 1]
        const seq = last.seq! + 1
        const row = { ...last, id: `m-${seq}`, seq, createdAt: last.createdAt + 1,
            invokedAt: (last.invokedAt ?? last.createdAt) + 1,
            content: { role: 'user', content: { type: 'text', text: `Fixture message ${seq}` } } } as DecryptedMessage
        allMessages.push(row)
        sessionStorage.setItem('hapi:e2e:history-remote-appends', JSON.stringify(allMessages.slice(TOTAL_MESSAGES)))
        remoteRewindSeq = seq
        if (deliver) ingestIncomingMessages(SESSION_ID, [row])
    },
    finishedOutlineRequests: 0,
    finishedRequests: 0,
    remoteRewindTo: async () => {},
    remoteEditMessage: () => {},
    requests: [],
    answers: [],
    loadMore: async () => {},
    refetch: async () => {},
    releaseLatest: () => { latestResponseGate = null; releaseLatestResponse() },
    holdLatest: () => { latestResponseGate = new Promise<void>(resolve => { releaseLatestResponse = resolve }) },
    holdOutline: () => { outlineResponseGate = new Promise<void>(resolve => { releaseOutlineResponse = resolve }) },
    releaseOutline: () => { outlineResponseGate = null; releaseOutlineResponse() },
    holdBefore: () => {
        beforeResponseGate = new Promise<void>((resolve) => {
            releaseBeforeResponse = resolve
        })
    },
    releaseBefore: () => {
        beforeResponseGate = null
        releaseBeforeResponse()
    },
    windowState: () => {
        const state = getMessageWindowState(activeSessionId)
        return {
            messageCount: state.messages.length,
            oldestSeq: state.oldestSeq,
            newestSeq: state.newestSeq,
            isLoadingMore: state.isLoadingMore,
            isSyncingTail: state.isSyncingTail,
            viewMode: state.viewMode
        }
    }
}

// Test knobs via query params:
// - ?shortPages=1  — `before` pages return 2 messages regardless of limit, so
//   one page is shorter than the preload margin and cannot push the top
//   sentinel out of the observed box (no intersection transition).
// - ?failBefore=N  — the first N `before` requests reject, mimicking a
//   transient network failure while the sentinel stays covered.
// - ?filteredOlder=1 — every row older than the initial tail page is an
//   agent meta row that normalizeDecryptedMessage filters out, so a loaded
//   page renders zero height and the sentinel cannot move.
// - ?epochBump=1 — `before` responses carry a newer epoch than the tail, so
//   every older-page request hits the store's deliberate epoch-mismatch stop
//   (reset + tail resync, typed terminal stop).
// - ?coldInitial=1 — honor the production cold-open latest-page size instead
//   of returning the legacy full 200-row page used by this fixture by default.
// - ?slowBefore=1 — add latency to older-page responses. Use holdBefore /
//   releaseBefore for tests that require a request to remain in flight.
// - ?cachedReentry=1 — hydrate one cached message before activation, so the
//   latest-tail refresh path can be tested independently from a cold window.
// - ?holdLatest=1 — hold the latest response until `window.__probe.releaseLatest`
//   is called, making the cached first paint observable.
const fixtureParams = new URLSearchParams(window.location.search)
const shortPages = fixtureParams.has('shortPages')
const failBeforeCount = Number(fixtureParams.get('failBefore') ?? '0')
const directoryDenied = fixtureParams.has('directoryDenied')
const outlineEpochReset = fixtureParams.has('outlineEpochReset')
const resetRefreshDenied = fixtureParams.has('resetRefreshDenied')
let resetRefreshFailures = 0
const filteredOlder = fixtureParams.has('filteredOlder')
const epochBump = fixtureParams.has('epochBump')
const coldInitial = fixtureParams.has('coldInitial')
const slowBefore = fixtureParams.has('slowBefore')
const cachedReentry = fixtureParams.has('cachedReentry')
const orphanReasoning = fixtureParams.has('orphanReasoning')
const sameAt = fixtureParams.has('sameAt')
const snapshotBefore = fixtureParams.has('snapshotBefore')
const holdLatest = fixtureParams.has('holdLatest')
const readingAnchorTasks = fixtureParams.has('readingAnchor')
const readingPending = fixtureParams.has('readingPending')
const outlineArchive = fixtureParams.has('outlineArchive')
const threadHeader = fixtureParams.has('threadHeader')
let remoteRewindSeq = TOTAL_MESSAGES
let remoteEpoch = 1
if (holdLatest) {
    latestResponseGate = new Promise<void>((resolve) => {
        releaseLatestResponse = resolve
    })
}
let beforeAttempts = 0

const allMessages: DecryptedMessage[] = Array.from({ length: TOTAL_MESSAGES }, (_, index) => {
    const seq = index + 1
    const filtered = filteredOlder && seq <= TOTAL_MESSAGES - 200
    return {
        id: `m-${seq}`,
        seq,
        localId: null,
        content: filtered
            ? { role: 'agent', content: { type: 'output', data: { isMeta: true } } }
            : { role: 'user', content: { type: 'text', text: `Fixture message ${seq}` } },
        createdAt: BASE_AT + seq,
        invokedAt: BASE_AT + seq
    } as DecryptedMessage
})
// A tool-heavy raw page can collapse to one visible row. A genuinely short
// session must remain top-aligned, while a partial long session needs coverage.
if (fixtureParams.has('compactInitial')) {
    const visibleCount = Number(fixtureParams.get('compactInitial')) || 1
    for (const message of allMessages.slice(-20, -visibleCount)) {
        message.content = { role: 'agent', content: { type: 'output', data: { isMeta: true } } }
    }
}
if (fixtureParams.has('shortSession')) allMessages.splice(0, allMessages.length - 3)
if (fixtureParams.has('emptySession')) allMessages.length = 0
if (fixtureParams.has('holdBefore')) window.__probe.holdBefore()

if (fixtureParams.has('nativeReplay')) {
    allMessages.splice(-20, 20, ...nativeReplayRows(TOTAL_MESSAGES - 19, fixtureParams.get('nativeReplay') as NativeReplayStatus, undefined, fixtureParams.has('question')))
    if (fixtureParams.has('longProcess')) {
        const commentary = allMessages[TOTAL_MESSAGES - 19].content as { content: { data: { message: string } } }
        commentary.content.data.message += '\n\n' + Array.from({ length: 35 }, (_, index) => `Inspection passage ${index}: native source identities remain stable across history and live updates.`).join('\n\n')
    }
    if (fixtureParams.has('largeCode')) {
        const answer = allMessages[TOTAL_MESSAGES - 13].content as { content: { data: { message: string } } }
        answer.content.data.message = '```typescript\n' + Array.from({ length: 1200 }, (_, index) =>
            `const nativeLine${String(index + 1).padStart(4, '0')} = "source identity retained across the history window";`).join('\n') + '\n```'
    }
}

// A page may begin in the middle of an assistant response. Loading its earlier
// blocks changes the first block of the joined assistant-ui message.
if (fixtureParams.has('groupedHistory')) {
    for (const message of allMessages) {
        if (message.seq! % 80 === 1) continue
        message.content = { role: 'agent', content: { type: 'codex', data: {
            type: 'message', message: Array.from({ length: 3 }, (_, paragraph) =>
                `History passage ${message.seq}.${paragraph}: Reading this passage must remain stable when an earlier page arrives.`).join('\n\n'),
        } } }
    }
}

if (fixtureParams.has('sparseOutline')) {
    for (const message of allMessages) {
        if (message.seq === 1) continue
        message.content = { role: 'agent', content: { type: 'codex', data: {
            type: 'message', message: `Sparse answer passage ${message.seq}: keep this reading position.`,
        } } }
    }
}

if (fixtureParams.has('longIncoming')) {
    for (let index=994; index<1193; index++) {
        if (index % 5 !== 0) continue;
        allMessages[index].content = {role:'agent',content:{type:'codex',data:{type:'message',message:
            Array.from({length:18+index%11},(_,i)=>`Loaded paragraph ${index+1}.${i+1}: This long history report contains real wrapping text and several lines on the phone. 历史正文应始终完整可读，不得与下一条工具或消息重叠。`).join('\n\n')
        }}};
    }
}
if (readingAnchorTasks) {
    const image = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="${readingPending ? 40 : 240}"><rect width="480" height="240" fill="#c5e5ff"/></svg>`
    allMessages[TOTAL_MESSAGES - 7].content = { role: 'user', content: { type: 'text', text: 'Image above the long reading passage', attachments: [{
        id: 'reading-image', filename: 'reading-anchor.svg', mimeType: 'image/svg+xml', size: image.length,
        path: 'fixture/reading-anchor.svg', previewUrl: `data:image/svg+xml,${encodeURIComponent(image)}`,
    }] } }
    allMessages[TOTAL_MESSAGES - 6].content = { role: 'agent', content: { type: 'codex', data: { type: 'message', message:
        Array.from({ length: 90 }, (_, i) => `Anchor paragraph ${String(i + 1).padStart(3, '0')}: `
            + `Reading passage ${i + 1} remains visible when earlier content changes. 段落 ${i + 1} 的文字应保持原位，宽度变化后仍然读同一个字符。`).join('\n\n'),
    } } }
}

if (fixtureParams.has('shareLongTurn')) {
    allMessages[600].content = { role: 'user', content: { type: 'text', text: 'Export this complete long turn' } }
    for (let index = 601; index < 1199; index++) {
        allMessages[index].content = { role: 'agent', content: { type: 'codex', data: {
            type: 'message', message: `Export passage ${index + 1}: complete history content.`,
        } } }
    }
}

if (fixtureParams.has('shareMediaExport')) {
    for (let index = 602; index < 1198; index++) {
        allMessages[index].content = { role: 'agent', content: { type: 'output', data: { isMeta: true } } }
    }
}

if (fixtureParams.has('shareOversize')) {
    allMessages[600].content = { role: 'user', content: { type: 'text', text: 'x'.repeat(9 * 1024 * 1024) } }
}

if (fixtureParams.has('shareSlowImage')) {
    allMessages[749].content = { role: 'agent', content: { type: 'codex', data: {
        type: 'generated-image', imageId: 'share-image', fileName: 'share-image.svg', mimeType: 'image/svg+xml',
    } } }
}

if (sameAt) {
    for (const message of allMessages) { message.createdAt = BASE_AT; message.invokedAt = BASE_AT }
}

// The simulated server outlives a page refresh, just as the real Hub does.
const remoteAppends = JSON.parse(sessionStorage.getItem('hapi:e2e:history-remote-appends') ?? '[]') as DecryptedMessage[]
allMessages.push(...remoteAppends)
if (remoteAppends.length) remoteRewindSeq = remoteAppends[remoteAppends.length - 1].seq!

window.__readingAnchorTasks = {
    capture: () => {
        const viewport = document.querySelector<HTMLElement>('.chat-scroll-y')
        return viewport ? captureReadingAnchor(viewport) : null
    },
    point: (anchor) => {
        const viewport = document.querySelector<HTMLElement>('.chat-scroll-y')
        const row = document.getElementById(anchor.id)
        if (!viewport || !row || !anchor.text) return null
        // Observe the original DOM occurrence, independent of production quote lookup.
        let node: Node | undefined = row
        for (const index of anchor.text.path) node = node?.childNodes[index]
        if (!node || node.nodeType !== Node.TEXT_NODE) return null
        const range = document.createRange()
        range.setStart(node, anchor.text.offset); range.setEnd(node, anchor.text.offset + 1)
        return range.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    },
}

if (cachedReentry) {
    const cachedMessages = allMessages.slice(-200)
    const cachedOldest = cachedMessages[0]
    const cachedNewest = cachedMessages.at(-1)
    if (!cachedOldest || !cachedNewest) throw new Error('Expected cached fixture messages')
    const oldestPosition = positionOf(cachedOldest)
    const newestPosition = positionOf(cachedNewest)
    sessionStorage.setItem(`hapi:message-window:v2:${SESSION_ID}`, JSON.stringify({
        messages: orphanReasoning ? [{
            ...allMessages[0], id: 'reasoning-retained', content: { role: 'agent', content: {
                type: 'codex', data: { type: 'reasoning', message: 'Retained earlier reasoning snapshot', id: 'retained-stream' },
            } },
        }, ...cachedMessages] : cachedMessages,
        hasMore: true,
        oldestPositionAt: oldestPosition.at,
        oldestPositionSeq: oldestPosition.seq,
        newestPositionAt: newestPosition.at,
        newestPositionSeq: newestPosition.seq,
        epoch: 1
    }))
}

function positionOf(message: DecryptedMessage): { at: number; seq: number } {
    return { at: message.invokedAt ?? message.createdAt, seq: message.seq ?? 0 }
}

function pageFrom(messages: DecryptedMessage[], overrides: Partial<MessagesResponse['page']>): MessagesResponse['page'] {
    const oldest = messages[0] ?? null
    const newest = messages[messages.length - 1] ?? null
    return {
        direction: 'latest',
        limit: 200,
        epoch: 1,
        reset: false,
        nextBeforeSeq: oldest?.seq ?? null,
        nextBeforeAt: oldest ? positionOf(oldest).at : null,
        nextAfterSeq: newest?.seq ?? null,
        nextAfterAt: newest ? positionOf(newest).at : null,
        snapshotHeadSeq: newest?.seq ?? null,
        snapshotHeadAt: newest ? positionOf(newest).at : null,
        hasMore: false,
        ...overrides
    }
}

let outlineReads = 0
let outlineFailures = Number(fixtureParams.get('failOutline') ?? '0')
const fakeApi = {
    approvePermission: async (session: string, request: string, answers: unknown) => {
        window.__probe.answers.push({ session, request, answers })
    },
    getMessageOutline: async (_sessionId: string, options: { limit?: number; before?: { at: number; seq: number }; epoch?: number } = {}) => {
        window.__probe.requests.push({ direction: 'outline', beforeSeq: options.before?.seq ?? null, limit: options.limit, at: Date.now() })
        outlineReads++
        const snapshot = allMessages.filter(row => row.seq! <= remoteRewindSeq)
        const gate = options.before ? outlineResponseGate : null
        await new Promise(resolve => setTimeout(resolve, Number(fixtureParams.get('outlineDelay') ?? '50')))
        if (gate) await gate
        window.__probe.finishedOutlineRequests++
        if (directoryDenied) throw new ApiError('fixture: directory forbidden', 403)
        if (options.before && outlineFailures > 0) { outlineFailures--; throw new Error('fixture: outline page failed') }
        if (outlineEpochReset && outlineReads === 2) { remoteEpoch = 2; remoteRewindSeq = 1000 }
        const reset = options.epoch !== undefined && options.epoch !== remoteEpoch
        const indexing = outlineReads <= Number(fixtureParams.get('outlineIndexReads') ?? '0')
        const all = snapshot.filter(row => row.seq! <= remoteRewindSeq).flatMap(row => {
            const label = extractConversationOutlineLabel(row.content)
            return label === null ? [] : [{ messageId: row.id, label, ...positionOf(row), createdAt: row.createdAt }]
        }).reverse().filter(row => !options.before || row.at < options.before.at || (row.at === options.before.at && row.seq < options.before.seq))
        const entries = reset || indexing ? [] : all.slice(0, options.limit ?? 100)
        const last = entries.at(-1)
        return { entries, page: { epoch: remoteEpoch, reset, hasMore: !reset && all.length > entries.length,
            beforeCursor: last ? { at: last.at, seq: last.seq } : null,
            scannedThrough: indexing ? 0 : remoteRewindSeq, headSeq: remoteRewindSeq,
            complete: !indexing, indexing, unreadable: false } }
    },
    getGeneratedImageBlob: async () => {
        const gate = mediaResponseGate
        window.__probe.mediaReads++
        await new Promise(resolve => setTimeout(resolve, 600))
        if (gate) await gate
        if (fixtureParams.has('shareImageFailure')) throw new Error('fixture image unavailable')
        return new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="blue"/></svg>'], { type: 'image/svg+xml' })
    },
    getHubSettings: async () => ({ sessionSummaryInChat: false }),
    getMachines: async () => ({ machines: [] }),
    getMessageContext: async (_sessionId: string, messageId: string, options: { radius?: number } = {}) => {
        const gate = contextResponseGate
        window.__probe.requests.push({ direction: 'context', beforeSeq: null, limit: options.radius, at: Date.now() })
        await new Promise(resolve => setTimeout(resolve, 50))
        if (gate) await gate
        if (fixtureParams.has('shareContextDenied')) throw new ApiError('Access denied', 403)
        const active = allMessages.filter(message => message.seq! <= remoteRewindSeq)
        const index = active.findIndex(message => message.id === messageId)
        if (index < 0) throw new ApiError('Message not found', 404)
        const radius = options.radius ?? 99
        const start = Math.max(0, index - radius), end = Math.min(active.length, index + radius + 1)
        const rows = active.slice(start, end)
        return { anchor: { messageId, position: positionOf(active[index]) }, messages: rows,
            page: { epoch: epochBump && beforeAttempts > 0 ? 2 : remoteEpoch, reset: false, beforeCursor: positionOf(rows[0]),
                afterCursor: positionOf(rows[rows.length - 1]), hasMoreBefore: start > 0,
                hasMoreAfter: end < active.length, snapshotHead: positionOf(active[active.length - 1]) } }
    },
    getMessages: async (_sessionId: string, query: {
        limit?: number
        beforeAt?: number | null
        beforeSeq?: number | null
        afterAt?: number | null
        afterSeq?: number | null
        epoch?: number
        untilAt?: number
        untilSeq?: number
    }): Promise<MessagesResponse> => {
        const requestedLimit = query.limit ?? 200
        let direction = 'latest'
        if (query.beforeSeq != null || query.beforeAt != null) direction = 'before'
        else if (query.afterSeq != null || query.afterAt != null) direction = 'after'
        const limit = direction === 'latest' && readingPending ? 7
            : direction === 'latest' && !coldInitial && !cachedReentry ? 200 : requestedLimit
        const responseGate = direction === 'before' ? beforeResponseGate : direction === 'after' && (query.afterSeq ?? 0) >= holdAfterMinimumSeq ? afterResponseGate : null
        const requestSnapshot = snapshotBefore && direction === 'before'
            ? allMessages.filter(message => message.seq! <= remoteRewindSeq) : null
        window.__probe.requests.push({
            direction,
            beforeSeq: query.beforeSeq ?? null,
            afterSeq: query.afterSeq ?? null,
            limit: query.limit,
            at: Date.now()
        })
        // Small async delay to mimic latency. Some tests deliberately keep an
        // older request in flight while a normal tail synchronization runs.
        await new Promise((resolve) => setTimeout(
            resolve,
            direction === 'before' && slowBefore ? 500 : 50
        ))
        if (responseGate) await responseGate

        if (direction === 'latest' && latestResponseGate) {
            await latestResponseGate
        }

        window.__probe.finishedRequests++
        if (outlineEpochReset && direction !== 'before' && remoteEpoch === 2 && resetRefreshFailures++ === 0) {
            if (resetRefreshDenied) throw new ApiError('fixture: reset refresh forbidden', 403)
            throw new Error('fixture: reset refresh failed')
        }
        const activeMessages = allMessages.filter(message => message.seq! <= remoteRewindSeq)
        if (direction === 'before') {
            beforeAttempts += 1
            if (directoryDenied) throw new ApiError('fixture: directory forbidden', 403)
            if (outlineEpochReset && beforeAttempts === 1) {
                remoteRewindSeq = 1000
                remoteEpoch = 2
                const snapshot = allMessages.filter(message => message.seq! <= remoteRewindSeq).slice(-200)
                return { messages: snapshot, page: pageFrom(snapshot, { epoch: 2, reset: true, hasMore: true }) }
            }
            if (beforeAttempts <= failBeforeCount) {
                throw new Error('fixture: forced before-page failure')
            }
            const cursorAt = query.beforeAt ?? Number.POSITIVE_INFINITY
            const cursorSeq = query.beforeSeq ?? Number.POSITIVE_INFINITY
            const older = (requestSnapshot ?? activeMessages).filter((message) => {
                const position = positionOf(message)
                return position.at < cursorAt || (position.at === cursorAt && position.seq < cursorSeq)
            })
            const pageMessages = shortPages ? older.slice(-2) : older.slice(-limit)
            const oldest = pageMessages[0] ?? null
            return {
                messages: pageMessages,
                page: pageFrom(pageMessages, {
                    direction: 'before',
                    limit,
                    epoch: epochBump ? 2 : remoteEpoch,
                    hasMore: older.length > pageMessages.length,
                    nextBeforeSeq: oldest?.seq ?? null,
                    nextBeforeAt: oldest ? positionOf(oldest).at : null,
                    nextAfterSeq: null,
                    nextAfterAt: null,
                    snapshotHeadSeq: null,
                    snapshotHeadAt: null
                })
            }
        }

        if (direction === 'after' && query.epoch === remoteEpoch && !epochBump) {
            const newer = activeMessages.filter(message => {
                const position = positionOf(message)
                const after = { at: query.afterAt!, seq: query.afterSeq! }
                const until = { at: query.untilAt ?? Infinity, seq: query.untilSeq ?? Infinity }
                return (position.at > after.at || (position.at === after.at && position.seq > after.seq))
                    && (position.at < until.at || (position.at === until.at && position.seq <= until.seq))
            })
            const rows = newer.slice(0, limit)
            const last = rows[rows.length - 1]
            const head = activeMessages[activeMessages.length - 1]
            return { messages: rows, page: pageFrom(rows, {
                direction: 'after', limit, epoch: remoteEpoch, reset: false, hasMore: newer.length > rows.length,
                nextAfterAt: last ? positionOf(last).at : query.afterAt!, nextAfterSeq: last?.seq ?? query.afterSeq!,
                snapshotHeadAt: positionOf(head).at, snapshotHeadSeq: head.seq
            }) }
        }

        const pageMessages = activeMessages.slice(-limit)
        // After an epoch bump the "rewritten" tail renders taller rows, so
        // the reset changes content height — this is what re-fires the
        // ResizeObserver coverage re-check in the epoch-reset scenario.
        const rewritten = epochBump && beforeAttempts > 0
        return {
            messages: rewritten
                ? pageMessages.map((message) => ({
                    ...message,
                    content: {
                        role: 'user',
                        content: { type: 'text', text: `Fixture message ${message.seq} ${'x'.repeat(400)}` }
                    }
                }) as DecryptedMessage)
                : pageMessages,
            page: pageFrom(pageMessages, {
                direction: 'latest',
                limit,
                reset: true,
                epoch: rewritten ? 2 : remoteEpoch,
                hasMore: activeMessages.length > pageMessages.length
            })
        }
    }
} as unknown as ApiClient

const fakeSession = {
    id: SESSION_ID,
    active: true,
    thinking: false,
    agentState: fixtureParams.has('question') ? { requests: { 'native-question': {
        tool: 'request_user_input', toolCallId: 'native-tool-a', arguments: nativeReplayQuestion, createdAt: BASE_AT,
    } } } : null,
    metadata: { path: '/tmp/fixture', host: 'fixture' }
} as unknown as Session

const noopSend = () => {}
const noopAbort = async () => {}

function FixtureThread() {
    useViewportHeight()
    const [sessionId, setSessionId] = useState(SESSION_ID)
    activeSessionId = sessionId
    const session = useMemo(() => ({ ...fakeSession, id: sessionId }), [sessionId])
    const [outlineOpen, setOutlineOpen] = useState(false)
    window.__nativeReplay = { apply(status, text) {
        const rows = nativeReplayRows(TOTAL_MESSAGES - 19, status, text, fixtureParams.has('question'))
        allMessages.splice(-20, 20, ...rows)
        ingestIncomingMessages(sessionId, rows)
    } }
    const {
        messages,
        epoch,
        warning,
        isSyncingTail,
        isLoadingMore,
        hasMore,
        messagesVersion,
        historyVersion,
        loadMore,
        cancelLoadMore,
        refetch,
        setViewMode
    } = useMessages(fakeApi, sessionId)

    window.__probe.remoteEditMessage = (seq, text) => {
        const message = { ...allMessages[seq - 1], content: { role: 'user', content: { type: 'text', text } } } as DecryptedMessage
        allMessages[seq - 1] = message
        ingestIncomingMessages(sessionId, [message])
    }
    window.__probe.loadMore = loadMore
    window.__probe.refetch = refetch
    window.__probe.remoteRewindTo = async (seq) => {
        remoteRewindSeq = seq
        remoteEpoch++
        await refetch()
    }

    const blocksByIdRef = useRef<Map<string, ChatBlock>>(new Map())

    const normalizedMessages = useMemo(() => {
        const normalized = []
        for (const message of messages) {
            if (isQueuedForInvocation(message)) continue
            const next = normalizeDecryptedMessage(message)
            if (next) normalized.push(next)
        }
        return normalized
    }, [messages])

    const reduced = useMemo(() => reduceChatBlocks(normalizedMessages, session.agentState, {}), [normalizedMessages, session.agentState])
    const reconciled = useMemo(
        () => reconcileChatBlocks(reduced.blocks, blocksByIdRef.current),
        [reduced.blocks]
    )
    blocksByIdRef.current = reconciled.byId
    const visibleBlocks = useMemo(
        () => buildVisibleChatBlocks(reconciled.blocks, { hasMoreMessages: hasMore }),
        [reconciled.blocks, hasMore]
    )

    const outlineItems = useMemo(() => {
        const items = buildConversationOutline(reconciled.blocks)
        if (outlineArchive && !items.some(item => item.targetMessageId === 'user-text:m-700')) {
            const archived = normalizeDecryptedMessage(allMessages[699])!
            items.push(...buildConversationOutline(reduceChatBlocks([archived], null, {}).blocks))
        }
        return items
    }, [reconciled.blocks])

    const nativePresentation = fixtureParams.has('nativeChat') || localStorage.getItem('hapi:native-chat-presentation') === 'dsh'
    const projection = useMemo(() => new NativeChatProjection(), [sessionId])
    useMemo(() => { if (nativePresentation) projection.update(reconciled.blocks, normalizedMessages) }, [nativePresentation, projection, reconciled.blocks, normalizedMessages])
    useLayoutEffect(() => { if (nativePresentation) projection.publish() })
    const Thread = nativePresentation ? NativeCodexThread : HappyThread
    const runtime = useHappyRuntime({
        session,
        blocks: nativePresentation ? projection.blocks : visibleBlocks,
        nativeNodes: nativePresentation,
        nativeTurnStates: nativePresentation ? projection.turnStates : undefined,
        messagesVersion,
        historyVersion,
        isSending: false,
        onSendMessage: noopSend,
        onAbort: noopAbort
    })

    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <div className="flex min-h-0 flex-col" style={{ height: 'var(--app-viewport-height, 100dvh)' }}>
                {threadHeader ? <div className="h-14 shrink-0">Session header fixture</div> : null}
                {readingAnchorTasks ? <button type="button" className="fixed left-0 top-0 z-50"
                    onClick={() => setSessionId(current => current === SESSION_ID ? `${SESSION_ID}-b` : SESSION_ID)}>
                    {sessionId === SESSION_ID ? 'Switch to session B' : 'Switch to session A'}
                </button> : null}
                {readingAnchorTasks || fixtureParams.has('outlineVirtual') ? <button type="button" className="fixed right-0 top-0 z-50"
                    onClick={() => setOutlineOpen(true)}>Open conversation outline</button> : null}
                <Thread key={sessionId} nativeProjection={nativePresentation ? projection : undefined}
                    api={fakeApi}
                    session={session}
                    sessionId={sessionId}
                    metadata={null}
                    disabled={false}
                    onRefresh={() => {}}
                    onViewModeChange={setViewMode}
                    isSyncingTail={isSyncingTail}
                    messagesWarning={warning}
                    hasMoreMessages={hasMore}
                    isLoadingMoreMessages={isLoadingMore}
                    onLoadMore={loadMore}
                    onCancelLoadMore={cancelLoadMore}
                    // This fixture drives HappyThread directly, bypassing the
                    // SessionChat block reduction that computes the real count.
                    unseenCount={0}
                    rawMessagesCount={messages.length}
                    normalizedMessagesCount={normalizedMessages.length}
                    messagesVersion={messagesVersion}
                    historyVersion={historyVersion}
                    forceScrollToken={0}
                    outlineOpen={outlineOpen}
                    outlineItems={outlineItems}
                    outlineEpoch={epoch}
                    onOutlineOpenChange={setOutlineOpen}
                />
            </div>
        </AssistantRuntimeProvider>
    )
}

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { retry: false }
    }
})

ReactDOM.createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={queryClient}>
        <I18nProvider>
            <FixtureThread />
        </I18nProvider>
    </QueryClientProvider>
)
