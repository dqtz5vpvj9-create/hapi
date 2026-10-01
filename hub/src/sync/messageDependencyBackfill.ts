import type { Store } from '../store'
import { HistoryBackfill } from './historyBackfill'

export class MessageDependencyBackfill extends HistoryBackfill {
    constructor(store: Store, onError?: (sessionId: string, error: unknown) => void) {
        super(sessionId => store.messages.backfillMessageDependencies(sessionId), onError)
    }
}
