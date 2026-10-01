import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { getUninvokedLocalMessages, syncNativeQueuedMessage } from './messages'
import { prepareCached } from './statementCache'

const NativeMirrorSchema = z.object({
    role: z.literal('user'),
    meta: z.object({ sentFrom: z.literal('cli'), isNativeQueuedMessage: z.literal(true) })
})

/** A native-origin queue row projects pending input, rather than recording a
 * HAPI dispatch. Retire only that projection when a complete native snapshot
 * no longer contains its identity. This proves neither consumption nor cancel.
 */
export function syncNativeQueueSnapshot(
    db: Database, sessionId: string, messages: Array<{ localId: string; text: string }>,
): void {
    db.transaction(() => {
        const present = new Set(messages.map(message => message.localId))
        for (const message of messages) syncNativeQueuedMessage(db, sessionId, message.localId, message.text)
        for (const row of getUninvokedLocalMessages(db, sessionId)) {
            if (!row.localId || present.has(row.localId) || row.scheduledAt !== null
                || !NativeMirrorSchema.safeParse(row.content).success) continue
            prepareCached(db, 'DELETE FROM messages WHERE session_id = ? AND id = ? AND invoked_at IS NULL')
                .run(sessionId, row.id)
        }
    })()
}
