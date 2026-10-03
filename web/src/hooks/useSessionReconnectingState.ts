import { useCallback, useEffect, useState } from 'react'
import { useReconnectingState } from './useReconnectingState'

/** Route changes close a stream intentionally; only its transport failures count. */
export function useSessionReconnectingState(sessionId: string | null) {
    const connection = useReconnectingState()
    const [failedSessionId, setFailedSessionId] = useState<string | null>(null)
    const reportConnect = useCallback(() => {
        setFailedSessionId(null)
        connection.reportConnect()
    }, [connection.reportConnect])
    const reportDisconnect = useCallback((reason: string) => {
        if (!sessionId) return
        setFailedSessionId(sessionId)
        connection.reportDisconnect(reason)
    }, [sessionId, connection.reportDisconnect])
    useEffect(() => {
        connection.reportConnect()
        return connection.reportConnect
    }, [sessionId, connection.reportConnect])
    return { ...connection, isReconnecting: Boolean(sessionId && failedSessionId === sessionId && connection.isReconnecting), reportConnect, reportDisconnect }
}
