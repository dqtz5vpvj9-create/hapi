import { useCallback, useMemo, useState } from 'react'
import type { SessionSummary } from '@/types/api'

/** Keep live output from moving rows under the user's pointer. Only a new
 * session or an explicit list refresh changes the recency order while mounted. */
export function useSessionListOrder(sessions: SessionSummary[], hub?: string | null) {
    const [snapshot, setSnapshot] = useState(() => ({
        hub,
        times: new Map(sessions.map(session => [session.id, session.updatedAt]))
    }))
    // An unchanged parent render must not rescan every session ID.
    const hasNewSessions = useMemo(
        () => sessions.some(session => !snapshot.times.has(session.id)),
        [sessions, snapshot.times]
    )
    let times = snapshot.times
    if (snapshot.hub !== hub) {
        times = new Map(sessions.map(session => [session.id, session.updatedAt]))
        setSnapshot({ hub, times })
    } else if (hasNewSessions) {
        times = new Map(times)
        for (const session of sessions) {
            if (!times.has(session.id)) times.set(session.id, session.updatedAt)
        }
        setSnapshot({ hub, times })
    }
    const timeFor = useCallback((session: SessionSummary) => times.get(session.id) ?? session.updatedAt, [times])
    const compare = useCallback((a: SessionSummary, b: SessionSummary) => (
        timeFor(b) - timeFor(a) || a.id.localeCompare(b.id)
    ), [timeFor])
    const refreshOrder = useCallback(() => {
        setSnapshot({ hub, times: new Map(sessions.map(session => [session.id, session.updatedAt])) })
    }, [hub, sessions])
    return { timeFor, compare, refreshOrder }
}
