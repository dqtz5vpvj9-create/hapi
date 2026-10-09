import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useSessionSendErrors } from '@/lib/session-send-errors'
import { usePaneNavigate } from '@/workspace/PaneContext'
import { PRESERVE_SESSION_SIDEBAR_SCROLL } from '@/lib/sessionNavigation'
import { SessionChat } from '@/components/SessionChat'
import { LoadingState } from '@/components/LoadingState'
import { useAppContext } from '@/lib/app-context'
import { useMessages } from '@/hooks/queries/useMessages'
import { useMachines } from '@/hooks/queries/useMachines'
import { useMachineLabels } from '@/hooks/useMachineLabels'
import { useSession } from '@/hooks/queries/useSession'
import { useCursorChatStoreStatus } from '@/hooks/queries/useCursorChatStoreStatus'
import { useSessions } from '@/hooks/queries/useSessions'
import { useSlashCommands } from '@/hooks/queries/useSlashCommands'
import { useSkills } from '@/hooks/queries/useSkills'
import { getSessionTitle } from '@/lib/sessionTitle'
import { buildSessionReferenceText, matchSessionsForMention } from '@/lib/sessionReference'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { useSendMessage, type SendErrorInfo } from '@/hooks/mutations/useSendMessage'
import type { ComposerSendError } from '@/components/AssistantChat/HappyComposer'
import { ApiError } from '@/api/client'

import { queryKeys } from '@/lib/query-keys'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'
import { seedMessageWindowFromSession, syncTailMessages } from '@/lib/message-window-store'
import { clearDraftsAfterSend } from '@/lib/clearDraftsAfterSend'
import { transferComposerDraftThenNavigate } from '@/lib/composer-draft-transfer'
import { getDraftAttachments } from '@/lib/composer-attachment-drafts'
import { refreshSessionDetailPreservingActive } from '@/lib/session-detail-optimistic'
import { inactiveSessionCanResume, resolveCursorReopenGate } from '@/lib/sessionResume'
import { clearCodexImportedSession } from '@/lib/codexImportedSessions'
import { migrateSuppressedSendError } from '@/lib/suppressed-send-error'
import { retargetSharePendingTransfer } from '@/lib/sharePendingState'

/**
 * Classify a thrown send error into a {message, code} pair the composer can
 * render.  `code` lets the consumer attach a recovery affordance (Reopen on
 * `session_inactive`) without re-inspecting the raw error.
 *
 * `request<T>` in the api client throws `ApiError` for !res.ok with `status`
 * and `code` parsed from the JSON body.  Older / non-JSON failures arrive as
 * plain `Error`; we surface those by their message verbatim, falling back to
 * a localized default when nothing usable is present (e.g. an aborted fetch
 * that resolved with no message).
 */
function classifySendError(
    error: unknown,
    t: (key: string) => string,
): { message: string; code: string | null } {
    if (error instanceof ApiError && error.status === 409 && error.code === 'session_inactive') {
        return { message: t('chat.sendError.sessionInactive'), code: 'session_inactive' }
    }
    if (error instanceof Error && error.message) {
        return { message: error.message, code: null }
    }
    return { message: t('chat.sendError.fallback'), code: null }
}

export function SessionPaneController(props: {
    sessionId: string
    outline?: boolean
    onBack: () => void
    onOutlineConsumed?: () => void
}) {
    const { api, titleSuggestionAvailable = false } = useAppContext()
    const { t } = useTranslation()
    const navigate = usePaneNavigate()
    const goBack = props.onBack
    const queryClient = useQueryClient()
    const { addToast } = useToast()
    const { sessionId, outline } = props
    const {
        session,
        error: sessionError,
        refetch: refetchSession,
    } = useSession(api, sessionId)
    const {
        status: cursorChatStoreStatus,
        isApplicable: cursorChatStoreApplicable,
        error: cursorChatStoreError,
        isLoading: cursorChatStoreLoading,
    } = useCursorChatStoreStatus({ api, session })
    const {
        messages,
        epoch: messagesEpoch,
        warning: messagesWarning,
        isSyncingTail: messagesSyncingTail,
        isLoadingMore: messagesLoadingMore,
        hasMore: messagesHasMore,
        loadMore: loadMoreMessages,
        cancelLoadMore: cancelLoadMoreMessages,
        refetch: refetchMessages,
        viewMode: messagesViewMode,
        messagesVersion,
        historyVersion,
        tailRevision,
        setViewMode,
    } = useMessages(api, sessionId)

    // Tracks the most recent send the hub rejected (4xx/5xx/network), keyed
    // by the session the failed POST actually targeted (post-resolveSessionId).
    // assistant-ui clears the composer eagerly when a send is invoked, so to
    // retain the typed text on error we keep it here and hand it back to the
    // composer for restore + visual error affordance.  Keying by sessionId
    // covers the inactive-session resume race: useSendMessage can resolve
    // the target id, kick off async navigation to it, and then have the POST
    // fail before navigation completes.  Without keying, we'd restore the
    // text into the OLD session's composer and the next render would clear
    // it.  The bumped `id` still lets the composer dedupe restorations of
    // identical text.
    //
    // We persist the classifier `code` (not the bound action) so the
    // composer-visible action stays reactive to `reopeningSessionId` state
    // changes -- the action is built fresh on each render from {raw error
    // record} x {current reopen state}.  See classifySendError + the
    // Reopen affordance below.
    const { sendErrors, setSendErrors, nextSendErrorId } = useSessionSendErrors(api)
    const [reopeningSessionId, setReopeningSessionId] = useState<string | null>(null)
    const clearSendError = useCallback(() => {
        setSendErrors((prev) => {
            if (!(sessionId in prev)) return prev
            const next = { ...prev }
            delete next[sessionId]
            return next
        })
    }, [sessionId])

    const suppressSendErrorRestore = useCallback((id: number) => {
        setSendErrors((prev) => {
            const current = prev[sessionId]
            if (!current || current.id !== id || current.restoreSuppressed) return prev
            return {
                ...prev,
                [sessionId]: { ...current, restoreSuppressed: true }
            }
        })
    }, [sessionId])

    // Reopen recovery (#918): one-click affordance attached to the inline
    // composer error when the rejected send was inactive-session.  Mirrors
    // SessionList's Reopen UX -- POST /sessions/:id/reopen via
    // api.reopenSession -- so the operator's mental model is consistent
    // across surfaces.  We do NOT auto-replay the send: per #917 the reopen
    // path has known fragility, so the operator re-clicks Send on the
    // restored composer text once Reopen lands.
    const reopenFromErrorAffordance = useCallback((errorSessionId: string) => {
        if (!api) return
        setReopeningSessionId((prev) => prev ?? errorSessionId)
        void (async () => {
            try {
                const result = await api.reopenSession(errorSessionId)
                // Clear the inline error -- the operator now has a live
                // session to retry against.
                setSendErrors((prev) => {
                    if (!(errorSessionId in prev)) return prev
                    const next = { ...prev }
                    delete next[errorSessionId]
                    return next
                })
                await queryClient.invalidateQueries({ queryKey: queryKeys.session(result.sessionId) })
                await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
                if (result.sessionId && result.sessionId !== errorSessionId) {
                    retargetSharePendingTransfer(errorSessionId, result.sessionId)
                    await transferComposerDraftThenNavigate(
                        errorSessionId,
                        result.sessionId,
                        () => navigate({
                            to: '/sessions/$sessionId',
                            params: { sessionId: result.sessionId },
                            replace: true,
                            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
                        }),
                    )
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : t('dialog.error.default')
                addToast({
                    title: t('resume.failed.title'),
                    body: message,
                    sessionId: errorSessionId,
                    url: ''
                })
            } finally {
                setReopeningSessionId(null)
            }
        })()
    }, [api, queryClient, navigate, addToast, t])

    const cursorReopenGate = resolveCursorReopenGate({
        applicable: cursorChatStoreApplicable,
        onDisk: cursorChatStoreStatus?.onDisk,
        error: cursorChatStoreError,
        isLoading: cursorChatStoreLoading,
    })
    const cursorReopenDisabledReason = cursorReopenGate.disabledReason === 'missing'
        ? t('session.action.reopenCursorMissing')
        : cursorReopenGate.disabledReason === 'checking'
            ? t('session.action.reopenCursorChecking')
            : undefined
    const cursorReopenUnverifiedHint = cursorReopenGate.probeUnverified
        ? t('session.action.reopenCursorUnverified')
        : undefined
    const canOfferInactiveReopen = session
        ? inactiveSessionCanResume(session, messages.length, cursorChatStoreStatus?.onDisk)
        : false
    const rawSendError = sendErrors[sessionId] ?? null
    const sendError: ComposerSendError | null = rawSendError
        ? {
            id: rawSendError.id,
            text: rawSendError.text,
            message: rawSendError.message,
            scheduledAt: rawSendError.scheduledAt,
            deliveryMode: rawSendError.deliveryMode,
            mutationStarted: rawSendError.mutationStarted,
            restoreSuppressed: rawSendError.restoreSuppressed,
            attachmentDrafts: rawSendError.attachmentDrafts,
            action: rawSendError.code === 'session_inactive' && canOfferInactiveReopen
                ? {
                    label: t('chat.sendError.sessionInactive.action'),
                    onClick: () => reopenFromErrorAffordance(sessionId),
                    pending: reopeningSessionId === sessionId
                }
                : null
        }
        : null

    const resolvedSessionRef = useRef<{ source: string; target: Promise<string> } | null>(null)
    // Clear when the session id or active flag changes so a same-id resume
    // that later archives again cannot reuse a stale in-flight/cached resume.
    useEffect(() => {
        resolvedSessionRef.current = null
    }, [session?.id, session?.active])
    const resolveSessionId = useCallback(async (currentSessionId: string) => {
        if (!api || !session || session.active) {
            return { sessionId: currentSessionId, resumed: false }
        }
        const cached = resolvedSessionRef.current
        if (cached?.source === currentSessionId) {
            return { sessionId: await cached.target, resumed: true }
        }
        if (!inactiveSessionCanResume(session, messages.length, cursorChatStoreStatus?.onDisk)) {
            throw new ApiError(
                t('chat.sendError.sessionInactive'),
                409,
                'session_inactive',
            )
        }
        try {
            const target = api.resumeSession(currentSessionId, { permissionMode: session.permissionMode ?? undefined })
            resolvedSessionRef.current = { source: currentSessionId, target }
            return { sessionId: await target, resumed: true }
        } catch (error) {
            if (resolvedSessionRef.current?.source === currentSessionId) {
                resolvedSessionRef.current = null
            }
            const message = error instanceof Error ? error.message : t('dialog.error.default')
            addToast({
                title: t('resume.failed.title'),
                body: message,
                sessionId: currentSessionId,
                url: ''
            })
            throw new ApiError(
                t('chat.sendError.sessionInactive'),
                409,
                'session_inactive',
            )
        }
    }, [api, session, messages.length, cursorChatStoreStatus?.onDisk, t, addToast])

    const handleSessionResolved = useCallback((resolvedSessionId: string) => {
        if (session) {
            if (resolvedSessionId !== session.id) {
                retargetSharePendingTransfer(session.id, resolvedSessionId)
                seedMessageWindowFromSession(session.id, resolvedSessionId)
            }
            queryClient.setQueryData(queryKeys.session(resolvedSessionId), (previous: { session?: typeof session } | undefined) => ({
                session: { ...(previous?.session ?? session), id: resolvedSessionId, active: true }
            }))
            void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        }
        navigate({
            to: '/sessions/$sessionId',
            params: { sessionId: resolvedSessionId },
            replace: true,
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
        if (api) {
            void refreshSessionDetailPreservingActive(
                queryClient,
                resolvedSessionId,
                () => api.getSession(resolvedSessionId),
            )
            void syncTailMessages(api, resolvedSessionId).catch(() => {})
        }
    }, [api, navigate, queryClient, session])

    const {
        sendMessage,
        retryMessage,
        discardFailedMessage,
        isSending,
        sendSettlement,
    } = useSendMessage(api, sessionId, {
        retainFailureAfterUnmount: true,
        isSessionThinking: session?.thinking ?? false,
        onSuccess: (sentSessionId) => {
            clearDraftsAfterSend(sentSessionId, sessionId)
            // 中文注释：一旦用户已经在 Hapi 内继续这个 Codex 会话，就清除"刚从 Codex 导入"的标记。
            clearCodexImportedSession(session?.metadata?.codexSessionId)
            // A successful send supersedes any previously-rendered error
            // for that session.  Other sessions' errors stay put.
            setSendErrors((prev) => {
                if (!(sentSessionId in prev)) return prev
                const next = { ...prev }
                delete next[sentSessionId]
                return next
            })
        },
        onError: (info: SendErrorInfo) => {
            const errorId = nextSendErrorId()
            const { message, code } = classifySendError(info.error, t)
            setSendErrors((prev) => ({
                ...prev,
                [info.sessionId]: {
                    id: errorId,
                    text: info.text,
                    message,
                    code,
                    scheduledAt: info.scheduledAt,
                    deliveryMode: info.deliveryMode,
                    mutationStarted: info.mutationStarted,
                    restoreSuppressed: false,
                    attachmentDrafts: info.attachmentDrafts,
                }
            }))
        },
        resolveSessionId,
        onSessionResolved: async (resolvedSessionId, context) => {
            if (!sessionId) return undefined
            setSendErrors((prev) => migrateSuppressedSendError(prev, sessionId, resolvedSessionId))
            await transferComposerDraftThenNavigate(
                sessionId,
                resolvedSessionId,
                () => handleSessionResolved(resolvedSessionId),
                context.attachmentDrafts,
                // assistant-ui clears composer text without awaiting this path;
                // keep the submitted snapshot so deferred hydration still has it.
                { textOverride: context.text },
            )
            // Cross-session resume: visible metadata may still carry source-scoped
            // upload paths, and inactive remounts hide stored files entirely.
            // Always defer so the active target can hydrate/re-upload before POST.
            const stored = await getDraftAttachments(resolvedSessionId)
            if ((context.attachments?.length ?? 0) > 0 || stored.length > 0) {
                return { deferUntilDraftHydrated: true }
            }
            return undefined
        },

        onBlocked: (reason) => {
            if (reason === 'no-api') {
                addToast({
                    title: t('send.blocked.title'),
                    body: t('send.blocked.noConnection'),
                    sessionId: sessionId ?? '',
                    url: ''
                })
            }
            // 'no-session' and 'pending' don't need toast - either invalid state or expected behavior
        }
    })

    // Get agent type from session metadata for slash commands
    const agentType = session?.metadata?.flavor ?? 'claude'
    const {
        commands: slashCommands,
        getSuggestions: getSlashSuggestions,
    } = useSlashCommands(api, sessionId, agentType)
    const {
        getSuggestions: getSkillSuggestions,
    } = useSkills(api, sessionId)
    // Mention pool is stricter than sidebar (#1506): titled sessions only; match via sessionMatchesQuery.
    const { sessions: allSessions } = useSessions(api)
    const { machines: mentionMachines } = useMachines(api, true)
    const mentionMachineLabelsById = useMachineLabels(mentionMachines)
    // Same fallbacks as share picker / SessionList search.
    const resolveMentionMachineLabel = useCallback((machineId: string | null) => {
        if (machineId && mentionMachineLabelsById[machineId]) {
            return mentionMachineLabelsById[machineId]
        }
        if (machineId) {
            return machineId.slice(0, 8)
        }
        return t('machine.unknown')
    }, [mentionMachineLabelsById, t])

    const getAutocompleteSuggestions = useCallback(async (query: string) => {
        if (query.startsWith('@')) {
            const search = query.slice(1)
            // v1: plain-text expansion (same grammar as Copy reference) — #1213.
            // v2: segmented rich composer with inline session tokens — #1215.
            // Match via sessionMatchesQuery (share/sidebar); label/insert via getSessionTitle.
            const sessionHits = matchSessionsForMention(allSessions, search, {
                excludeId: sessionId,
                limit: 20,
                resolveMachineLabel: resolveMentionMachineLabel,
            }).map((s) => {
                const title = getSessionTitle(s)
                const mentionText = buildSessionReferenceText(title, s.id)
                const idPrefix = s.id.slice(0, 8)
                return {
                    key: `session:${s.id}`,
                    text: mentionText,
                    label: `@${title || idPrefix}`,
                    description: s.active
                        ? `Session · ${idPrefix} · active`
                        : `Session · ${idPrefix}`,
                    // Rich composer atom; textarea path still inserts `text` prose.
                    sessionMention: { id: s.id, title: title || idPrefix },
                }
            })

            const fileHits: Suggestion[] = []
            if ((agentType === 'codex' || agentType === 'copilot') && api && sessionId) {
                const response = await api.searchSessionFiles(sessionId, search, 50)
                if (response.success && response.files) {
                    for (const file of response.files) {
                        // Codex App Server expects @"path"; Copilot CLI uses @path (relative preferred).
                        const mentionText = agentType === 'copilot'
                            ? `@${file.fullPath}`
                            : `@"${file.fullPath.replace(/(["\\])/g, '\\$1')}"`
                        fileHits.push({
                            key: mentionText,
                            text: mentionText,
                            label: `@${file.fileName}`,
                            description: file.filePath || file.fullPath,
                        })
                    }
                }
            }

            return [...sessionHits, ...fileHits]
        }
        if (query.startsWith('$')) {
            return await getSkillSuggestions(query)
        }
        return await getSlashSuggestions(query)
    }, [
        agentType,
        api,
        sessionId,
        allSessions,
        resolveMentionMachineLabel,
        getSkillSuggestions,
        getSlashSuggestions,
    ])

    const refreshSelectedSession = useCallback(async () => {
        await Promise.all([
            refetchSession(),
            refetchMessages(),
        ])
    }, [refetchMessages, refetchSession])

    const handleInitialOutlineConsumed = useCallback(() => {
        if (props.onOutlineConsumed) { props.onOutlineConsumed(); return }
        navigate({
            to: '/sessions/$sessionId',
            params: { sessionId },
            replace: true,
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, sessionId, props.onOutlineConsumed])

    if (!session) {
        if (sessionError) {
            return (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
                    <div className="text-sm font-medium text-[var(--app-fg)]">Session unavailable</div>
                    <div className="max-w-md text-xs text-[var(--app-hint)]">{sessionError}</div>
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={() => navigate({ to: '/sessions', replace: true })}
                            className="rounded-md border border-[var(--app-border)] px-3 py-1.5 text-sm text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]"
                        >
                            Back to sessions
                        </button>
                        <button
                            type="button"
                            onClick={() => { void refetchSession() }}
                            className="rounded-md bg-[var(--app-button)] px-3 py-1.5 text-sm text-[var(--app-button-text)]"
                        >
                            Retry
                        </button>
                    </div>
                </div>
            )
        }
        return (
            <div className="flex-1 flex items-center justify-center p-4">
                <LoadingState label="Loading session…" className="text-sm" />
            </div>
        )
    }

    return (
        <SessionChat
            api={api}
            titleSuggestionAvailable={titleSuggestionAvailable}
            session={session}
            cursorChatOnDisk={cursorChatStoreStatus?.onDisk}
            reopenDisabledReason={cursorReopenDisabledReason}
            reopenHint={cursorReopenUnverifiedHint}
            messages={messages}
            messagesWarning={messagesWarning}
            hasMoreMessages={messagesHasMore}
            isSyncingTail={messagesSyncingTail}
            isLoadingMoreMessages={messagesLoadingMore}
            isSending={isSending}
            sendSettlement={sendSettlement}
            viewMode={messagesViewMode}
            messagesEpoch={messagesEpoch}
            messagesVersion={messagesVersion}
            historyVersion={historyVersion}
            tailRevision={tailRevision}
            onBack={goBack}
            onRefresh={refreshSelectedSession}
            onLoadMore={loadMoreMessages}
            onCancelLoadMore={cancelLoadMoreMessages}
            onSend={sendMessage}
            resolveSessionIdForUpload={async (id) => (await resolveSessionId(id)).sessionId}
            onUploadSessionResolved={handleSessionResolved}
            onViewModeChange={setViewMode}
            onRetryMessage={retryMessage}
            onDiscardFailedMessage={discardFailedMessage}
            autocompleteSuggestions={getAutocompleteSuggestions}
            availableSlashCommands={slashCommands}
            sendError={sendError}
            onClearSendError={clearSendError}
            onSuppressSendErrorRestore={suppressSendErrorRestore}
            initialOutlineOpen={outline}
            onInitialOutlineConsumed={handleInitialOutlineConsumed}
            onAbortRestore={(text) => {
                const errorId = nextSendErrorId()
                setSendErrors((prev) => ({
                    ...prev,
                    [sessionId]: {
                        id: errorId,
                        text,
                        message: t('chat.sendError.aborted'),
                        code: 'abort',
                        scheduledAt: null,
                        deliveryMode: 'queue',
                        mutationStarted: true,
                        restoreSuppressed: false
                    }
                }))
            }}
        />
    )
}
