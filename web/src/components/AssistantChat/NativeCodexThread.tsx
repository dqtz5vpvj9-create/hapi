import { usePane } from '@/workspace/PaneContext'
import { Component, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ThreadPrimitive, useAuiState } from '@assistant-ui/react'
import { useRouter } from '@tanstack/react-router'
import { NativeChatViewport } from '@/chat/nativeViewport'
import type { NativeChatProjection } from '@/chat/nativeProjection'
import { useChatScroll } from '@/chat/dsh/use-chat-scroll'
import { getMessageReadingAnchor, saveMessageReadingAnchor, getMessageWindowState, subscribeMessageWindow, openMessageContext, syncTailMessages, fetchNewerHistory, getHistoryPreloadRequest, VISIBLE_WINDOW_SIZE } from '@/lib/message-window-store'
import { useHistoryPreload } from '@/hooks/useHistoryPreload'
import { useConversationOutlineHistory } from '@/hooks/useConversationOutlineHistory'
import { useTerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import { useSessionSummaryInChat } from '@/hooks/useSessionSummaryInChat'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { useTranslation } from '@/lib/use-translation'
import { GlassSource } from '@/themes/glass/GlassScene'
import { HappyChatProvider, type HappyChatContextValue } from './context'
import { WindowedMessageList, type MessageListNavigation } from './VirtualMessageList'
import { ConversationOutlinePanel, MessageSkeleton, ScrollToBottomButton, THREAD_MESSAGE_COMPONENTS, type HappyThreadProps } from './HappyThread'
import { MessageSyncStatus } from './MessageSyncStatus'
import { getExecutionPresentation } from './executionState'
import { useThreadShare } from './useThreadShare'
import { useInitialChatPresentation } from './useInitialChatPresentation'
import './native-thread.css'

const NativeSeat = memo(function NativeSeat({ id, projection, toggle, toggleGroup }: {
    id: string; projection: NativeChatProjection; toggle: (key: string, answer: string, open: boolean) => void
    toggleGroup: (key: string, open: boolean) => void
}) {
    const source = projection.source(id)
    const node = useSyncExternalStore(source.subscribe, source.getSnapshot)
    if (!node) return null
    const process = node.process
    const group = node.group
    return <div data-native-tool-row={node.block.kind === 'tool-call' ? 'true' : 'false'} data-chat-anchor-key={id} data-chat-node-key={id} data-chat-paging-anchor id={`native-seat-${id}`}>
        {process?.control ? <button type="button" className="hapi-native-process" aria-expanded={process.open}
            onClick={() => toggle(process.key, process.answer, !process.open)}>
            <span aria-hidden>{process.open ? '⌄' : '›'}</span> <ProcessLabel count={process.count} />
        </button> : null}
        {!process || process.open ? <div>
            {group?.control ? <button type="button" className="hapi-native-process" aria-expanded={group.open}
                onClick={() => toggleGroup(group.key, !group.open)}>
                <span aria-hidden>{group.open ? '⌄' : '›'}</span>
                <span className={group.running ? 'hapi-execution-sweep' : undefined}>
                    <ProcessLabel count={group.count} />{group.detail ? ` · ${group.detail}` : ''}
                </span>
            </button> : null}
            {!group || group.open ? <div>
                <ThreadPrimitive.Unstable_MessageById messageId={node.messageKey ?? id} components={THREAD_MESSAGE_COMPONENTS} />
            </div> : null}
        </div> : null}
    </div>
})

function ProcessLabel({ count }: { count: number }) {
    const { t } = useTranslation()
    return <>{t('nativeChat.process', { count })}</>
}

/** Sample the still-visible DOM after render work, immediately before React
 * mutates a paged window. Layout effects run after that mutation and are too
 * late to observe the reader's last compositor movement in the old layout. */
class NativePageCommit extends Component<{ revision: number; viewport: NativeChatViewport; children: ReactNode }> {
    getSnapshotBeforeUpdate(previous: Readonly<typeof this.props>) {
        if (previous.revision !== this.props.revision) this.props.viewport.refreshPreservedReading()
        return null
    }
    componentDidUpdate() { /* Position restoration belongs to the viewport's layout callback. */ }
    render() { return this.props.children }
}

/** Native body only. The existing runtime still owns the composer and actions. */
export function NativeCodexThread(props: HappyThreadProps) {
    const projection = props.nativeProjection!
    const router = useRouter({ warn: false })
    const { t } = useTranslation()
    const online = useOnlineStatus()
    const { terminalToolDisplayMode } = useTerminalToolDisplayMode()
    const showSessionSummaryInChat = useSessionSummaryInChat()
    const pane = usePane()
    const [viewport] = useState(() => new NativeChatViewport(projection))
    const [initialReadingId] = useState(() => getMessageReadingAnchor(props.sessionId)?.id)
    const attachNavigation = useCallback((value: MessageListNavigation | null) => { viewport.navigation = value }, [viewport])
    const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
    const [disclosureVersion, redraw] = useState(0)
    viewport.onReveal = () => redraw(value => value + 1)
    const latest = useRef(props); latest.current = props
    const runtimeExtras = useAuiState(s => s.thread.extras) as { messagesVersion?: number } | undefined
    const initialCoverage = useRef({ done: Boolean(initialReadingId), pending: false, frontier: '', pages: 0 })
    const checkInitialCoverage = useRef(() => {})
    const checkPresentation = useRef(() => {})
    const cancelInitialCoverage = useCallback(() => { initialCoverage.current.done = true }, [])
    const outline = useConversationOutlineHistory(props.api, props.sessionId, props.outlineItems, props.outlineEpoch, props.outlineOpen)
    const windowState = useSyncExternalStore(
        useCallback(listener => subscribeMessageWindow(props.sessionId, listener), [props.sessionId]),
        () => getMessageWindowState(props.sessionId),
    )
    const loadPending = useRef(false)
    const navigationRef = useRef<import('@/chat/dsh/use-chat-navigation').ChatNavigation | null>(null)
    const outlineSelection = useRef(false)
    const targets = useRef(new Map<number, string>())
    const loadedTurns = useMemo(() => projection.blocks.flatMap(block => {
        const seq = (block.meta as { nativeSourceSeq?: number } | undefined)?.nativeSourceSeq
            // Flat fallback text keeps reducerTimeline's message-id:part-index
            // identity. Its last part is a valid virtual destination too.
            ?? windowState.messages.find(message => message.id === block.id
                || (block.kind === 'agent-text' && block.id.startsWith(`${message.id}:`)))?.seq
        return typeof seq === 'number' ? [{ turn: seq, anchorKey: `${block.kind}:${block.id}` }] : []
    }), [projection.blocks, windowState.messages])
    const loadedTurnsRef = useRef(loadedTurns)
    loadedTurnsRef.current = loadedTurns
    const chatScroll = useMemo(() => ({
        read: () => {
            const reading = getMessageReadingAnchor(props.sessionId)
            return reading ? { anchorKey: reading.id, anchorTop: reading.topOffset, scrollTop: 0, reading } : null
        },
        save: (position: import('@/chat/dsh/types').ChatScrollPosition | null) => {
            saveMessageReadingAnchor(props.sessionId, position?.reading ?? (position ? {
                id: `hapi-message-${position.anchorKey}`, topOffset: position.anchorTop,
            } : null))
        },
    }), [props.sessionId])
    const preparePageCommit = useRef(() => true)
    const observeScroll = useRef((_scroll: import('@/chat/dsh/use-chat-viewport').ViewportScroll) => {})
    const onViewportScroll = useCallback((event: import('@/chat/dsh/use-chat-viewport').ViewportScroll) => observeScroll.current(event), [])
    const tailRequested = useRef(false)
    const windowEndRequested = useRef(false)
    const loadOlder = useCallback(() => {
        void latest.current.onLoadMore(() => preparePageCommit.current()).finally(() => { loadPending.current = false })
    }, [])
    const loadThrough = useCallback(async (seq: number) => {
        const target = targets.current.get(seq)
        if (!target || projection.get(projection.ownerOf(target))
            || getMessageWindowState(props.sessionId).messages.some(row => `user-text:${row.id}` === target)) return
        const version = viewport.navigationVersion
        const applied = await openMessageContext(props.api, props.sessionId, target.replace(/^user-text:/, ''),
            () => viewport.navigationVersion === version)
        if (!applied && viewport.navigationVersion === version) navigationRef.current?.cancel()
    }, [projection, props.api, props.sessionId, viewport])
    const lastKey = projection.order.at(-1) ?? null
    const scroll = useChatScroll({
        ready: windowState.messages.length > 0 || windowState.lastSyncedAt !== undefined,
        order: projection.order, firstSeq: windowState.oldestSeq,
        // A bounded window can end at an old user message after paging. Only
        // HAPI's accepted-submission token denotes the reader's own new input.
        lastKey, lastIsUser: false,
        steeringId: null, submissionId: props.forceScrollToken ? String(props.forceScrollToken) : null,
        running: props.session.thinking, loadedTurns, chatScroll,
        hasMore: props.hasMoreMessages, loadingOlder: props.isLoadingMoreMessages, loadOlder, loadThrough,
        historyEpoch: windowState.epoch,
        onViewportScroll,
    }, viewport)
    navigationRef.current = scroll.navigation
    const layoutState = useRef(scroll)
    layoutState.current = scroll
    const beforeVirtualLayout = useCallback(() => {
        const current = layoutState.current
        if (current.reading.initialized && !current.reading.followingTail && !current.busy) viewport.captureVirtualLayout()
    }, [viewport])
    useEffect(() => {
        if (outlineSelection.current && !scroll.busy) {
            outlineSelection.current = false
            props.onOutlineOpenChange(false)
        }
    }, [scroll.busy, props.onOutlineOpenChange])
    useEffect(() => {
        if (!props.outlineOpen && outlineSelection.current) {
            outlineSelection.current = false
            scroll.navigation.cancel()
        }
    }, [props.outlineOpen, scroll.navigation])
    // The window may evict rows as well as prepend them. Sample the latest
    // reader position before the store publishes, then let DSH Navigation own
    // its restoration after the virtual mount commit.
    preparePageCommit.current = () => {
        scroll.reading.onScrollEnd()
        viewport.preparePageCommit()
        return true
    }
    const attachViewport = useCallback((element: HTMLDivElement | null) => {
        scroll.listRef.current = element
        setScrollElement(element)
    }, [scroll.listRef])
    const preload = useHistoryPreload(props.api, props.sessionId, scroll.listRef, true)
    const share = useThreadShare(props, scroll.columnRef)
    const execution = getExecutionPresentation(props.session, projection.blocks, props.executionConnected === true && online, props.executionAtTail === true)

    // Projection data is replaced in the parent; disclosure only changes view
    // facts and never reparents the answer or retains an unbounded DOM.
    const toggle = useCallback((key: string, answer: string, open: boolean) => {
        projection.setOpen(key, answer, open)
        projection.refreshPresentation()
        projection.publish()
        redraw(value => value + 1)
    }, [projection])
    const toggleGroup = useCallback((key: string, open: boolean) => {
        projection.setGroupOpen(key, open)
        projection.refreshPresentation()
        projection.publish()
        redraw(value => value + 1)
    }, [projection])
    const ids = useMemo(() => projection.order.filter(key => !projection.get(key)?.hidden),
        [projection, projection.order, projection.blocks, projection.layoutVersion, disclosureVersion])
    checkInitialCoverage.current = () => {
        const coverage = initialCoverage.current
        const element = scroll.listRef.current, column = scroll.columnRef.current
        if (coverage.done || coverage.pending || !element?.getClientRects().length || !column
            || !scroll.reading.initialized || props.isSyncingTail || props.isLoadingMoreMessages
            || windowState.hasMoreAfter
            || runtimeExtras?.messagesVersion !== props.messagesVersion
            || getMessageWindowState(props.sessionId).messagesVersion !== props.messagesVersion) return
        // The keyed source publishes after the parent projection. Until a
        // seat is mounted, its empty virtual wrapper is not measured content.
        if (ids.length > 0 && !column.querySelector('[data-chat-node-key]')) return
        // Rows can already overflow a virtual spacer whose cached height is
        // still catching up. The scrollport includes that real content.
        if (!scroll.reading.followingTail || scroll.reading.pending || scroll.busy
            || !props.hasMoreMessages || element.scrollHeight > element.clientHeight + 1
            || windowState.messages.length >= VISIBLE_WINDOW_SIZE || coverage.pages >= 2) {
            coverage.done = true
            return
        }
        const request = getHistoryPreloadRequest(props.sessionId, 'before')
        if (!request) return
        const frontier = JSON.stringify(request)
        if (coverage.frontier === frontier) return
        coverage.frontier = frontier
        coverage.pending = true
        // At most two bounded history pages, including pages filtered to zero
        // visible rows. An idle opening must never crawl the full transcript.
        coverage.pages++
        // This fills a first viewport at the latest position. Unlike explicit
        // older-history navigation, it must not pause DSH's existing tail owner
        // or retain the blank space below a short, collapsed first page.
        void props.onLoadMore(() => !coverage.done && scroll.reading.followingTail
            && !scroll.reading.pending && Boolean(element.getClientRects().length))
            .then(outcome => { if (outcome.kind !== 'applied') coverage.done = true })
            .finally(() => { coverage.pending = false; checkInitialCoverage.current(); checkPresentation.current() })
    }
    useLayoutEffect(() => { checkInitialCoverage.current() })
    const onMessageLayout = useCallback(() => {
        viewport.layoutCommitted()
        checkInitialCoverage.current()
        checkPresentation.current()
    }, [viewport])
    const renderRow = useCallback((id: string) => <NativeSeat id={id} projection={projection} toggle={toggle} toggleGroup={toggleGroup} />, [projection, toggle, toggleGroup])
    const loadEarlier = useCallback(() => {
        if (loadPending.current || latest.current.isLoadingMoreMessages || !latest.current.hasMoreMessages) return
        loadPending.current = true
        scroll.navigation.loadEarlier()
    }, [scroll.navigation])
    useEffect(() => { if (!props.isLoadingMoreMessages) loadPending.current = false }, [props.isLoadingMoreMessages, props.historyVersion])
    useLayoutEffect(() => {
        if (scroll.initialized) props.onViewModeChange(scroll.followingTail && (!windowState.hasMoreAfter || tailRequested.current) ? 'tail' : 'history')
    }, [scroll.initialized, scroll.followingTail, windowState.hasMoreAfter, props.onViewModeChange])
    const returnLatest = useCallback(() => {
        windowEndRequested.current = false
        const needsLatest = getMessageWindowState(props.sessionId).hasMoreAfter
        tailRequested.current = true
        scroll.navigation.cancel()
        saveMessageReadingAnchor(props.sessionId, null)
        props.onViewModeChange('tail')
        scroll.returnToBottom()
        if (needsLatest) void syncTailMessages(props.api, props.sessionId, { ensureAfterCurrent: true })
    }, [scroll.navigation, scroll.returnToBottom, props.onViewModeChange, props.api, props.sessionId])
    useEffect(() => {
        if (scroll.busy || !windowEndRequested.current) return
        windowEndRequested.current = false
        const element = scroll.listRef.current
        if (!element || element.scrollHeight - element.scrollTop - element.clientHeight > 24) return
        if (!getMessageWindowState(props.sessionId).hasMoreAfter) return
        scroll.reading.pauseFollowing()
        void fetchNewerHistory(props.api, props.sessionId, () => { preparePageCommit.current() })
    }, [scroll.busy, scroll.reading, scroll.listRef, props.api, props.sessionId])
    useLayoutEffect(() => {
        const element = scroll.listRef.current
        if (!element) return
        let touchY: number | null = null
        // At a clamped window edge another gesture may produce no scroll
        // event. Both directions must also react to input at that boundary.
        const loadLaterAtEdge = () => {
            if (element.scrollHeight - element.scrollTop - element.clientHeight < element.clientHeight
                && getMessageWindowState(props.sessionId).hasMoreAfter) {
                void fetchNewerHistory(props.api, props.sessionId, () => { preparePageCommit.current() })
            }
        }
        const wheel = (event: WheelEvent) => {
            cancelInitialCoverage()
            preload.input(event.deltaY < 0 ? 'before' : 'after', event.deltaY)
            if (event.deltaY < 0 && element.scrollTop < element.clientHeight) loadEarlier()
            else if (event.deltaY > 0) loadLaterAtEdge()
        }
        const touchStart = (event: TouchEvent) => { cancelInitialCoverage(); touchY = event.touches[0]?.clientY ?? null; preload.pointer(true) }
        const touchMove = (event: TouchEvent) => {
            const y = event.touches[0]?.clientY
            if (y === undefined || touchY === null) return
            const delta = touchY - y; touchY = y
            preload.input(delta < 0 ? 'before' : 'after', delta)
            if (delta < 0 && element.scrollTop < element.clientHeight) loadEarlier()
            else if (delta > 0) loadLaterAtEdge()
        }
        const touchEnd = () => { touchY = null; preload.pointer(false) }
        const keyDown = (event: KeyboardEvent) => {
            cancelInitialCoverage()
            if (event.key !== 'End' || event.shiftKey || event.altKey
                || (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable]'))) return
            event.preventDefault()
            if (!getMessageWindowState(props.sessionId).hasMoreAfter) { scroll.returnToBottom(); return }
            const last = loadedTurnsRef.current.at(-1)
            if (!last) return
            // A native End uses an estimated document height. Navigate to the
            // known last row through DSH's cancellable mount/landing task.
            windowEndRequested.current = true
            scroll.navigation.navigateToTurn({ turn: last.turn, align: 'end', anchor: { kind: 'unloaded', seq: last.turn } })
        }
        observeScroll.current = ({ movedByReader, metrics }) => {
            preload.scroll(!movedByReader)
            const top = metrics.top, delta = viewport.readerDelta
            if (!movedByReader) return
            cancelInitialCoverage()
            if (metrics.floor - top > 24) {
                tailRequested.current = false
                latest.current.onViewModeChange('history')
            }
            if (delta < 0 && top < element.clientHeight) loadEarlier()
            else if (delta > 0) loadLaterAtEdge()
        }
        element.addEventListener('wheel', wheel, { passive: true })
        element.addEventListener('touchstart', touchStart, { passive: true })
        element.addEventListener('touchmove', touchMove, { passive: true })
        element.addEventListener('touchend', touchEnd, { passive: true })
        element.addEventListener('keydown', keyDown)
        return () => {
            observeScroll.current = () => {}
            element.removeEventListener('wheel', wheel)
            element.removeEventListener('touchstart', touchStart); element.removeEventListener('touchmove', touchMove); element.removeEventListener('touchend', touchEnd)
            element.removeEventListener('keydown', keyDown)
        }
    }, [scroll.listRef, scroll.navigation, scroll.returnToBottom, preload.input, preload.scroll, preload.pointer, loadEarlier, props.api, props.sessionId, viewport, cancelInitialCoverage])
    useLayoutEffect(() => {
        const save = () => {
            if (pane?.root.current && getComputedStyle(pane.root.current).visibility === 'hidden') return
            // Workspace synchronization also captures mounted panes during
            // initial loading. Their provisional DOM is not a new reader
            // position and must not replace the bookmark being restored.
            if (!scroll.reading.initialized) return
            scroll.reading.onScrollEnd()
            const position = scroll.reading.followingTail ? null : viewport.capturePosition()
            if (position) chatScroll.save(position)
        }
        viewport.onDetach = save
        pane?.beforeHide.add(save)
        // A route transition can change ancestor layout before this child's
        // detach cleanup. Capture the reader while the old page is intact and
        // do not overwrite that bookmark using partially dismantled geometry.
        const unsubscribe = router?.subscribe('onBeforeNavigate', event => {
            if (!event.pathChanged) return
            save()
            viewport.onDetach = undefined
        })
        window.addEventListener('pagehide', save)
        return () => { pane?.beforeHide.delete(save); unsubscribe?.(); viewport.onDetach = undefined; window.removeEventListener('pagehide', save) }
    }, [chatScroll, viewport, scroll.reading, router, pane?.beforeHide])

    // DSH updates the active reading turn independently of message content.
    // Keep that chrome-only update out of every mounted business component.
    // Send hooks replace these handlers on each window update. Message actions
    // call the latest handler without invalidating every unchanged card.
    const canRetry = Boolean(props.onRetryMessage)
    const canDiscard = Boolean(props.onDiscardFailedMessage)
    const retryMessage = useCallback((id: string) => latest.current.onRetryMessage?.(id), [])
    const discardFailedMessage = useCallback((id: string) => latest.current.onDiscardFailedMessage?.(id), [])
    const chatContext = useMemo<HappyChatContextValue>(() => ({
        api: props.api, sessionId: props.sessionId, metadata: props.metadata, terminalToolDisplayMode,
        disclosureState: projection.disclosureState,
        showSessionSummaryInChat, activeExecutionToolId: execution.activeToolId, disabled: props.disabled,
        onRefresh: props.onRefresh, onContinuePlan: props.onContinuePlan,
        codexPlanProposalId: props.session.agentState?.codexPlanProposalId,
        onRetryMessage: canRetry ? retryMessage : undefined, onDiscardFailedMessage: canDiscard ? discardFailedMessage : undefined,
        historyActionPending: props.historyActionPending, onForkConversation: props.onForkConversation,
        onRewindConversation: props.onRewindConversation, isLatestCompletedBoundary: props.isLatestCompletedBoundary,
        onShareTurn: share.open, hasMoreMessages: props.hasMoreMessages, isSyncingTail: props.isSyncingTail,
        isLoadingMoreMessages: props.isLoadingMoreMessages,
        onNestedScrollFollowChange: following => { if (!following) scroll.reading.pauseFollowing() },
        loadOlderMessagesPreservingScroll: async () => {
            viewport.beginPaging(); scroll.reading.pauseFollowing()
            const result = await props.onLoadMore(() => preparePageCommit.current())
            return result.kind === 'applied' ? 'loaded' : result.kind === 'failed' ? 'transient-stop' : 'terminal-stop'
        },
    }), [props.api, props.sessionId, props.metadata, props.disabled, props.onRefresh, props.onContinuePlan,
        props.session.agentState?.codexPlanProposalId, canRetry, canDiscard, retryMessage, discardFailedMessage,
        props.historyActionPending, props.onForkConversation, props.onRewindConversation,
        props.isLatestCompletedBoundary, props.hasMoreMessages, props.isSyncingTail, props.isLoadingMoreMessages,
        props.onLoadMore, terminalToolDisplayMode, projection.disclosureState, showSessionSummaryInChat,
        execution.activeToolId, share.open, scroll.reading, viewport])

    const presentation = useInitialChatPresentation(props.sessionId, scroll.listRef, scroll.columnRef, () => {
        const state = getMessageWindowState(props.sessionId)
        if (!state.messages.length && props.messagesWarning && !props.isSyncingTail) return true
        if ((!state.messages.length && state.lastSyncedAt === undefined)
            || runtimeExtras?.messagesVersion !== props.messagesVersion
            || state.messagesVersion !== props.messagesVersion || !scroll.reading.initialized
            || scroll.busy || initialCoverage.current.pending) return false
        if (!viewport.navigation?.isLayoutReady(scroll.reading.followingTail)) return false
        if (!scroll.reading.followingTail) return true
        const element = scroll.listRef.current!
        if (props.hasMoreMessages && element.scrollHeight <= element.clientHeight + 1
            && !initialCoverage.current.done) return false
        return element.scrollHeight - element.clientHeight - element.scrollTop <= 1
    })
    checkPresentation.current = presentation.check

    return <HappyChatProvider value={chatContext}>
        <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col relative hapi-native-thread" data-following-tail={scroll.followingTail}>
            <MessageSyncStatus api={props.api} sessionId={props.sessionId} />
            <GlassSource>
                <div ref={attachViewport} data-conversation-scroll tabIndex={0} onPointerDownCapture={cancelInitialCoverage}
                    className="app-scroll-y chat-scroll-y scrollbar-auto-hide min-h-0 flex-1 overflow-x-hidden focus:outline-none">
                    <div ref={scroll.columnRef} className="chat-scroll-content mx-auto w-full max-w-content min-w-0 p-3"
                        data-chat-presented={presentation.presented} aria-hidden={!presentation.presented} inert={!presentation.presented}
                        style={{ visibility: presentation.presented ? undefined : 'hidden' }}>
                        {props.messagesWarning ? <div role="alert" className="mb-3 rounded-md bg-amber-500/10 p-2 text-xs">{props.messagesWarning}</div> : null}
                        <div className="happy-thread-messages flex flex-col gap-3">
                            <NativePageCommit revision={props.historyVersion} viewport={viewport}>
                            <WindowedMessageList rowGap={4} ids={ids} scrollElement={scrollElement} ownerOf={projection.ownerOf}
                                measurements={projection.measurements}
                                navigationRef={attachNavigation} savedAnchorId={initialReadingId}
                                renderRow={renderRow} onLayout={onMessageLayout}
                                onBeforeLayout={beforeVirtualLayout} onAfterLayout={viewport.restoreVirtualLayout} />
                            </NativePageCommit>
                        </div>
                        {execution.thinking ? <div role="status" className="hapi-execution-thinking"><span className="hapi-execution-sweep">{t('session.item.thinking')}</span></div> : null}
                        <div aria-hidden="true" style={{ height: 'var(--native-reading-tail-room, 0px)', overflowAnchor: 'none' }} />
                    </div>
                </div>
            </GlassSource>
            {!presentation.presented ? <div className="pointer-events-none absolute inset-0 overflow-hidden" data-chat-opening>
                <div className="chat-scroll-content mx-auto w-full max-w-content p-3"><MessageSkeleton /></div>
            </div> : null}
            {!scroll.followingTail || windowState.hasMoreAfter ? <ScrollToBottomButton onClick={returnLatest} count={props.unseenCount > 0 ? props.unseenCount : undefined} /> : null}
            {outline.readingNotice ? <div role="status" className="app-thread-reading-notice">{t('session.history.neighborRestored')}</div> : null}
            {props.outlineOpen ? <ConversationOutlinePanel items={outline.items} hasMoreMessages={outline.hasMore}
                isLoadingMoreMessages={outline.isLoading} error={outline.error} isIndexing={outline.isIndexing} partial={outline.partial}
                onLoadMore={() => { void outline.loadMore() }} onClose={() => {
                    outlineSelection.current = false
                    scroll.navigation.cancel()
                    props.onOutlineOpenChange(false)
                }}
                onSelect={item => {
                    const seq = outline.positions.get(item.targetMessageId)?.seq
                    outlineSelection.current = true
                    targets.current.clear()
                    if (seq !== undefined) {
                        targets.current.set(seq, item.targetMessageId)
                        scroll.navigation.navigateToTurn({ turn: seq, anchor: { kind: 'unloaded', seq } })
                    } else scroll.navigation.resolveTarget(async current => {
                        const id = item.targetMessageId.replace(/^user-text:/, '')
                        if (!await openMessageContext(props.api, props.sessionId, id, current)) return null
                        const position = getMessageWindowState(props.sessionId).messages.find(row => row.id === id)?.seq
                        if (position == null) return null
                        targets.current.set(position, item.targetMessageId)
                        return { turn: position, anchor: { kind: 'unloaded', seq: position } }
                    })
                }} /> : null}
            {share.element}
        </ThreadPrimitive.Root>
    </HappyChatProvider>
}
