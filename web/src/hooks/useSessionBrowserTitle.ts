import { useEffect } from 'react'
import type { Session } from '@/types/api'
import { getSessionTitle } from '@/lib/sessionTitle'

import { APP_TITLE } from '@/lib/runtime-config'

export function useSessionBrowserTitle(session: Session | null): void {
    const sessionTitle = session ? getSessionTitle(session) : null

    useEffect(() => {
        document.title = sessionTitle ? `${sessionTitle} - ${APP_TITLE}` : APP_TITLE

        return () => {
            document.title = APP_TITLE
        }
    }, [sessionTitle])
}
