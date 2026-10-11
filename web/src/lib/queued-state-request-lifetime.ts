import type { ApiClient } from '@/api/client'

// Bound the whole attempt, including auth refresh and multiple batches. Match
// the 30-second read budget without aborting tail reads shared by other callers.
const REQUEST_TIMEOUT_MS = 30_000
const requests = new Map<string, { api: ApiClient; abort: AbortController }>()

export function cancelQueuedStateRequest(sessionId: string): void {
    const request = requests.get(sessionId)
    if (!request) return
    requests.delete(sessionId)
    request.abort.abort()
}

export function cancelQueuedStateRequestsForApi(api: ApiClient): void {
    for (const [sessionId, request] of requests) {
        if (request.api === api) cancelQueuedStateRequest(sessionId)
    }
}

export function ownQueuedStateRequest(api: ApiClient, sessionId: string) {
    cancelQueuedStateRequest(sessionId)
    const request = { api, abort: new AbortController() }
    requests.set(sessionId, request)
    const signal = request.abort.signal
    const timer = setTimeout(() => request.abort.abort(
        new DOMException('Queued-state reconciliation exceeded 30 seconds', 'TimeoutError')
    ), REQUEST_TIMEOUT_MS)
    return {
        signal,
        isCurrent: () => !signal.aborted && requests.get(sessionId) === request,
        finish: () => {
            clearTimeout(timer)
            if (requests.get(sessionId) === request) requests.delete(sessionId)
        },
        // Auth refresh or a shared tail wait may not honor abort. Release the
        // caller anyway, detach listeners, and observe late transport rejection.
        wait: <T>(pending: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
            const onAbort = () => {
                signal.removeEventListener('abort', onAbort)
                reject(signal.reason)
            }
            if (signal.aborted) onAbort()
            else signal.addEventListener('abort', onAbort, { once: true })
            pending.then(value => {
                signal.removeEventListener('abort', onAbort)
                resolve(value)
            }, error => {
                signal.removeEventListener('abort', onAbort)
                reject(error)
            })
        })
    }
}
