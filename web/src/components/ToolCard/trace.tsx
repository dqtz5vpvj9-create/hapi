/**
 * TraceSection — shows child tool calls inside a Task/Agent tool dialog.
 * Placed between Input and Result sections.
 */
import { useNativeToolDetail, NativeDependencyStatus } from '@/components/ToolCard/nativeDependencies'
import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import { isObject, safeStringify } from '@hapi/protocol'
import type { ChatBlock, ToolCallBlock } from '@/chat/types'
import type { SessionMetadataSummary } from '@/types/api'
import { getToolFullViewComponent } from '@/components/ToolCard/views/_all'
import { getToolResultViewComponent } from '@/components/ToolCard/views/_results'
import { formatTaskChildLabel, TaskStateIcon } from '@/components/ToolCard/helpers'
import { CodeBlock } from '@/components/CodeBlock'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { formatDuration, getEventPresentation } from '@/chat/presentation'
import { useTranslation } from '@/lib/use-translation'
import { isSubagentToolName } from '@/chat/subagentTool'

// ---------------------------------------------------------------------------
// Result type narrowing (trace.tsx-internal; do NOT move to shared protocol)
// ---------------------------------------------------------------------------

type TaskToolResultSummary = {
    totalTokens?: number
    totalDurationMs?: number
    totalToolUseCount?: number
}

function readSummaryFields(result: unknown): {
    totalTokens: number | null
    totalDurationMs: number | null
    totalToolUseCount: number | null
} {
    if (!isObject(result)) {
        return { totalTokens: null, totalDurationMs: null, totalToolUseCount: null }
    }
    const r = result as Record<string, unknown>
    return {
        totalTokens: typeof r.totalTokens === 'number' ? r.totalTokens : null,
        totalDurationMs: typeof r.totalDurationMs === 'number' ? r.totalDurationMs : null,
        totalToolUseCount: typeof r.totalToolUseCount === 'number' ? r.totalToolUseCount : null,
    }
}

// Keep the type alias visible for documentation purposes
type _TaskToolResultSummary = TaskToolResultSummary

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Returns tool-call children of the given Task/Agent block, or null if none exist.
 */
export function getTaskTraceChildren(block: ToolCallBlock): ToolCallBlock[] | null {
    if (!isSubagentToolName(block.tool.name)) return null
    const children = block.children.filter(
        (c): c is ToolCallBlock => c.kind === 'tool-call',
    )
    return children.length === 0 ? null : children
}

function getTraceChildren(block: ToolCallBlock): ChatBlock[] | null {
    if (block.tool.name === 'CodexAgent') {
        return block.children.length === 0 ? null : block.children
    }
    return getTaskTraceChildren(block)
}

/**
 * Formats the summary line shown in the Trace header.
 * Falls back gracefully when token / duration data is unavailable.
 */
export function getTraceSummaryText(
    calls: number,
    totalTokens: number | null,
    totalDurationMs: number | null,
    callsSuffix: string,
): string {
    const parts: string[] = [`${calls} ${callsSuffix}`]

    if (totalTokens !== null) {
        const k = totalTokens / 1000
        parts.push(`${k.toFixed(1)}k tok`)
    }

    if (totalDurationMs !== null) {
        parts.push(formatDuration(totalDurationMs))
    }

    return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// TraceSection component
// ---------------------------------------------------------------------------

type TraceSectionProps = {
    block: ToolCallBlock
    metadata: SessionMetadataSummary | null
}

export function TraceSection({ block, metadata }: TraceSectionProps) {
    const { t } = useTranslation()
    const children = getTraceChildren(block)
    if (!children) return null

    const state = block.tool.state
    const isCodexAgentTrace = block.tool.name === 'CodexAgent'
    const defaultOpen = isCodexAgentTrace || state === 'running' || state === 'error' || state === 'pending'
    const fixedHeight = isCodexAgentTrace
    const mode = isCodexAgentTrace ? 'session' : 'trace'

    // Extract summary metadata from result using typed helper
    const { totalTokens, totalDurationMs, totalToolUseCount } = readSummaryFields(block.tool.result)
    const callCount = totalToolUseCount !== null ? totalToolUseCount : children.length

    const summaryText = getTraceSummaryText(callCount, totalTokens, totalDurationMs, t('tool.trace.callsSuffix'))

    return (
        <TraceSectionInner
            items={children}
            metadata={metadata}
            defaultOpen={defaultOpen}
            summaryText={summaryText}
            fixedHeight={fixedHeight}
            mode={mode}
        />
    )
}

// ---------------------------------------------------------------------------
// Inner component (holds open/close state)
// ---------------------------------------------------------------------------

type TraceSectionInnerProps = {
    items: ChatBlock[]
    metadata: SessionMetadataSummary | null
    defaultOpen: boolean
    summaryText: string
    fixedHeight: boolean
    mode: 'trace' | 'session'
}

function TraceSectionInner({
    items,
    metadata,
    defaultOpen,
    summaryText,
    fixedHeight,
    mode,
}: TraceSectionInnerProps) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(defaultOpen)

    return (
        <div className="flex flex-col gap-1">
            {/* Header row — clickable to toggle */}
            <button
                type="button"
                className="flex items-center gap-1 text-left text-xs font-medium text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
            >
                <span className="w-3 text-center select-none">{open ? '▾' : '▸'}</span>
                <span>{t('tool.trace')}</span>
                <span className="font-mono font-normal opacity-70">({summaryText})</span>
            </button>

            {open ? (
                <TraceChildList items={items} metadata={metadata} mode={mode} fixedHeight={fixedHeight} />
            ) : null}
        </div>
    )
}

// ---------------------------------------------------------------------------
// Child list
// ---------------------------------------------------------------------------

type TraceChildListProps = {
    items: ChatBlock[]
    metadata: SessionMetadataSummary | null
    mode: 'trace' | 'session'
    fixedHeight: boolean
}

const VIRTUAL_TRACE_THRESHOLD = 80

// Search the original data, including bodies that have never entered the DOM.
// Do not build a second retained text index alongside native detail ownership.
function matchesTraceItem(item: ChatBlock, query: string): boolean {
    const text = 'text' in item ? item.text
        : item.kind === 'tool-call' ? safeStringify({ tool: item.tool, children: item.children })
        : item.kind === 'agent-event' ? safeStringify(item.event) : safeStringify(item)
    return text.toLocaleLowerCase().includes(query)
}

function TraceChildList({ items, metadata, mode, fixedHeight }: TraceChildListProps) {
    const [expandedId, setExpandedId] = useState<string | null>(null)
    const onToggle = (id: string) => setExpandedId(prev => prev === id ? null : id)
    if (items.length > VIRTUAL_TRACE_THRESHOLD) {
        return <VirtualTraceList items={items} metadata={metadata} mode={mode}
            expandedId={expandedId} onToggle={onToggle} onReveal={setExpandedId} />
    }
    return (
        <div className={fixedHeight ? 'min-h-[260px] max-h-[45vh] overflow-y-auto pr-1' : undefined}>
            <div className={mode === 'session' ? 'flex flex-col gap-3' : 'flex flex-col gap-1 pl-4 border-l border-[var(--app-border)]'}>
                {items.map(child => <TraceChildRow key={child.id} child={child} metadata={metadata}
                    expanded={expandedId === child.id} onToggle={() => onToggle(child.id)} mode={mode} />)}
            </div>
        </div>
    )
}

function VirtualTraceList({ items, metadata, mode, expandedId, onToggle, onReveal }: {
    items: ChatBlock[]
    metadata: SessionMetadataSummary | null
    mode: 'trace' | 'session'
    expandedId: string | null
    onToggle: (id: string) => void
    onReveal: (id: string) => void
}) {
    const { t } = useTranslation()
    const viewportRef = useRef<HTMLDivElement>(null)
    const listRef = useRef<HTMLDivElement>(null)
    const [query, setQuery] = useState('')
    const [matchPosition, setMatchPosition] = useState(0)
    const matches = useMemo(() => {
        const needle = query.trim().toLocaleLowerCase()
        return needle ? items.flatMap((item, index) => matchesTraceItem(item, needle) ? [index] : []) : []
    }, [items, query])
    const expandedIndex = items.findIndex(item => item.id === expandedId)
    const getItemKey = useCallback((index: number) => items[index].id, [items])
    const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) =>
        [...new Set([...defaultRangeExtractor(range), ...(expandedIndex >= 0 ? [expandedIndex] : [])])].sort((a, b) => a - b), [expandedIndex])
    const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
        count: items.length,
        getScrollElement: () => viewportRef.current,
        getItemKey,
        estimateSize: () => mode === 'session' ? 44 : 28,
        gap: mode === 'session' ? 12 : 4,
        overscan: 5,
        useFlushSync: false,
        rangeExtractor,
        measureElement: (element, entry) => entry?.borderBoxSize?.[0]?.blockSize ?? Number.parseFloat(getComputedStyle(element).height),
    })
    const rows = virtualizer.getVirtualItems()
    useLayoutEffect(() => {
        // Retained rows can expand while scrolling. Publish the committed
        // fractional height even when the virtualizer skips a ref measurement.
        for (const element of listRef.current?.querySelectorAll<HTMLElement>(':scope > [data-trace-row-id]') ?? []) {
            virtualizer.resizeItem(Number(element.dataset.index), Number.parseFloat(getComputedStyle(element).height))
        }
    })
    const reveal = (position: number, indices = matches) => {
        if (!indices.length) return
        const next = (position + indices.length) % indices.length
        const index = indices[next]
        setMatchPosition(next)
        onReveal(items[index].id)
        virtualizer.scrollToIndex(index, { align: 'start' })
    }
    return (
        <div className="min-w-0 flex flex-col gap-2" data-trace-list="virtual">
            <div className="flex min-w-0 items-center gap-2 text-xs text-[var(--app-hint)]">
                <input type="search" aria-label={t('tool.trace.search')} placeholder={t('tool.trace.search')}
                    className="min-w-0 flex-1 rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-[var(--app-fg)]"
                    value={query} onChange={event => {
                        const value = event.target.value
                        setQuery(value)
                        setMatchPosition(0)
                        const needle = value.trim().toLocaleLowerCase()
                        if (needle) reveal(0, items.flatMap((item, index) => matchesTraceItem(item, needle) ? [index] : []))
                    }} onKeyDown={event => {
                        if (event.key === 'Enter') { event.preventDefault(); reveal(matchPosition + (event.shiftKey ? -1 : 1)) }
                    }} />
                {query.trim() ? <span role="status" className="shrink-0 tabular-nums">{matches.length ? Math.min(matchPosition + 1, matches.length) : 0}/{matches.length}</span> : null}
                <button type="button" aria-label={t('tool.trace.previous')} title={t('tool.trace.previous')} disabled={!matches.length} onClick={() => reveal(matchPosition - 1)}>↑</button>
                <button type="button" aria-label={t('tool.trace.next')} title={t('tool.trace.next')} disabled={!matches.length} onClick={() => reveal(matchPosition + 1)}>↓</button>
            </div>
            <div ref={viewportRef} data-trace-viewport="true" tabIndex={0}
                className="min-h-[260px] max-h-[45vh] overflow-y-auto pr-1" style={{ height: '45vh', position: 'relative' }}>
                <div ref={listRef} style={{ height: virtualizer.getTotalSize(), width: '100%' }}>
                    {rows.map((row, index) => {
                        const child = items[row.index]
                        const previous = rows[index - 1]
                        // Consecutive rows flow immediately with their real
                        // content height. Only unmounted intervals use cached
                        // geometry; pins keep the same keyed parent throughout.
                        const space = previous
                            ? previous.index + 1 === row.index ? (mode === 'session' ? 12 : 4) : row.start - previous.end
                            : row.start
                        return <Fragment key={row.key}>
                            <div aria-hidden="true" style={{ height: Math.max(0, space) }} />
                            <div ref={virtualizer.measureElement} data-index={row.index} data-trace-row-id={child.id}
                                style={{ display: 'flow-root', width: '100%' }}>
                                <TraceChildRow child={child} metadata={metadata} expanded={expandedId === child.id}
                                    onToggle={() => onToggle(child.id)} mode={mode} />
                            </div>
                        </Fragment>
                    })}
                </div>
            </div>
        </div>
    )
}

// ---------------------------------------------------------------------------
// Individual child row
// ---------------------------------------------------------------------------

type TraceChildRowProps = {
    child: ChatBlock
    metadata: SessionMetadataSummary | null
    expanded: boolean
    onToggle?: () => void
    mode: 'trace' | 'session'
}

function TraceChildRow({ child, metadata, expanded, onToggle, mode }: TraceChildRowProps) {
    const { t } = useTranslation()
    const isSessionMode = mode === 'session'
    const rowClassName = isSessionMode
        ? 'flex flex-col gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2'
        : 'flex flex-col gap-1'
    const detailClassName = isSessionMode
        ? 'rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm'
        : 'ml-8 rounded border border-[var(--app-border)] p-2 text-sm'
    const detailPlainClassName = isSessionMode ? '' : 'ml-8'
    const chevron = onToggle ? (
        <span className="w-3 text-center select-none">{expanded ? '▾' : '▸'}</span>
    ) : (
        <span className="w-3 text-center select-none text-[var(--app-hint)]">•</span>
    )

    if (child.kind === 'agent-text' || child.kind === 'agent-reasoning') {
        const label = child.kind === 'agent-reasoning' ? 'Reasoning' : 'Message'
        const preview = child.text.trim().split('\n')[0] ?? ''

        return (
            <div className={rowClassName}>
                <button
                    type="button"
                    className="flex items-center gap-2 text-left text-xs text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors disabled:pointer-events-none"
                    onClick={onToggle}
                    disabled={!onToggle}
                >
                    {chevron}
                    <span className="font-medium">{label}</span>
                    <span className="min-w-0 truncate">{preview}</span>
                </button>
                {expanded && (
                    <div className={detailClassName}>
                        <MarkdownRenderer content={child.text} />
                    </div>
                )}
            </div>
        )
    }

    if (child.kind === 'cli-output') {
        return (
            <div className={rowClassName}>
                <button
                    type="button"
                    className="flex items-center gap-2 text-left text-xs text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors disabled:pointer-events-none"
                    onClick={onToggle}
                    disabled={!onToggle}
                >
                    {chevron}
                    <span className="font-medium">Output</span>
                    <span className="min-w-0 truncate">{child.text.trim().split('\n')[0]}</span>
                </button>
                {expanded && (
                    <div className={detailPlainClassName}>
                        <CodeBlock code={child.text} language="text" />
                    </div>
                )}
            </div>
        )
    }

    if (child.kind === 'agent-event') {
        const presentation = getEventPresentation(child.event)
        return (
            <div className={isSessionMode
                ? 'flex items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2 text-xs text-[var(--app-hint)]'
                : 'flex items-center gap-2 text-xs text-[var(--app-hint)]'
            }>
                <span className="w-3 text-center select-none">•</span>
                {presentation.icon ? <span aria-hidden="true">{presentation.icon}</span> : null}
                <span>{presentation.text}</span>
            </div>
        )
    }

    if (child.kind !== 'tool-call') {
        return null
    }

    return <TraceToolRow child={child} metadata={metadata} expanded={expanded} onToggle={onToggle} mode={mode} />
}

function TraceToolRow({ child: original, metadata, expanded, onToggle, mode }: Omit<TraceChildRowProps, "child"> & { child: ToolCallBlock }) {
    const { t } = useTranslation()
    const detail = useNativeToolDetail(original, expanded)
    const child = detail.block
    const isSessionMode = mode === "session"
    const rowClassName = isSessionMode ? "flex flex-col gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2" : "flex flex-col gap-1"
    const chevron = <span className="w-3 text-center select-none">{expanded ? "▾" : "▸"}</span>
    const label = formatTaskChildLabel(child, metadata, t)
    const FullInputView = getToolFullViewComponent(child.tool.name)
    const ResultView = getToolResultViewComponent(child.tool.name)

    return (
        <div className={rowClassName}>
            <button
                type="button"
                className="flex items-center gap-2 text-left text-xs text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors disabled:pointer-events-none"
                onClick={onToggle}
                disabled={!onToggle}
            >
                {chevron}
                <span className="w-4 text-center shrink-0">
                    <TaskStateIcon state={child.tool.state} />
                </span>
                <span className={isSessionMode ? 'min-w-0 truncate font-mono' : 'font-mono break-all'}>{label}</span>
            </button>

            {expanded && (
                <div className={isSessionMode ? 'flex flex-col gap-2' : 'ml-8 flex flex-col gap-2 rounded border border-[var(--app-border)] p-2'}>
                    <NativeDependencyStatus {...detail} />
                    <TraceSection block={child} metadata={metadata} />
                    <div>
                        <div className="mb-1 text-xs font-medium text-[var(--app-hint)]">{t('tool.input')}</div>
                        {FullInputView ? (
                            <FullInputView block={child} metadata={metadata} />
                        ) : (
                            <CodeBlock code={safeStringify(child.tool.input)} language="json" />
                        )}
                    </div>
                    <div>
                        <div className="mb-1 text-xs font-medium text-[var(--app-hint)]">{t('tool.result')}</div>
                        <ResultView block={child} metadata={metadata} />
                    </div>
                </div>
            )}
        </div>
    )
}
