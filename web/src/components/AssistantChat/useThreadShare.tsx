import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useSessionHeaderMetadata } from '@/hooks/useSessionHeaderMetadata'
import { useMachines } from '@/hooks/queries/useMachines'
import { useMachineLabels } from '@/hooks/useMachineLabels'
import { resolveSessionHeaderMachineLabel } from '@/components/SessionHeader'
import { getSessionModelLabel } from '@/lib/sessionModelLabel'
import { getSessionTitle } from '@/lib/sessionTitle'
import { isFastServiceTier } from './codexFastMode'
import { useMinuteTick } from '@/hooks/useMinuteTick'
import { getShareTurnReasoningLabel, selectShareTurnMetadata } from '@/lib/shareTurnMetadata'
import { formatRelativeTime } from '@/lib/relativeTime'
import { formatSessionHeaderTimestamp } from '@/lib/sessionHeaderTimestamp'
import { useTranslation } from '@/lib/use-translation'
import { readShareTurn, ShareTurnTooLargeError } from '@/lib/share-turn-data'
import { ShareTurnCapture, type TurnSnapshot } from './ShareTurnCapture'
import { ShareTurnDialog } from './ShareTurnDialog'
import { THREAD_MESSAGE_COMPONENTS, findNearestMessageElement, type HappyThreadProps } from './HappyThread'
import type { VisibleChatBlock } from '@/chat/toolGroups'

type ShareTurnSnapshot = TurnSnapshot
type ShareTurnState = { id: number; snapshots: TurnSnapshot[]; sourceContentWidth: number | null } | null
export function useThreadShare(props: HappyThreadProps, contentRef: RefObject<HTMLDivElement | null>) {
    const { t, locale } = useTranslation()
    const shareTurnIdRef = useRef(0)
    const sessionIdRef = useRef(props.sessionId)
    const { preferences: headerMetadata } = useSessionHeaderMetadata()
    const { machines } = useMachines(props.api, true)
    const machineLabelsById = useMachineLabels(machines)
    const [shareTurn, setShareTurn] = useState<ShareTurnState>(null)
    const [shareCapture, setShareCapture] = useState<{ id: number; blocks: VisibleChatBlock[]; width: number } | null>(null)
    const [shareLoading, setShareLoading] = useState(false)
    const [shareError, setShareError] = useState<'shareTurn.loadFailed' | 'shareTurn.tooLarge' | null>(null)
    const shareDialogOpen = shareTurn !== null
    const shareTitle = shareTurn ? getSessionTitle(props.session) : ''
    const shareRelativeTimeTick = useMinuteTick(headerMetadata.lastActive && shareDialogOpen)
    const shareMetadataItems = useMemo(() => {
        const agentFlavor = props.session.metadata?.flavor ?? null
        const agentLabel = agentFlavor?.trim() || null
        const machineLabel = resolveSessionHeaderMachineLabel(props.session, machineLabelsById)
        const modelLabel = getSessionModelLabel(props.session)
        const reasoningLabel = getShareTurnReasoningLabel(
            agentFlavor,
            props.session.modelReasoningEffort,
            props.session.effort,
            headerMetadata.showLabels
        )
        const lastActiveAt = props.session.activeAt || props.session.updatedAt || props.session.createdAt
        const lastActiveLabel = lastActiveAt > 0 ? formatRelativeTime(lastActiveAt, t) : null
        const createdAtLabel = formatSessionHeaderTimestamp(props.session.createdAt, locale)
        const updatedAtLabel = formatSessionHeaderTimestamp(props.session.updatedAt, locale)
        const worktreeBranch = props.session.metadata?.worktree?.branch?.trim() || null
        const showFastBadge = agentFlavor === 'codex'
            && isFastServiceTier(props.serviceTier ?? props.session.serviceTier)

        return selectShareTurnMetadata(headerMetadata, {
            agent: agentLabel ? { text: agentLabel, flavor: agentFlavor } : undefined,
            machine: machineLabel ? {
                text: `${headerMetadata.showLabels ? `${t('session.item.machine')}: ` : ''}${machineLabel}`,
            } : undefined,
            lastActive: lastActiveLabel ? { text: lastActiveLabel } : undefined,
            model: modelLabel ? {
                text: `${headerMetadata.showLabels ? `${t(modelLabel.key)}: ` : ''}${modelLabel.value}`,
            } : undefined,
            reasoning: reasoningLabel ? { text: reasoningLabel } : undefined,
            fastMode: showFastBadge ? { text: 'fast' } : undefined,
            createdAt: createdAtLabel ? {
                text: `${headerMetadata.showLabels ? `${t('session.header.createdAt')}: ` : ''}${createdAtLabel}`,
            } : undefined,
            updatedAt: updatedAtLabel ? {
                text: `${headerMetadata.showLabels ? `${t('session.header.updatedAt')}: ` : ''}${updatedAtLabel}`,
            } : undefined,
            worktree: worktreeBranch ? {
                text: `${headerMetadata.showLabels ? `${t('session.item.worktree')}: ` : ''}${worktreeBranch}`,
            } : undefined,
        })
    }, [headerMetadata, locale, machineLabelsById, props.serviceTier, props.session, shareDialogOpen, shareRelativeTimeTick, t])
    const cancelShareCapture = useCallback(() => {
        shareTurnIdRef.current++
        setShareCapture(null)
        setShareLoading(false)
        setShareError(null)
    }, [])
    useLayoutEffect(() => {
        cancelShareCapture()
        setShareTurn(null)
        return cancelShareCapture
    }, [props.sessionId, props.outlineEpoch, cancelShareCapture])

    const finishShareCapture = useCallback((snapshots: TurnSnapshot[]) => {
        if (!shareCapture || shareCapture.id !== shareTurnIdRef.current) return
        setShareTurn({ id: shareCapture.id, snapshots, sourceContentWidth: shareCapture.width })
        setShareCapture(null)
        setShareLoading(false)
    }, [shareCapture])
    const failShareCapture = useCallback(() => {
        if (!shareCapture || shareCapture.id !== shareTurnIdRef.current) return
        setShareCapture(null)
        setShareLoading(false)
        setShareError('shareTurn.loadFailed')
    }, [shareCapture])
    const handleShareTurn = useCallback(async (
        messageTarget: HTMLElement | string | null,
        clientY?: number,
        _fallbackSnapshot?: ShareTurnSnapshot
    ) => {
        const content = contentRef.current
        if (!content) return
        const target = typeof messageTarget === 'string'
            ? document.getElementById(messageTarget) : messageTarget
        const message = target && content.contains(target) ? target : findNearestMessageElement(content, clientY)
        if (!message) return
        const width = content.querySelector('.happy-thread-messages')?.getBoundingClientRect().width
            ?? content.getBoundingClientRect().width
        const id = ++shareTurnIdRef.current
        const sessionId = props.sessionId
        const isCurrent = () => id === shareTurnIdRef.current && sessionId === sessionIdRef.current
        setShareTurn(null)
        setShareCapture(null)
        setShareError(null)
        setShareLoading(true)
        try {
            const blocks = await readShareTurn(props.api, sessionId, message.id, isCurrent)
            if (blocks && isCurrent()) setShareCapture({ id, blocks, width })
        } catch (error) {
            if (isCurrent()) {
                setShareLoading(false)
                setShareError(error instanceof ShareTurnTooLargeError ? 'shareTurn.tooLarge' : 'shareTurn.loadFailed')
            }
        }
    }, [props.api, props.sessionId])

    return { open: handleShareTurn, element: <>                {shareLoading || shareError ? (
                    <div role={shareError ? 'alert' : 'status'} className="app-thread-share-status absolute left-2 right-2 top-2 z-40 flex items-center justify-between gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-xs">
                        <span>{t(shareError ?? 'shareTurn.preparing')}</span>
                        <button type="button" onClick={cancelShareCapture}>{t('shareTurn.cancel')}</button>
                    </div>
                ) : null}
                {shareCapture ? <ShareTurnCapture key={shareCapture.id}
                    session={props.session} blocks={shareCapture.blocks}
                    components={THREAD_MESSAGE_COMPONENTS} onCapture={finishShareCapture} onError={failShareCapture} /> : null}
                <ShareTurnDialog
                    key={shareTurn?.id ?? 'closed'}
                    isOpen={shareTurn !== null}
                    title={shareTitle}
                    metadataItems={shareMetadataItems}
                    sourceSnapshots={shareTurn?.snapshots ?? []}
                    sourceContentWidth={shareTurn?.sourceContentWidth ?? null}
                    onClose={() => setShareTurn(null)}
                /></> }
}
