import { useState, useCallback, useEffect, useLayoutEffect, useRef, type FC, type KeyboardEvent, type PropsWithChildren, type UIEvent } from 'react'
import {
    useAuiState,
    type ReasoningGroupProps,
    type ReasoningMessagePartComponent,
} from '@assistant-ui/react'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import { cn } from '@/lib/utils'
import { useReasoningCollapse } from '@/hooks/useReasoningCollapse'
import { useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import {
    MARKDOWN_CLASSNAME,
    MARKDOWN_COMPONENTS_BY_LANGUAGE,
    MARKDOWN_PLUGINS,
    MARKDOWN_REHYPE_PLUGINS,
    defaultComponents,
    denyOnlyTransform,
    UriConfirmProvider,
} from '@/components/assistant-ui/markdown-text'

function ChevronIcon(props: { className?: string; open?: boolean }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={cn(
                'transition-transform duration-200',
                props.open ? 'rotate-90' : '',
                props.className
            )}
        >
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

function ShimmerDot() {
    return (
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
    )
}

export const Reasoning: ReasoningMessagePartComponent = ({ text, status }) => {
    const previousTextRef = useRef(text)
    const runStartedWithRunningRef = useRef(status.type === 'running')
    const hasTextChangedDuringRunRef = useRef(false)

    // The runtime keeps resumed reasoning history complete until a new output
    // block exists. Once this part is actually running, preserve assistant-ui's
    // typewriter from its first paint. A complete -> running transition with
    // unchanged text is still treated as hydration, not new reasoning output.
    if (status.type !== 'running') {
        runStartedWithRunningRef.current = false
        hasTextChangedDuringRunRef.current = false
    } else if (
        text !== previousTextRef.current
    ) {
        hasTextChangedDuringRunRef.current = true
    }
    const smooth = status.type === 'running'
        && (runStartedWithRunningRef.current || hasTextChangedDuringRunRef.current)

    previousTextRef.current = text

    return (
        <UriConfirmProvider>
            <MarkdownTextPrimitive
                smooth={smooth}
                remarkPlugins={MARKDOWN_PLUGINS}
                rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                components={defaultComponents}
                componentsByLanguage={MARKDOWN_COMPONENTS_BY_LANGUAGE}
                urlTransform={denyOnlyTransform}
                className={cn(MARKDOWN_CLASSNAME, 'aui-reasoning-content text-[13.5px] text-[var(--app-hint)]')}
            />
        </UriConfirmProvider>
    )
}

type HappyReasoningGroupProps = PropsWithChildren<
    Partial<Pick<ReasoningGroupProps, 'startIndex' | 'endIndex'>>
>

export const ReasoningGroup: FC<HappyReasoningGroupProps> = ({
    children,
    startIndex = 0,
    endIndex,
}) => {
    const [isOpen, setIsOpen] = useState(false)
    const scrollRef = useRef<HTMLDivElement | null>(null)
    const followLatestRef = useRef(true)
    const pointerActiveRef = useRef(false)
    const pointerCleanupRef = useRef<(() => void) | null>(null)
    const followSyncFrameRef = useRef<number | null>(null)

    const isStreaming = useAuiState((state) => {
        const parts = state.message.parts.slice(startIndex, endIndex === undefined ? undefined : endIndex + 1)
        return parts.some((part) => part.type === 'reasoning' && part.status.type === 'running')
    })
    const { reasoningCollapsed } = useReasoningCollapse()
    const chatContext = useOptionalHappyChatContext()
    // Collapsed rows carry one line of the reasoning so the transcript stays
    // scannable without opening every block.
    const preview = useAuiState((state) => {
        const parts = state.message.parts.slice(startIndex, endIndex === undefined ? undefined : endIndex + 1)
        const text = parts
            .filter((part) => part.type === 'reasoning')
            .map((part) => (part as { text?: string }).text ?? '')
            .join('\n')
        // Same rule as DSH: while streaming, summarize with the first line of the
        // latest completed paragraph; once settled, the block's first line.
        const paragraph = text.split(/\r?\n(?:[\t ]*\r?\n)+/).filter((chunk) => chunk.trim() !== '')
        const source = isStreaming ? paragraph[paragraph.length - 1] ?? text : text
        const firstLine = source.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? ''
        return firstLine.replaceAll('**', '').slice(0, 160)
    })

    const handleToggle = () => {
        const nextOpen = !isOpen
        if (nextOpen && isStreaming) {
            followLatestRef.current = true
        }
        setIsOpen(nextOpen)
    }

    // Collapsing a panel the reader had opened releases the outer chat's
    // follow-tail hold so it scrolls again; a panel that was never opened
    // leaves that hold alone.
    const wasOpenRef = useRef(false)
    useEffect(() => {
        if (isOpen) {
            wasOpenRef.current = true
            return
        }
        if (!wasOpenRef.current) return
        wasOpenRef.current = false
        followLatestRef.current = true
        chatContext?.onNestedScrollFollowChange?.(true)
    }, [isOpen, chatContext])

    const syncNestedFollow = useCallback(() => {
        const scroll = scrollRef.current
        if (!scroll) return
        const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 8
        const followLatest = atBottom && !pointerActiveRef.current
        followLatestRef.current = followLatest
        chatContext?.onNestedScrollFollowChange?.(followLatest)
    }, [chatContext])

    const handleScroll = (_event: UIEvent<HTMLDivElement>) => {
        syncNestedFollow()
    }

    const claimNestedScroll = () => {
        chatContext?.onNestedScrollFollowChange?.(false)
    }

    const scheduleNestedFollowSync = () => {
        if (followSyncFrameRef.current !== null) {
            window.cancelAnimationFrame(followSyncFrameRef.current)
        }
        followSyncFrameRef.current = window.requestAnimationFrame(() => {
            followSyncFrameRef.current = null
            syncNestedFollow()
        })
    }

    const claimNestedPointerScroll = () => {
        pointerActiveRef.current = true
        followLatestRef.current = false
        claimNestedScroll()
        pointerCleanupRef.current?.()

        const finish = () => {
            pointerCleanupRef.current?.()
            pointerActiveRef.current = false
            syncNestedFollow()
        }
        const cleanup = () => {
            window.removeEventListener('pointerup', finish)
            window.removeEventListener('pointercancel', finish)
            pointerCleanupRef.current = null
        }
        pointerCleanupRef.current = cleanup
        window.addEventListener('pointerup', finish, { once: true })
        window.addEventListener('pointercancel', finish, { once: true })
    }

    const claimNestedWheelScroll = () => {
        claimNestedScroll()
        scheduleNestedFollowSync()
    }

    const claimNestedKeyboardScroll = (event: KeyboardEvent<HTMLDivElement>) => {
        if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return
        claimNestedScroll()
        scheduleNestedFollowSync()
    }

    useEffect(() => () => {
        pointerCleanupRef.current?.()
        if (followSyncFrameRef.current !== null) {
            window.cancelAnimationFrame(followSyncFrameRef.current)
        }
    }, [])

    return (
        <div data-hapi-share-exclude="true" className="aui-reasoning-group my-1 overflow-hidden">
            <button
                type="button"
                onClick={handleToggle}
                className={cn(
                    'flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs',
                    'text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]',
                    'transition-colors cursor-pointer select-none'
                )}
            >
                <ChevronIcon open={isOpen} />
                <span className="shrink-0">Reasoning</span>
                {!isOpen && !reasoningCollapsed && preview ? (
                    <span className="min-w-0 truncate opacity-60">{preview}</span>
                ) : null}
                {isStreaming && (
                    <span className="ml-1 flex shrink-0 items-center gap-1 text-[var(--app-hint)]">
                        <ShimmerDot />
                    </span>
                )}
            </button>

            <div
                className={cn(
                    'overflow-hidden transition-all duration-200 ease-in-out',
                    isOpen ? 'max-h-[5000px] opacity-100' : 'max-h-0 opacity-0'
                )}
            >
                <div
                    ref={scrollRef}
                    data-hapi-nested-scroll="true"
                    tabIndex={isOpen ? 0 : -1}
                    onScroll={handleScroll}
                    onPointerDown={claimNestedPointerScroll}
                    onWheel={claimNestedWheelScroll}
                    onKeyDown={claimNestedKeyboardScroll}
                    // No overscroll containment: native scroll chaining must pass
                    // to the outer chat viewport once the panel reaches its
                    // bottom (see #1264). The follow-tail coordination above
                    // (onNestedScrollFollowChange) already pauses the outer
                    // auto-follow while the user scrolls inside this panel, so
                    // contain is not needed to stop the two from fighting.
                    className="aui-reasoning-scroll mb-1 ml-6 max-h-[60vh] overflow-y-auto text-[13px]"
                >
                    {children}
                </div>
            </div>
        </div>
    )
}
