import type { Database } from 'bun:sqlite'
import { AGENT_MESSAGE_PAYLOAD_TYPE, isObject } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import { addMessage } from './messages'
import { decodeMessageContent } from './contentCodec'
import { prepareCached } from './statementCache'
import type { StoredMessage } from './types'

function textStream(content: unknown) {
    const record = unwrapRoleWrappedRecordEnvelope(content)
    if (record?.role !== 'agent' || !isObject(record.content)
        || record.content.type !== AGENT_MESSAGE_PAYLOAD_TYPE) return null
    let data = record.content.data
    if (!isObject(data)) return null
    let owner: unknown[] = []
    if (data.type === 'agent-run-trace') {
        owner = [data.agentId, data.cardId]
        data = data.message
    }
    if (!isObject(data) || data.type !== 'message' || typeof data.message !== 'string'
        || typeof data.id !== 'string' || !data.id.startsWith('codex:')) return null
    return {
        id: data.id,
        key: `hapi:codex-text-snapshot:${JSON.stringify([...owner, data.id])}`,
        live: data.streamSnapshot === true,
    }
}

/** Native Codex uses the body ID as the final localId. Provisional writes have
 * no localId. Give that one replaceable row an indexed key, while retaining a
 * fresh seq for every broadcast so clients can resume their event cursor.
 * Replacement and retirement commit together; a restart retains the last text.
 */
export function addNativeAgentMessage(
    db: Database, sessionId: string, content: unknown, localId?: string, createdAt?: number,
): StoredMessage {
    const stream = textStream(content)
    if (!stream || (localId !== undefined && localId !== stream.id)) {
        return addMessage(db, sessionId, content, localId, undefined, createdAt)
    }
    return db.transaction(() => {
        // A replayed/late provisional event must not resurrect a completed or
        // interrupted item that the bridge has already committed under its ID.
        if (stream.live && localId === undefined) {
            const settled = prepareCached(db, 'SELECT content FROM messages WHERE session_id = ? AND local_id = ?')
                .get(sessionId, stream.id) as { content: string | Uint8Array } | null
            if (settled && textStream(decodeMessageContent(settled.content))?.key === stream.key) {
                return addMessage(db, sessionId, content, stream.id, undefined, createdAt)
            }
        }
        const message = addMessage(db, sessionId, content, localId, undefined, createdAt)
        prepareCached(db, 'DELETE FROM messages WHERE session_id = ? AND local_id = ?')
            .run(sessionId, stream.key)
        if (stream.live && localId === undefined) {
            prepareCached(db, 'UPDATE messages SET local_id = ? WHERE id = ?').run(stream.key, message.id)
            return { ...message, localId: stream.key }
        }
        return message
    })()
}
