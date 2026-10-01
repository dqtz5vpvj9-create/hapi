import type { Store } from '../store'
import { HistoryBackfill } from './historyBackfill'

export class MessageOutlineBackfill extends HistoryBackfill {
    constructor(store: Store, onError?: (sessionId: string, error: unknown) => void) {
        super(sessionId => {
            const batch = store.messages.backfillOutline(sessionId)
            // Unreadable records make coverage partial, but do not authorize
            // repeatedly scheduling an already exhausted scan.
            return { complete: batch.scannedThrough >= batch.headSeq }
        }, onError)
    }
}
