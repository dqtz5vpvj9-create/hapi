import { useMemo } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useSession } from '@/hooks/queries/useSession'
import { useTranslation } from '@/lib/use-translation'
import { PRESERVE_SESSION_SIDEBAR_SCROLL } from '@/lib/sessionNavigation'
import { getSessionTitle } from '@/lib/sessionTitle'
import { LoadingState } from '@/components/LoadingState'
import { Button } from '@/components/ui/button'
import { createSubagentSource, type NativeSubagentRef } from '@/components/subagent'
import { SubagentConversation } from './SubagentConversation'
import { findNativeSubagentRow, type NativeSubagentRow } from './nativeSubagents'

function toRef(parentSessionId: string, row: NativeSubagentRow): NativeSubagentRef {
    return {
        parentSessionId,
        sessionId: row.id,
        flavor: row.flavor,
        label: row.title,
        ...(row.mode ? { mode: row.mode } : {}),
        ...(row.activity ? { activity: row.activity } : {}),
        ...(row.teamStatus ? { teamStatus: row.teamStatus } : {}),
        ...(row.provider ? { provider: row.provider } : {}),
        ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
        ...(row.settledMs !== undefined ? { settledMs: row.settledMs } : {}),
        ...(row.openSince !== undefined ? { openSince: row.openSince } : {}),
        ...(row.lastTurnCompleted !== undefined ? { lastTurnCompleted: row.lastTurnCompleted } : {}),
    }
}

function MissingSubagent(props: { onBack: () => void }) {
    const { t } = useTranslation()
    return (
        <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center" data-subagent-missing>
            <div className="text-sm font-semibold text-[var(--app-fg)]">{t('sessions.subagentNotFound')}</div>
            <p className="max-w-sm text-xs text-[var(--app-hint)]">{t('sessions.subagentNotFoundBody')}</p>
            <Button type="button" variant="outline" onClick={props.onBack}>{t('sessions.subagentBack')}</Button>
        </div>
    )
}

/**
 * One native child conversation. Codex threads and DSH child sessions share
 * this page: the flavor only changes which `SubagentSource` reads the history.
 */
export function SubagentSessionPage() {
    const { sessionId, subagentId } = useParams({ from: '/sessions/$sessionId/subagents/$subagentId' })
    const { api } = useAppContext()
    const navigate = useNavigate()
    const { t } = useTranslation()
    const { session, isLoading } = useSession(api, sessionId)
    const goBack = () => navigate({
        to: '/sessions/$sessionId',
        params: { sessionId },
        ...PRESERVE_SESSION_SIDEBAR_SCROLL,
    })

    // Rebuild the spectator source only when the child identity changes; live
    // status (activity/settledMs) keeps flowing through the row prop instead.
    const row = findNativeSubagentRow(session?.metadata, subagentId)
    const sourceKey = row ? `${row.flavor}:${row.id}:${row.mode ?? ''}` : ''
    const source = useMemo(() => {
        if (!row) return null
        // External rows read the parent-side delegation record through the same
        // transcript channel; the CLI resolves it from the root session.
        return createSubagentSource(api, toRef(sessionId, row), api.getAuthToken())
        // The identity fields captured by sourceKey are the ones the source reads.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [api, sessionId, sourceKey])

    if (isLoading && !session) {
        return (
            <div className="flex h-full items-center justify-center p-4">
                <LoadingState label={t('loading.session')} />
            </div>
        )
    }
    if (!row || !source) {
        return <MissingSubagent onBack={goBack} />
    }
    return (
        <SubagentConversation
            api={api}
            parentSessionId={sessionId}
            metadata={session?.metadata ?? null}
            parentTitle={session ? getSessionTitle(session) : sessionId.slice(0, 8)}
            row={row}
            source={source}
            onBack={goBack}
        />
    )
}
