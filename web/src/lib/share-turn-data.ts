import type { ApiClient } from '@/api/client'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { buildVisibleChatBlocks, type VisibleChatBlock } from '@/chat/toolGroups'
import { findMessageSource, getMessageWindowState } from '@/lib/message-window-store'
import { getHistoryPageRepository, HistoryReadInvalidated } from '@/lib/history-page-repository'
import { isQueuedForInvocation, mergeMessages } from '@/lib/messages'
import type { DecryptedMessage } from '@/types/api'

export class ShareTurnTooLargeError extends Error {
    constructor() { super('This turn exceeds the share size limit.'); this.name = 'ShareTurnTooLargeError' }
}

function checkTurnSize(rows: readonly DecryptedMessage[]): void {
    if (rows.length > 10_000 || new TextEncoder().encode(JSON.stringify(rows)).byteLength > 8 * 1024 * 1024) {
        throw new ShareTurnTooLargeError()
    }
}

function userRow(row: DecryptedMessage): boolean {
    return normalizeDecryptedMessage(row)?.role === 'user'
}

/** Read a turn into an export-owned buffer. Never replace the active reader or
 * its cursors. Pages share the authenticated repository with normal browsing. */
export async function readShareTurn(
    api: ApiClient, sessionId: string, targetId: string, isCurrent: () => boolean,
): Promise<VisibleChatBlock[] | null> {
    const state = getMessageWindowState(sessionId)
    const source = findMessageSource(state.messages, targetId)
    if (!source) throw new Error('The message is no longer available.')
    const repository = getHistoryPageRepository(api)
    let rows: DecryptedMessage[], hasBefore: boolean, hasAfter: boolean
    let before, after, head, epoch: number
    if (source.seq === null) {
        rows = state.messages
        hasBefore = hasAfter = false
    } else {
        const context = await repository.readContext(sessionId, () => api.getMessageContext(sessionId, source.id, { radius: 99, epoch: state.epoch ?? undefined }))
        if (!isCurrent()) return null
        if (context.page.reset || context.page.epoch !== state.epoch) throw new HistoryReadInvalidated()
        rows = context.messages
        epoch = context.page.epoch
        before = context.page.beforeCursor
        after = context.page.afterCursor
        head = context.page.snapshotHead
        hasBefore = context.page.hasMoreBefore
        hasAfter = context.page.hasMoreAfter
    }
    checkTurnSize(rows)
    const boundaries = () => {
        const target = rows.findIndex(row => row.id === source.id)
        let start = target
        while (start >= 0 && !userRow(rows[start])) start--
        let end = target + 1
        while (end < rows.length && !userRow(rows[end])) end++
        return { start, end }
    }
    let bounds = boundaries()
    while (bounds.start < 0 && hasBefore) {
        const page = await repository.read(sessionId, { direction: 'before', cursor: before!, epoch: epoch! })
        if (!isCurrent()) return null
        if (page.page.reset || page.page.epoch !== epoch!) throw new HistoryReadInvalidated()
        rows = mergeMessages(page.messages, rows)
        checkTurnSize(rows)
        hasBefore = page.page.hasMore
        before = { at: page.page.nextBeforeAt!, seq: page.page.nextBeforeSeq! }
        bounds = boundaries()
    }
    while (bounds.end === rows.length && hasAfter) {
        const page = await repository.read(sessionId, { direction: 'after', cursor: after!, until: head!, epoch: epoch! })
        if (!isCurrent()) return null
        if (page.page.reset || page.page.epoch !== epoch!) throw new HistoryReadInvalidated()
        rows = mergeMessages(rows, page.messages)
        checkTurnSize(rows)
        hasAfter = page.page.hasMore
        after = { at: page.page.nextAfterAt!, seq: page.page.nextAfterSeq! }
        bounds = boundaries()
    }
    const normalized = rows.slice(Math.max(0, bounds.start), bounds.end)
        .filter(row => row.id === source.id || !isQueuedForInvocation(row))
        .map(normalizeDecryptedMessage).filter(message => message !== null)
    return buildVisibleChatBlocks(reduceChatBlocks(normalized, null, {}).blocks, { hasMoreMessages: false })
}
